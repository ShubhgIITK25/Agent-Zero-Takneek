/**
 * End-to-end test of crash recovery on resume.
 *   npm run build:orchestrator && node tests/resume.js
 *
 * Hand-crafts a checkpoint that looks exactly like one left behind by a crash
 * mid-task, then spawns the orchestrator the way electron/main.ts does and
 * sends `resume_task`. Two behaviours are asserted:
 *
 *   1. Subtasks that were `running` / `verifying` when the process died are
 *      rolled back to `pending` (a `resume_rollback` intervention) so they
 *      re-run, instead of being silently stranded.
 *   2. A subtask left `pending` whose dependency is `failed` — with no
 *      `blocked` marker, as happens when the crash lands between the two
 *      writes — is detected as a dependency deadlock (`dependency_deadlock`
 *      intervention + `subtask_finished: skipped`), instead of vanishing from
 *      the task's accounting.
 *
 * The model roster is empty on purpose: the rolled-back subtasks then fail to
 * dispatch, which is fine — the point is that the recovery events fire first.
 */
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');

const script = path.join(__dirname, '..', 'orchestrator-dist', 'index.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-resume-'));
const codebaseId = 'test';
const taskId = 'resume1';

// ---- craft the "crashed mid-task" checkpoint -----------------------------
const st = (id, status, dependsOn = []) => ({
  id,
  title: `subtask ${id}`,
  detail: `do ${id}`,
  dependsOn,
  category: 'analysis',
  status,
  attempts: status === 'running' || status === 'verifying' ? 1 : 0,
  costSpent: 0,
  tokensSpent: 0,
});

const snapshot = {
  taskId,
  codebaseId,
  rootPath: os.tmpdir(),
  prompt: 'multi-step task',
  createdAt: Date.now() - 60000,
  updatedAt: Date.now() - 1000,
  step: 7,
  status: 'running',
  subtasks: [
    st('s1', 'done'),
    st('s2', 'running'), // crashed inside the implementer loop
    st('s3', 'verifying'), // crashed inside the verifier call
    st('s5', 'failed'), // a dependency that failed before the crash
    st('s4', 'pending', ['s5']), // stranded: depends on a failed subtask, never marked blocked
  ],
  conversations: {},
  costUsd: 0.02,
  elapsedSeconds: 40,
  pinnedFacts: ['Overall goal: multi-step task'],
  agentsMd: null,
};

const taskDir = path.join(dataDir, 'tasks', codebaseId, taskId);
fs.mkdirSync(taskDir, { recursive: true });
fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify(snapshot, null, 2));

// ---- drive the protocol -------------------------------------------------
const child = spawn(process.execPath, [script, '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
const rl = readline.createInterface({ input: child.stdout });
const events = [];
let finished = false;

const finish = (ok, why) => {
  if (finished) return;
  finished = true;
  console.log(ok ? `\n  PASS: ${why}` : `\n  FAIL: ${why}`);
  child.kill();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
  process.exit(ok ? 0 : 1);
};

const config = {
  rootPath: os.tmpdir(),
  codebaseId,
  retrievalUrl: null,
  env: {},
  enabledModelIds: [],
  maxCostUsd: 0.5,
  maxSeconds: 2700,
};

rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return finish(false, `non-JSON frame on stdout: ${line.slice(0, 120)}`);
  }
  if (m.kind === 'event') {
    events.push(m);
    const tag = m.type === 'intervention' ? `intervention:${m.cause}` : m.type === 'subtask_finished' ? `finished:${m.subtaskId}=${m.status}` : m.type;
    console.log('  <-', tag);
  }

  if (m.kind === 'event' && m.type === 'ready') {
    child.stdin.write(JSON.stringify({ kind: 'command', type: 'resume_task', id: 'r1', taskId, config }) + '\n');
  }

  if (m.kind === 'event' && m.type === 'task_finished') checkAssertions();
  if (m.kind === 'event' && m.type === 'task_failed') checkAssertions();
});

function checkAssertions() {
  setTimeout(() => {
    const interventions = events.filter((e) => e.type === 'intervention');
    const causes = interventions.map((e) => e.cause);
    const finishes = events.filter((e) => e.type === 'subtask_finished');

    const rolledBackS2 = interventions.some((e) => e.cause === 'resume_rollback' && e.subtaskId === 's2');
    const rolledBackS3 = interventions.some((e) => e.cause === 'resume_rollback' && e.subtaskId === 's3');
    const deadlockS4 = interventions.some((e) => e.cause === 'dependency_deadlock' && e.subtaskId === 's4');
    const s4Skipped = finishes.some((e) => e.subtaskId === 's4' && e.status === 'skipped');
    const resumedNote = events.find((e) => e.type === 'resumed');

    console.log('\n  causes seen:', causes.join(', ') || '(none)');
    console.log('  resumed note:', resumedNote ? JSON.stringify(resumedNote.note) : '(no resumed event)');

    const ok = rolledBackS2 && rolledBackS3 && deadlockS4 && s4Skipped;
    finish(
      ok,
      ok
        ? 'running/verifying subtasks rolled back to pending; dependency deadlock detected and skipped'
        : `missing recovery behaviour — rollback s2:${rolledBackS2} s3:${rolledBackS3}, deadlock s4:${deadlockS4}, s4 skipped:${s4Skipped}`
    );
  }, 1500);
}

child.stderr.on('data', (d) => console.log('  [stderr]', d.toString().trim()));
setTimeout(() => finish(false, 'timed out waiting for the orchestrator'), 20000);
