/**
 * Regression test for the "task with failed subtasks reported as done" bug
 * (orchestrator/orchestrator.ts, TaskRunner.run()'s post-loop status logic).
 *
 * Runs a REAL TaskRunner end to end — plan, route, execute, verify, retry,
 * checkpoint, aggregate — with only the network boundary (providers.callModel)
 * mocked, so this exercises the actual pipeline rather than re-testing the
 * one-line predicate in isolation. providers.callModel is monkey-patched on
 * the shared module object before orchestrator.js is required, which works
 * because tsc compiles `import { callModel } from './providers'` to a
 * `providers_1.callModel(...)` property read at call time, not a captured
 * local binding.
 *
 *   npm run build:orchestrator && node tests/task-completion.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = path.join(__dirname, '..', 'orchestrator-dist');
const providers = require(path.join(D, 'providers'));

// Route every call by which system prompt it carries — agents.ts gives each
// role a distinct, recognisable opening line.
providers.callModel = async (_model, messages) => {
  const sys = (messages.find((m) => m.role === 'system') || {}).content || '';
  const base = { toolCalls: [], promptTokens: 10, completionTokens: 10, costUsd: 0, latencyMs: 1 };

  if (sys.startsWith('You are the planner')) {
    return {
      ...base,
      text: JSON.stringify({
        trivial: false,
        restated_goal: 'demo task with one good and one bad subtask',
        subtasks: [
          { id: 's1', title: 'Task A', detail: 'do A', category: 'codegen', dependsOn: [] },
          { id: 's2', title: 'Task B', detail: 'do B', category: 'codegen', dependsOn: [] },
        ],
      }),
    };
  }
  if (sys.includes('You are an implementer agent')) {
    // Both subtasks' implementer claims success — the point of this test is
    // that the VERIFIER catching a bad claim must still fail the task, not
    // that the implementer misbehaves.
    return { ...base, text: 'DONE: finished this subtask' };
  }
  if (sys.includes('You are an independent verifier')) {
    const user = (messages.find((m) => m.role === 'user') || {}).content || '';
    const isTaskA = user.includes('Task A');
    return {
      ...base,
      text: JSON.stringify(
        isTaskA
          ? { verdict: 'pass', confidence: 0.9, reason: 'looks correct', evidence: 'checked' }
          : { verdict: 'fail', confidence: 0.95, reason: 'does not actually work', evidence: 'checked and it is broken' }
      ),
    };
  }
  // Aggregation / summariser call.
  return { ...base, text: 'Summary text.' };
};

const { TaskRunner } = require(path.join(D, 'orchestrator'));
const { TaskStore } = require(path.join(D, 'store'));

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-test-'));
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-project-'));
  const store = new TaskStore(dataDir, 'cb-test', 'task-completion-test');

  const events = [];
  const emit = (body) => events.push(body);

  const runner = new TaskRunner(
    'task-completion-test',
    'do task A and task B',
    {
      rootPath,
      codebaseId: 'cb-test',
      retrievalUrl: null,
      env: {},
      enabledModelIds: ['groq:llama-3.1-8b'],
      maxCostUsd: 0.5,
      maxSeconds: 2700,
    },
    store,
    emit,
    () => {},
    null
  );

  await runner.run(false);

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

  const finished = events.filter((e) => e.type === 'task_finished');
  const failedEvents = events.filter((e) => e.type === 'task_failed');
  const finalStore = store.loadSnapshot();

  console.log('\n  subtask outcomes:', finalStore.subtasks.map((s) => `${s.id}=${s.status}`).join(', '));

  console.log('\n== task completion: one failed subtask must not report task done ==');
  t('one subtask genuinely failed (verifier rejected it every retry)', () => {
    assert.strictEqual(finalStore.subtasks.find((s) => s.id === 's2').status, 'failed');
  });
  t('the other subtask genuinely succeeded', () => {
    assert.strictEqual(finalStore.subtasks.find((s) => s.id === 's1').status, 'done');
  });
  t('task_finished was NOT emitted', () => {
    assert.strictEqual(finished.length, 0, `got ${finished.length} task_finished event(s) — a partial failure must not look like success`);
  });
  t('task_failed WAS emitted exactly once', () => {
    assert.strictEqual(failedEvents.length, 1);
  });
  t('the failure reason names the specific subtask that did not complete', () => {
    assert.ok(/Task B/.test(failedEvents[0].reason), failedEvents[0].reason);
  });
  t('the persisted snapshot status is "failed", not "done"', () => {
    assert.strictEqual(finalStore.status, 'failed');
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
