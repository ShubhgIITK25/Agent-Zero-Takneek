/**
 * Regression test for rollback between retries after an implementer reports
 * BLOCKED. A blocked attempt may have already received approval for edits, so
 * the next attempt must see the same workspace as the first one.
 *
 *   npm run build:orchestrator && node tests/blocked-backtrack.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = path.join(__dirname, '..', 'orchestrator-dist');
const providers = require(path.join(D, 'providers'));
const { TaskRunner } = require(path.join(D, 'orchestrator'));
const { TaskStore } = require(path.join(D, 'store'));

const ORIGINAL = 'original contents\n';
const observedReads = [];

providers.callModel = async (_model, messages) => {
  const sys = (messages.find((m) => m.role === 'system') || {}).content || '';
  const base = { toolCalls: [], promptTokens: 10, completionTokens: 10, costUsd: 0, latencyMs: 1 };

  if (sys.startsWith('You are the planner')) {
    return {
      ...base,
      text: JSON.stringify({
        trivial: false,
        restated_goal: 'edit a file',
        subtasks: [{ id: 's1', title: 'Edit the file', detail: 'edit state.txt', category: 'codegen', dependsOn: [] }],
      }),
    };
  }

  if (sys.includes('You are an implementer agent')) {
    const last = messages[messages.length - 1] || {};

    // Start each retry by asking what is actually on disk. This makes the
    // rollback invariant observable rather than inferred from the final file.
    if (last.role === 'user' || (last.role === 'assistant' && /^BLOCKED/i.test(last.content || ''))) {
      return {
        ...base,
        text: '',
        toolCalls: [{ id: `read-${observedReads.length + 1}`, name: 'read_file', arguments: { path: 'state.txt' } }],
      };
    }

    if (last.role === 'tool' && last.name === 'read_file') {
      observedReads.push(last.content || '');
      const n = observedReads.length;
      return {
        ...base,
        text: `Attempt ${n}: proposing an edit.`,
        toolCalls: [{
          id: `edit-${n}`,
          name: 'propose_edit',
          arguments: { path: 'state.txt', content: `broken attempt ${n}\n`, summary: 'test edit' },
        }],
      };
    }

    if (last.role === 'tool' && last.name === 'propose_edit') {
      return { ...base, text: 'BLOCKED: verification setup is unavailable' };
    }
  }

  // The bounded re-planner declines because this test is about retry state.
  return { ...base, text: 'No viable replacement plan.' };
};

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-blocked-data-'));
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-blocked-proj-'));
  fs.writeFileSync(path.join(rootPath, 'state.txt'), ORIGINAL);

  const store = new TaskStore(dataDir, 'cb-blocked', 'blocked-backtrack-test');
  const events = [];
  const runner = new TaskRunner(
    'blocked-backtrack-test',
    'edit state.txt',
    {
      rootPath,
      codebaseId: 'cb-blocked',
      retrievalUrl: null,
      env: {},
      enabledModelIds: ['groq:llama-3.1-8b'],
      maxCostUsd: 0.5,
      maxSeconds: 2700,
    },
    store,
    (body) => {
      events.push(body);
      if (body.type === 'approval_request') {
        setImmediate(() => runner.resolveApproval({ requestId: body.request.requestId, approved: true }));
      }
    },
    () => {},
    null
  );

  await runner.run(false);

  const final = fs.readFileSync(path.join(rootPath, 'state.txt'), 'utf8');
  const restores = events.filter((e) => e.type === 'intervention' && e.cause === 'workspace_restored');

  console.log('\n== blocked retry: every retry starts from a clean workspace ==');
  console.log(`  workspace reads: ${observedReads.length}`);
  console.log(`  workspace_restored interventions: ${restores.length}`);
  console.log(`  final state.txt: ${JSON.stringify(final)}`);

  assert.strictEqual(observedReads.length, 3, 'expected one workspace read per retry');
  assert.ok(observedReads.every((content) => content.includes(ORIGINAL)), 'a retry saw an earlier blocked edit');
  assert.ok(restores.length >= 3, 'each blocked attempt should surface its rollback');
  assert.strictEqual(final, ORIGINAL, 'failed blocked attempts must not survive on disk');
  assert.strictEqual(store.loadSnapshot().subtasks[0].status, 'failed');

  console.log('\n4 passed, 0 failed\n');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(rootPath, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
