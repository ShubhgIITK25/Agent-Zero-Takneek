/**
 * Scheduling efficiency: WHICH ready subtask goes first, and which two are
 * allowed to go at once.
 *   npm run build:orchestrator && node tests/scheduling.js
 *
 * Same technique as tests/parallel.js - a real TaskRunner with only
 * providers.callModel mocked - because both properties here are about real
 * timing and cannot be observed from a pure function.
 *
 * Two things are pinned:
 *   - dispatch order follows the critical path, not array order. Total time is
 *     set by the longest dependency chain, so the subtask holding up the most
 *     work has to start first when slots are scarce.
 *   - two subtasks that declared the same file never overlap. The
 *     stale-proposal guard already makes a concurrent write safe; the cost is
 *     that the loser must re-read and re-propose, which is a wasted
 *     round-trip. Not overlapping them is free, because the deferred subtask
 *     takes the very next slot.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = path.join(__dirname, '..', 'orchestrator-dist');
const providers = require(path.join(D, 'providers'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let planSubtasks = [];
let implementerDelay = 60;
/** Subtask TITLE whose verification always fails, or null. Titles are what the
 *  implementer and verifier prompts actually carry - ids never appear in them. */
let failVerificationFor = null;
/** Map of subtask title -> file it proposes to write. */
let proposeEditsFor = new Map();
/** Map of subtask title -> extra ms before it reports DONE. */
let slowTitles = new Map();

providers.callModel = async (_model, messages) => {
  const sys = (messages.find((m) => m.role === 'system') || {}).content || '';
  const base = { toolCalls: [], promptTokens: 10, completionTokens: 10, costUsd: 0, latencyMs: 1 };

  if (sys.startsWith('You are the planner')) {
    return {
      ...base,
      text: JSON.stringify({ trivial: false, restated_goal: 'scheduling fixture', subtasks: planSubtasks }),
    };
  }
  if (sys.includes('You are an implementer agent')) {
    await sleep(implementerDelay);
    const title = (/YOUR SUBTASK: (.+)/.exec(sys) || [])[1]?.trim();
    const file = title ? proposeEditsFor.get(title) : undefined;
    // The follow-up turn (after the edit landed) is where the per-title delay
    // applies, so one subtask can still be in flight while the other has
    // already failed and rolled back.
    if (messages.some((m) => m.role === 'tool')) await sleep(slowTitles.get(title) ?? 0);
    if (file && !messages.some((m) => m.role === 'tool')) {
      return {
        ...base,
        toolCalls: [{
          id: `call_${file}`,
          name: 'propose_edit',
          arguments: { path: file, content: `from ${title}\n`, summary: `write ${file}` },
        }],
        text: '',
      };
    }
    return { ...base, text: 'DONE: finished this subtask' };
  }
  if (sys.includes('You are an independent verifier')) {
    const user = (messages.find((m) => m.role === 'user') || {}).content || '';
    const failing = failVerificationFor && user.includes(failVerificationFor);
    return {
      ...base,
      text: JSON.stringify(
        failing
          ? { verdict: 'fail', confidence: 0.95, reason: 'rejected by fixture', evidence: 'n/a' }
          : { verdict: 'pass', confidence: 0.95, reason: 'fine', evidence: 'ok' }
      ),
    };
  }
  return { ...base, text: 'Summary text.' };
};

const { TaskRunner } = require(path.join(D, 'orchestrator'));
const { TaskStore } = require(path.join(D, 'store'));

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ok  ', name); pass++; }
  catch (e) { console.log('  FAIL', name, '\n       ', e.message); fail++; }
};

async function run({ subtasks, maxParallelSubtasks }) {
  planSubtasks = subtasks;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-sched-'));
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-schedproj-'));
  const id = `sched-${Math.random().toString(36).slice(2)}`;
  const store = new TaskStore(dataDir, 'cb-sched', id);

  const events = [];
  const runner = new TaskRunner(
    id, 'scheduling fixture',
    { rootPath, codebaseId: 'cb-sched', retrievalUrl: null, env: {},
      enabledModelIds: ['groq:llama-3.1-8b'], maxCostUsd: 0.5, maxSeconds: 2700, maxParallelSubtasks },
    store,
    (body) => {
      events.push({ ...body, at: Date.now() });
      if (body.type === 'approval_request') {
        const req = body.request;
        setImmediate(() =>
          runner.resolveApproval({
            requestId: req.requestId,
            approved: true,
            acceptedBlockIds: (req.diff ?? []).flatMap((d) => d.blocks.map((b) => b.id)),
          })
        );
      }
    },
    () => {}, null
  );
  await runner.run(false);
  return { events, snapshot: store.loadSnapshot(), rootPath };
}

const startOrder = (events) =>
  events.filter((e) => e.type === 'subtask_started').map((e) => e.subtaskId);

/** Pairs of subtasks whose [started, finished] windows overlap in time. */
function overlappingPairs(events) {
  const span = new Map();
  for (const e of events) {
    if (e.type === 'subtask_started') span.set(e.subtaskId, { start: e.at, end: Infinity });
    if (e.type === 'subtask_finished' && span.has(e.subtaskId)) span.get(e.subtaskId).end = e.at;
  }
  const ids = [...span.keys()];
  const out = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = span.get(ids[i]), b = span.get(ids[j]);
      if (a.start < b.end && b.start < a.end) out.push([ids[i], ids[j]].sort().join('+'));
    }
  return out;
}

async function main() {
  // ------------------------------------------------------------------ 1 ---
  console.log('\n== dispatch order follows the critical path, not array order ==');
  // s1 and s2 are leaves. s3 is a leaf in the array but three subtasks hang
  // off it, so it is the critical path and must start in the first batch.
  // With a limit of 2 and array order, s3 would wait behind s1 and s2.
  const cp = await run({
    maxParallelSubtasks: 2,
    subtasks: [
      { id: 's1', title: 'Leaf one',  detail: 'x', category: 'codegen', dependsOn: [] },
      { id: 's2', title: 'Leaf two',  detail: 'x', category: 'codegen', dependsOn: [] },
      { id: 's3', title: 'Root of the chain', detail: 'x', category: 'codegen', dependsOn: [] },
      { id: 's4', title: 'Chain A', detail: 'x', category: 'codegen', dependsOn: ['s3'] },
      { id: 's5', title: 'Chain B', detail: 'x', category: 'codegen', dependsOn: ['s4'] },
      { id: 's6', title: 'Chain C', detail: 'x', category: 'codegen', dependsOn: ['s5'] },
    ],
  });

  t('the deepest chain root starts in the first batch', () => {
    const first2 = startOrder(cp.events).slice(0, 2);
    assert.ok(first2.includes('s3'), `first batch was ${JSON.stringify(first2)}, expected it to include s3`);
  });

  t('it starts FIRST - it has the most work behind it', () => {
    assert.strictEqual(startOrder(cp.events)[0], 's3');
  });

  t('the task still completes', () => {
    assert.strictEqual(cp.snapshot.status, 'done');
  });

  t('ordering never violates the dependency graph', () => {
    const order = startOrder(cp.events);
    for (const [a, b] of [['s3', 's4'], ['s4', 's5'], ['s5', 's6']])
      assert.ok(order.indexOf(a) < order.indexOf(b), `${b} started before ${a}`);
  });

  // ------------------------------------------------------------------ 2 ---
  console.log('\n== subtasks declaring the same file never overlap ==');
  const conflict = await run({
    maxParallelSubtasks: 3,
    subtasks: [
      { id: 's1', title: 'Edit shared', detail: 'x', category: 'codegen', dependsOn: [], touchesFiles: ['src/app.ts'] },
      { id: 's2', title: 'Also shared', detail: 'x', category: 'codegen', dependsOn: [], touchesFiles: ['src/app.ts'] },
      { id: 's3', title: 'Elsewhere',   detail: 'x', category: 'codegen', dependsOn: [], touchesFiles: ['docs/readme.md'] },
    ],
  });

  t('the two subtasks sharing src/app.ts do not run at the same time', () => {
    const pairs = overlappingPairs(conflict.events);
    assert.ok(!pairs.includes('s1+s2'), `s1 and s2 overlapped despite both declaring src/app.ts`);
  });

  t('the non-conflicting subtask still runs in parallel', () => {
    const pairs = overlappingPairs(conflict.events);
    assert.ok(pairs.length > 0, 'nothing overlapped at all - the file rule serialised everything');
  });

  t('all three still complete', () => {
    assert.strictEqual(conflict.snapshot.status, 'done');
    assert.strictEqual(conflict.snapshot.subtasks.filter((s) => s.status === 'done').length, 3);
  });

  // ------------------------------------------------------------------ 3 ---
  console.log('\n== the file rule can never deadlock the scheduler ==');
  // Every subtask declares the same file, so no two may ever overlap. This
  // must serialise, not hang: with nothing running there is nothing to
  // conflict with, so a deferred subtask always becomes dispatchable.
  const allSame = await run({
    maxParallelSubtasks: 3,
    subtasks: ['s1', 's2', 's3'].map((id) => ({
      id, title: `Edit ${id}`, detail: 'x', category: 'codegen', dependsOn: [], touchesFiles: ['only.ts'],
    })),
  });

  t('a plan where everything conflicts still completes', () => {
    assert.strictEqual(allSame.snapshot.status, 'done');
  });

  t('and it did so strictly one at a time', () => {
    assert.deepStrictEqual(overlappingPairs(allSame.events), []);
  });

  // ------------------------------------------------------------------ 4 ---
  console.log('\n== no declared files means the old behaviour, unchanged ==');
  const undeclared = await run({
    maxParallelSubtasks: 3,
    subtasks: ['s1', 's2', 's3'].map((id) => ({
      id, title: `Task ${id}`, detail: 'x', category: 'codegen', dependsOn: [],
    })),
  });

  t('three subtasks with no touchesFiles still run together', () => {
    assert.ok(overlappingPairs(undeclared.events).length >= 2,
      'plans that declare nothing must parallelise exactly as before');
  });

  // ------------------------------------------------------------------ 5 ---
  console.log('\n== one subtask rolling back must not disarm its parallel siblings ==');
  // s1 fails verification (so it rolls back) while s2 is still running. The
  // rollback must clear only s1's backtrack point: if it wipes the whole map,
  // s2 silently stops recording pre-edit state and can never roll back itself.
  // BOTH must fail, or the test cannot distinguish "s2 was disarmed" from
  // "s2 simply had nothing to roll back". Both titles start with "Fails".
  failVerificationFor = 'Fails';
  proposeEditsFor = new Map([['Fails A', 'a.txt'], ['Fails B', 'b.txt']]);
  // Both write early; B then dawdles, so A has already failed and rolled back
  // while B is still running with an un-rolled-back edit on disk. That
  // ordering is the whole point: a rollback that clears the entire map
  // destroys B's pre-edit state at exactly this moment.
  slowTitles = new Map([['Fails B', 220]]);
  implementerDelay = 5;
  const siblings = await run({
    maxParallelSubtasks: 2,
    subtasks: [
      { id: 's1', title: 'Fails A', detail: 'x', category: 'codegen', dependsOn: [], touchesFiles: ['a.txt'] },
      { id: 's2', title: 'Fails B', detail: 'x', category: 'codegen', dependsOn: [], touchesFiles: ['b.txt'] },
    ],
  });
  failVerificationFor = null;
  proposeEditsFor = new Map();
  slowTitles = new Map();
  implementerDelay = 60;

  t('both subtasks rolled back their own edits', () => {
    const reverted = siblings.events.filter(
      (e) => e.type === 'intervention' && e.cause === 'workspace_restored'
    );
    const subjects = new Set(reverted.map((e) => e.subtaskId));
    assert.ok(subjects.has('s1'), 's1 never rolled back');
    assert.ok(subjects.has('s2'), 's2 never rolled back - its backtrack point was wiped by s1');
  });

  t('neither subtask left its rejected file behind', () => {
    for (const f of ['a.txt', 'b.txt'])
      assert.ok(!fs.existsSync(path.join(siblings.rootPath, f)), `${f} survived a failed subtask`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
