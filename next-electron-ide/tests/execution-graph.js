/**
 * Durable execution-graph change history and safe revert tests.
 *
 *   npm run build:orchestrator && node tests/execution-graph.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TaskStore } = require(path.join(__dirname, '..', 'orchestrator-dist', 'store'));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-execution-graph-'));
const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-execution-workspace-'));
const store = new TaskStore(dataDir, 'graph-test-codebase', 'graph-test-task');

const emit = (body) => {
  store.appendEvent({
    kind: 'event',
    taskId: 'graph-test-task',
    seq: store.nextSeq(),
    ts: Date.now(),
    ...body,
  });
};

const snapshot = {
  taskId: 'graph-test-task',
  codebaseId: 'graph-test-codebase',
  rootPath,
  prompt: 'test execution graph',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  step: 1,
  status: 'failed',
  subtasks: [],
  conversations: {},
  costUsd: 0,
  elapsedSeconds: 0,
  pinnedFacts: [],
  agentsMd: null,
};
store.saveSnapshot(snapshot);

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

console.log('\n== execution graph: durable controlled changes and safe revert ==');

const file = path.join(rootPath, 'src', 'demo.txt');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, 'before\n', 'utf8');
const first = store.recordFileChange('change-1', 'src/demo.txt', 'before\n', 'after\n');
fs.writeFileSync(file, 'after\n', 'utf8');
emit({ type: 'file_change', nodeId: 'n1', subtaskId: 's1', ...first });

t('records hashes and paths without storing the after-state in the event', () => {
  const event = store.readEvents().find((e) => e.type === 'file_change');
  assert.strictEqual(event.path, 'src/demo.txt');
  assert.strictEqual(event.beforeExists, true);
  assert.notStrictEqual(event.beforeHash, event.afterHash);
  assert.strictEqual(event.beforeContent, undefined);
});

t('reverts the latest tracked change to its exact before-state', () => {
  const result = store.revertLatestFileChange(rootPath);
  assert.strictEqual(result.changeId, 'change-1');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'before\n');
});

emit({ type: 'workspace_reverted', changeId: 'change-1', path: 'src/demo.txt' });

const created = path.join(rootPath, 'created.txt');
const second = store.recordFileChange('change-2', 'created.txt', null, 'created\n');
fs.writeFileSync(created, 'created\n', 'utf8');
emit({ type: 'file_change', nodeId: 'n2', subtaskId: 's1', ...second });

t('reverts an agent-created file by deleting it', () => {
  store.revertLatestFileChange(rootPath);
  assert.strictEqual(fs.existsSync(created), false);
});

emit({ type: 'workspace_reverted', changeId: 'change-2', path: 'created.txt' });

const guarded = path.join(rootPath, 'guarded.txt');
const third = store.recordFileChange('change-3', 'guarded.txt', 'before\n', 'after\n');
fs.writeFileSync(guarded, 'after\n', 'utf8');
emit({ type: 'file_change', nodeId: 'n3', subtaskId: 's1', ...third });
fs.writeFileSync(guarded, 'human edit\n', 'utf8');

t('refuses to overwrite a file changed after the agent', () => {
  assert.throws(
    () => store.revertLatestFileChange(rootPath),
    /changed after the agent's edit/,
  );
  assert.strictEqual(fs.readFileSync(guarded, 'utf8'), 'human edit\n');
});

if (fail) {
  console.error(`\n${fail} execution-graph test(s) failed`);
  process.exit(1);
}
console.log(`\n${pass} execution-graph tests passed`);
