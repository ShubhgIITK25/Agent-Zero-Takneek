/**
 * End-to-end tests for BOUNDED mid-task re-planning
 * (TaskRunner.tryReplan, orchestrator/orchestrator.ts).
 *
 *   npm run build:orchestrator && node tests/replan.js
 *
 * Runs a REAL TaskRunner with only providers.callModel mocked, so the DAG
 * rewiring, the scheduler, and the completion predicate are all the real ones.
 *
 * Three scenarios, because "it re-plans" is the easy half - the bounds are the
 * part that stops a struggling task from rewriting its own plan forever:
 *
 *   A. RECOVERY   a subtask fails every retry, the re-planner decomposes it,
 *                 the replacements pass, and the TASK STILL REPORTS DONE.
 *                 That last clause is the one that breaks if `replaced` is
 *                 treated as just another non-`done` status.
 *   B. NO NESTING a replacement that also fails is failed outright - depth is
 *                 capped, so re-plans never recurse.
 *   C. ABANDON    a re-planner that judges the work impossible leaves the
 *                 original failure standing instead of burning budget on a
 *                 reworded retry.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = path.join(__dirname, '..', 'orchestrator-dist');
const providers = require(path.join(D, 'providers'));
const { TaskRunner } = require(path.join(D, 'orchestrator'));
const { TaskStore } = require(path.join(D, 'store'));

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log('  ok  ', name);
    pass++;
  } catch (e) {
    console.log('  FAIL', name, '\n       ', e.message);
    fail++;
  }
};

/**
 * @param opts.failTitles      subtask titles whose verification always fails
 * @param opts.replanReply     what the re-planner returns
 * @param opts.onReplanCall    called each time the re-planner is invoked
 * @param opts.plan            override the initial plan's subtask list
 */
function installMock(opts) {
  providers.callModel = async (_model, messages) => {
    const sys = (messages.find((m) => m.role === 'system') || {}).content || '';
    const user = (messages.find((m) => m.role === 'user') || {}).content || '';
    const base = { toolCalls: [], promptTokens: 10, completionTokens: 10, costUsd: 0, latencyMs: 1 };

    // The re-planner and the planner share role 'planner', so they are told
    // apart by their system prompt, exactly as the other roles are.
    if (sys.startsWith('You are the re-planner')) {
      opts.onReplanCall?.(user);
      return { ...base, text: JSON.stringify(opts.replanReply) };
    }
    if (sys.startsWith('You are the planner')) {
      return {
        ...base,
        text: JSON.stringify({
          trivial: false,
          restated_goal: 'two-step job',
          subtasks: opts.plan ?? [
            { id: 's1', title: 'Easy step', detail: 'do the easy thing', category: 'codegen', dependsOn: [] },
            { id: 's2', title: 'Hard step', detail: 'do the hard thing', category: 'codegen', dependsOn: ['s1'] },
          ],
        }),
      };
    }
    if (sys.includes('You are an implementer agent')) {
      return { ...base, text: 'DONE: did the thing' };
    }
    if (sys.includes('You are an independent verifier')) {
      const failing = opts.failTitles.some((title) => user.includes(title));
      return {
        ...base,
        text: JSON.stringify(
          failing
            ? { verdict: 'fail', confidence: 0.95, reason: 'this step is too broad to do in one go', evidence: 'checked' }
            : { verdict: 'pass', confidence: 0.9, reason: 'looks correct', evidence: 'checked' }
        ),
      };
    }
    return { ...base, text: JSON.stringify({ summary: 'Summary text.' }) };
  };
}

async function runTask(label, opts) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-replan-data-'));
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-replan-proj-'));
  const store = new TaskStore(dataDir, 'cb-replan', label);
  const events = [];

  installMock(opts);

  const runner = new TaskRunner(
    label,
    'do a two-step job',
    {
      rootPath,
      codebaseId: 'cb-replan',
      retrievalUrl: null,
      env: {},
      enabledModelIds: ['groq:llama-3.1-8b'],
      maxCostUsd: 0.5,
      maxSeconds: 2700,
    },
    store,
    (body) => events.push(body),
    () => {},
    null
  );

  await runner.run(false);
  const snap = store.loadSnapshot();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(rootPath, { recursive: true, force: true });
  return { events, snap };
}

async function main() {
  // ---------------------------------------------------------------- A ------
  console.log('\n== re-plan A: a failed subtask is decomposed, and the task still completes ==');
  let replanPrompts = [];
  const A = await runTask('replan-recovery', {
    failTitles: ['Hard step'],
    onReplanCall: (user) => replanPrompts.push(user),
    replanReply: {
      abandon: false,
      diagnosis: 'the hard step bundled two unrelated changes',
      // Titles deliberately share no substring with 'Hard step': the mock
      // verifier matches on title, so a replacement named "Hard step part one"
      // would fail for the wrong reason and hide whether recovery works.
      subtasks: [
        { title: 'First half', detail: 'first half', category: 'codegen' },
        { title: 'Second half', detail: 'second half', category: 'codegen' },
      ],
    },
  });

  const aStatus = (id) => A.snap.subtasks.find((s) => s.id === id)?.status;
  console.log('  plan after re-plan:', A.snap.subtasks.map((s) => `${s.id}=${s.status}`).join(', '));

  t('the failed subtask is marked "replaced", not "failed"', () => {
    assert.strictEqual(aStatus('s2'), 'replaced');
  });
  t('replacements were inserted with derived ids', () => {
    assert.strictEqual(aStatus('s2r1'), 'done');
    assert.strictEqual(aStatus('s2r2'), 'done');
  });
  t('replacements are inserted after the subtask they replace, not appended', () => {
    const ids = A.snap.subtasks.map((s) => s.id);
    assert.deepStrictEqual(ids, ['s1', 's2', 's2r1', 's2r2'], ids.join(','));
  });
  t('replacements chain sequentially, first inheriting the original prerequisites', () => {
    assert.deepStrictEqual(A.snap.subtasks.find((s) => s.id === 's2r1').dependsOn, ['s1']);
    assert.deepStrictEqual(A.snap.subtasks.find((s) => s.id === 's2r2').dependsOn, ['s2r1']);
  });
  t('the TASK reports done - a replaced subtask must not count as incomplete', () => {
    assert.strictEqual(A.snap.status, 'done', `task ended ${A.snap.status}`);
    assert.ok(
      A.events.some((e) => e.type === 'task_finished'),
      'expected task_finished; got ' + A.events.filter((e) => e.type.startsWith('task_')).map((e) => e.type).join(',')
    );
  });
  t('a replan event is emitted with the diagnosis and remaining budget', () => {
    const r = A.events.find((e) => e.type === 'replan');
    assert.ok(r, 'no replan event');
    assert.match(r.diagnosis, /bundled two unrelated changes/);
    assert.strictEqual(r.replansRemaining, 1);
  });
  t('the re-plan is surfaced as an intervention, never silently', () => {
    assert.ok(A.events.some((e) => e.type === 'intervention' && e.cause === 'replan'));
  });
  t('the re-planner is told the workspace was already rolled back', () => {
    assert.ok(replanPrompts.length > 0, 'the re-planner was never called');
    assert.match(replanPrompts[0], /rolled back/i);
  });
  t('the re-planner is told which subtasks already succeeded, so it cannot redo them', () => {
    assert.match(replanPrompts[0], /Easy step/);
  });

  // ---------------------------------------------------------------- B ------
  console.log('\n== re-plan B: re-plans do not nest - a failing replacement is failed, not re-planned ==');
  let replanCalls = 0;
  const B = await runTask('replan-depth', {
    // Every replacement also fails, so a depth bound is the only thing that
    // stops this recursing until the budget runs out.
    failTitles: ['Hard step'],
    onReplanCall: () => replanCalls++,
    replanReply: {
      abandon: false,
      diagnosis: 'splitting it up',
      subtasks: [{ title: 'Hard step retried', detail: 'still the hard thing', category: 'codegen' }],
    },
  });

  console.log('  re-planner calls:', replanCalls);
  console.log('  final plan:', B.snap.subtasks.map((s) => `${s.id}=${s.status}`).join(', '));

  t('the replacement is depth 1', () => {
    assert.strictEqual(B.snap.subtasks.find((s) => s.id === 's2r1').replanDepth, 1);
  });
  t('a depth-1 replacement that fails is NOT re-planned again', () => {
    assert.strictEqual(replanCalls, 1, `re-planner ran ${replanCalls}x - depth bound did not hold`);
  });
  t('a "replan_declined" intervention explains which bound stopped it', () => {
    const d = B.events.find((e) => e.type === 'intervention' && e.cause === 'replan_declined');
    assert.ok(d, 'no replan_declined intervention');
    assert.match(d.detail, /re-plan/i);
  });
  t('the task fails, because the replacement genuinely never succeeded', () => {
    assert.strictEqual(B.snap.status, 'failed');
  });

  // ---------------------------------------------------------------- C ------
  console.log('\n== re-plan C: the re-planner may decline, and the failure then stands ==');
  const C = await runTask('replan-abandon', {
    failTitles: ['Hard step'],
    replanReply: {
      abandon: true,
      diagnosis: 'the file it needs does not exist in this repo',
      reason: 'no decomposition can create a dependency that is not installable',
    },
  });

  t('an abandoned re-plan leaves the subtask failed', () => {
    assert.strictEqual(C.snap.subtasks.find((s) => s.id === 's2').status, 'failed');
  });
  t('no replacements were added', () => {
    assert.strictEqual(C.snap.subtasks.length, 2, C.snap.subtasks.map((s) => s.id).join(','));
  });
  t('the decline records the diagnosis, so "why we gave up" is inspectable', () => {
    const d = C.events.find((e) => e.type === 'intervention' && e.cause === 'replan_declined');
    assert.ok(d, 'no replan_declined intervention');
    assert.match(d.detail, /does not exist in this repo/);
  });
  t('the task reports failed with the subtask named', () => {
    assert.strictEqual(C.snap.status, 'failed');
    const f = C.events.find((e) => e.type === 'task_failed');
    assert.ok(f && /Hard step/.test(f.reason), f?.reason);
  });

  // ---------------------------------------------------------------- D ------
  // The scenarios above all replaced the LAST subtask, so nothing depended on
  // it. This is the case that actually exercises the rewire: if a dependent is
  // left pointing at the replaced id, that id can never be `done`, the
  // deadlock detector skips the dependent, and a successful re-plan still
  // reports a failed task.
  console.log('\n== re-plan D: subtasks depending on the replaced one are rewired to the replacements ==');
  const Dv = await runTask('replan-rewire', {
    failTitles: ['Middle step'],
    plan: [
      { id: 's1', title: 'Easy step', detail: 'do the easy thing', category: 'codegen', dependsOn: [] },
      { id: 's2', title: 'Middle step', detail: 'the one that fails', category: 'codegen', dependsOn: ['s1'] },
      { id: 's3', title: 'Last step', detail: 'depends on the middle', category: 'codegen', dependsOn: ['s2'] },
    ],
    replanReply: {
      abandon: false,
      diagnosis: 'the middle step was two changes at once',
      subtasks: [
        { title: 'First half', detail: 'first half', category: 'codegen' },
        { title: 'Second half', detail: 'second half', category: 'codegen' },
      ],
    },
  });

  console.log('  final plan:', Dv.snap.subtasks.map((s) => `${s.id}=${s.status}`).join(', '));
  const dep = Dv.snap.subtasks.find((s) => s.id === 's3');

  t('the dependent now depends on the LAST replacement, not the replaced id', () => {
    assert.deepStrictEqual(dep.dependsOn, ['s2r2'], dep.dependsOn.join(','));
  });
  t('the dependent actually ran instead of deadlocking', () => {
    assert.strictEqual(dep.status, 'done', `s3 ended ${dep.status}`);
  });
  t('the whole task completes across the re-plan', () => {
    assert.strictEqual(Dv.snap.status, 'done');
  });
  t('no dependency_deadlock was raised', () => {
    assert.ok(!Dv.events.some((e) => e.type === 'intervention' && e.cause === 'dependency_deadlock'));
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
