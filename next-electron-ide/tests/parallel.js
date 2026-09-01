/**
 * Parallel subtask execution - that it happens, and that it is still safe.
 *   npm run build:orchestrator && node tests/parallel.js
 *
 * Runs a REAL TaskRunner end to end with only the network boundary
 * (providers.callModel) mocked, the same technique as tests/task-completion.js.
 * The implementer mock holds an artificial delay and records how many subtasks
 * are inside it at once, so "did these actually overlap" is measured rather
 * than assumed - a scheduler that merely *looks* concurrent but awaits each
 * subtask in turn would pass a timing-free test and fail this one.
 *
 * The three things that could go wrong are each pinned:
 *   - it does not actually parallelise                 -> peak concurrency test
 *   - it parallelises past the dependency graph        -> ordering test
 *   - two approvals are outstanding at once, which
 *     hangs the renderer's single pending-diff slot    -> approval gate test
 * Plus the escape hatch: maxParallelSubtasks: 1 must reproduce the old
 * strictly-sequential behaviour exactly, because that is what gets set if
 * parallelism misbehaves in front of a judge.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = path.join(__dirname, '..', 'orchestrator-dist');
const providers = require(path.join(D, 'providers'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Live and peak count of implementer calls in flight. */
const gauge = { live: 0, peak: 0 };
/** Set by each scenario before running. */
let planSubtasks = [];
/** When true, every implementer proposes an edit so approvals are exercised. */
let proposeEdits = false;

providers.callModel = async (_model, messages) => {
  const sys = (messages.find((m) => m.role === 'system') || {}).content || '';
  const base = { toolCalls: [], promptTokens: 10, completionTokens: 10, costUsd: 0, latencyMs: 1 };

  if (sys.startsWith('You are the planner')) {
    return {
      ...base,
      text: JSON.stringify({
        trivial: false,
        restated_goal: 'parallel scheduling fixture',
        subtasks: planSubtasks,
      }),
    };
  }

  if (sys.includes('You are an implementer agent')) {
    gauge.live += 1;
    gauge.peak = Math.max(gauge.peak, gauge.live);
    try {
      // Long enough that a sequential scheduler cannot fake overlap.
      await sleep(60);
      if (proposeEdits) {
        const user = (messages.find((m) => m.role === 'user') || {}).content || '';
        const already = messages.some((m) => m.role === 'tool');
        if (!already) {
          const which = /Task (\w+)/.exec(user);
          const name = which ? which[1] : 'X';
          return {
            ...base,
            toolCalls: [
              {
                id: `call_${name}`,
                name: 'propose_edit',
                arguments: {
                  path: `${name}.txt`,
                  content: `content for ${name}\n`,
                  summary: `create ${name}.txt`,
                },
              },
            ],
            text: '',
          };
        }
      }
      return { ...base, text: 'DONE: finished this subtask' };
    } finally {
      gauge.live -= 1;
    }
  }

  if (sys.includes('You are an independent verifier')) {
    return {
      ...base,
      text: JSON.stringify({ verdict: 'pass', confidence: 0.95, reason: 'fine', evidence: 'checked' }),
    };
  }
  return { ...base, text: 'Summary text.' };
};

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

/** Run one task to completion and hand back everything worth asserting on. */
async function runScenario({ subtasks, maxParallelSubtasks, edits = false }) {
  planSubtasks = subtasks;
  proposeEdits = edits;
  gauge.live = 0;
  gauge.peak = 0;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-par-'));
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-parproj-'));
  const id = `par-${Math.random().toString(36).slice(2)}`;
  const store = new TaskStore(dataDir, 'cb-par', id);

  const events = [];
  const runner = new TaskRunner(
    id,
    'parallel fixture',
    {
      rootPath,
      codebaseId: 'cb-par',
      retrievalUrl: null,
      env: {},
      enabledModelIds: ['groq:llama-3.1-8b'],
      maxCostUsd: 0.5,
      maxSeconds: 2700,
      maxParallelSubtasks,
    },
    store,
    (body) => {
      events.push(body);
      // Auto-approve every proposal the moment it is raised. Answering
      // synchronously is the harshest possible timing for the gate: if it did
      // not serialise, the overlap would show up immediately.
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
    () => {},
    null
  );

  await runner.run(false);
  return { events, snapshot: store.loadSnapshot(), peak: gauge.peak, rootPath };
}

const independent = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    title: `Task ${String.fromCharCode(65 + i)}`,
    detail: `do ${i + 1}`,
    category: 'codegen',
    dependsOn: [],
  }));

async function main() {
  // ---------------------------------------------------------------- 1 ----
  console.log('\n== parallel: independent subtasks actually overlap ==');
  const par = await runScenario({ subtasks: independent(3), maxParallelSubtasks: 3 });

  t('three independent subtasks run at the same time', () => {
    assert.strictEqual(par.peak, 3, `peak in-flight implementers was ${par.peak}, expected 3`);
  });

  t('all of them still complete', () => {
    const bad = par.snapshot.subtasks.filter((s) => s.status !== 'done');
    assert.strictEqual(bad.length, 0, `not done: ${bad.map((s) => `${s.id}=${s.status}`).join(', ')}`);
  });

  t('the task reports success', () => {
    assert.strictEqual(par.snapshot.status, 'done');
    assert.strictEqual(par.events.filter((e) => e.type === 'task_finished').length, 1);
  });

  t('a concurrency event reports more than one subtask running', () => {
    const peakReported = Math.max(
      0,
      ...par.events.filter((e) => e.type === 'concurrency').map((e) => e.running.length)
    );
    assert.strictEqual(peakReported, 3, `dashboard was told peak ${peakReported}`);
  });

  t('concurrency events fire on change, not on every tick', () => {
    const conc = par.events.filter((e) => e.type === 'concurrency');
    const keys = conc.map((e) => e.running.map((r) => r.subtaskId).sort().join('|'));
    for (let i = 1; i < keys.length; i++) {
      assert.notStrictEqual(keys[i], keys[i - 1], 'consecutive duplicate concurrency events');
    }
  });

  t('every running entry carries a human-readable title for the dashboard', () => {
    for (const e of par.events.filter((x) => x.type === 'concurrency')) {
      for (const r of e.running) {
        assert.ok(r.title && r.title !== r.subtaskId, `no title for ${r.subtaskId}`);
      }
    }
  });

  // ---------------------------------------------------------------- 2 ----
  console.log('\n== parallel: maxParallelSubtasks 1 is the sequential escape hatch ==');
  const seq = await runScenario({ subtasks: independent(3), maxParallelSubtasks: 1 });

  t('never more than one implementer in flight', () => {
    assert.strictEqual(seq.peak, 1, `peak was ${seq.peak}, expected strictly sequential`);
  });

  t('the same work still completes', () => {
    assert.strictEqual(seq.snapshot.status, 'done');
    assert.strictEqual(seq.snapshot.subtasks.filter((s) => s.status === 'done').length, 3);
  });

  // ---------------------------------------------------------------- 3 ----
  console.log('\n== parallel: the dependency graph is still obeyed ==');
  const chained = await runScenario({
    subtasks: [
      { id: 's1', title: 'Task A', detail: 'first', category: 'codegen', dependsOn: [] },
      { id: 's2', title: 'Task B', detail: 'second', category: 'codegen', dependsOn: ['s1'] },
      { id: 's3', title: 'Task C', detail: 'also first', category: 'codegen', dependsOn: [] },
    ],
    maxParallelSubtasks: 3,
  });

  t('a dependent subtask never starts before its dependency finishes', () => {
    const order = chained.events
      .filter((e) => e.type === 'subtask_started' || e.type === 'subtask_finished')
      .map((e) => `${e.type}:${e.subtaskId}`);
    const s1Done = order.indexOf('subtask_finished:s1');
    const s2Start = order.indexOf('subtask_started:s2');
    assert.ok(s1Done >= 0 && s2Start >= 0, `missing events: ${order.join(' ')}`);
    assert.ok(s2Start > s1Done, `s2 started before s1 finished: ${order.join(' ')}`);
  });

  t('the two independent ones still overlap', () => {
    assert.ok(chained.peak >= 2, `peak was ${chained.peak}; s1 and s3 should have overlapped`);
  });

  t('everything completes', () => {
    assert.strictEqual(chained.snapshot.status, 'done');
  });

  // ---------------------------------------------------------------- 4 ----
  console.log('\n== parallel: approvals are serialised across subtasks ==');
  const gated = await runScenario({ subtasks: independent(3), maxParallelSubtasks: 3, edits: true });

  t('the run really did raise multiple approvals', () => {
    const n = gated.events.filter((e) => e.type === 'approval_request').length;
    assert.ok(n >= 2, `only ${n} approval(s) raised - the fixture proved nothing`);
  });

  t('no two approvals are ever outstanding at the same time', () => {
    // The renderer holds ONE pending diff; a second concurrent request would
    // replace the first, whose promise an agent is blocked on, forever.
    let open = 0;
    for (const e of gated.events) {
      if (e.type === 'approval_request') {
        open += 1;
        assert.strictEqual(open, 1, 'a second approval was raised while one was still open');
      } else if (e.type === 'approval_resolved') {
        open -= 1;
      }
    }
    assert.strictEqual(open, 0, 'an approval was left unresolved');
  });

  t('every approval was resolved', () => {
    const reqs = gated.events.filter((e) => e.type === 'approval_request').length;
    const res = gated.events.filter((e) => e.type === 'approval_resolved').length;
    assert.strictEqual(res, reqs);
  });

  t('each subtask wrote its own file, with no lost updates', () => {
    for (const name of ['A', 'B', 'C']) {
      const f = path.join(gated.rootPath, `${name}.txt`);
      assert.ok(fs.existsSync(f), `${name}.txt was never written`);
      assert.strictEqual(fs.readFileSync(f, 'utf8'), `content for ${name}\n`);
    }
  });

  t('parallel writes did not trip the stale-proposal guard', () => {
    const stale = gated.events.filter((e) => e.type === 'intervention' && e.cause === 'stale_proposal');
    assert.strictEqual(stale.length, 0, `unexpected stale refusals: ${stale.map((s) => s.detail).join('; ')}`);
  });

  // ---------------------------------------------------------------- 5 ----
  console.log('\n== parallel: an absent setting stays sequential ==');
  const unset = await runScenario({ subtasks: independent(3), maxParallelSubtasks: undefined });
  t('no maxParallelSubtasks means one at a time', () => {
    assert.strictEqual(unset.peak, 1, `peak was ${unset.peak}; an unset limit must not fan out`);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
