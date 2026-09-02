/**
 * Regression test for the stop button: the active model call must be aborted
 * and the task must emit task_paused promptly, preserving its checkpoint for
 * a later resume.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = path.join(__dirname, '..', 'orchestrator-dist');
const providers = require(path.join(D, 'providers'));

providers.callModel = async (_model, _messages, _tools, _env, signal) => {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('cancelled by user'));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        text: 'DONE: finished this subtask',
        toolCalls: [],
        promptTokens: 10,
        completionTokens: 10,
        costUsd: 0,
        latencyMs: 1,
      });
    }, 500);
  });
};

const { TaskRunner } = require(path.join(D, 'orchestrator'));
const { TaskStore } = require(path.join(D, 'store'));

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenawabs-cancel-'));
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'codenawabs-cancel-project-'));
  const id = 'cancel-regression';
  const store = new TaskStore(dataDir, 'cb-cancel', id);
  const events = [];

  const runner = new TaskRunner(
    id,
    'stop this task immediately',
    {
      rootPath,
      codebaseId: 'cb-cancel',
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

  const runPromise = runner.run(false);
  setTimeout(() => runner.cancel(), 25);

  await Promise.race([
    runPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('task did not pause promptly')), 250)),
  ]);

  assert.ok(events.some((e) => e.type === 'task_paused'), 'task_paused event was not emitted');
  assert.strictEqual(store.loadSnapshot().status, 'paused', 'snapshot should be marked paused');
  console.log('pause test passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
