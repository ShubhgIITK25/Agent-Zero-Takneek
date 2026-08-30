/**
 * Regression test for BACKTRACKING on failed verification
 * (TaskRunner.restoreBacktrackPoint / captureBacktrackPoint).
 *
 *   npm run build:orchestrator && node tests/backtrack.js
 *
 * Before this existed, a failed verification retried ON TOP of the edits that
 * had just been rejected: attempt 2 started from a tree the verifier already
 * refused, attempt 3 compounded it, and when the retries ran out the union of
 * every broken attempt was left on disk under a subtask marked `failed` — with
 * its dependents blocked, so nothing downstream would ever clean up.
 *
 * The scenario below runs a REAL TaskRunner with only providers.callModel
 * mocked, over a real temp project containing two files:
 *
 *   good.txt   an EXISTING file the agent overwrites  -> must be restored
 *   new.txt    a file the agent CREATES               -> must be deleted
 *
 * The verifier rejects every attempt, so all retries are exhausted and the
 * workspace must end byte-identical to how it started.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = path.join(__dirname, '..', 'orchestrator-dist');
const providers = require(path.join(D, 'providers'));

const ORIGINAL_GOOD = 'original contents that must survive\n';

// Each implementer attempt writes different garbage, so if the rollback were
// merely "rewrite what attempt 1 saw" rather than a true restore, the final
// contents would betray it.
let implementerCalls = 0;

providers.callModel = async (_model, messages) => {
  const sys = (messages.find((m) => m.role === 'system') || {}).content || '';
  const base = { toolCalls: [], promptTokens: 10, completionTokens: 10, costUsd: 0, latencyMs: 1 };

  if (sys.startsWith('You are the planner')) {
    return {
      ...base,
      text: JSON.stringify({
        trivial: false,
        restated_goal: 'edit two files',
        subtasks: [{ id: 's1', title: 'Edit files', detail: 'edit them', category: 'codegen', dependsOn: [] }],
      }),
    };
  }

  if (sys.includes('You are an implementer agent')) {
    const n = ++implementerCalls;
    // Odd calls propose the edits; even calls report DONE, so each attempt is
    // a propose-then-finish pair rather than an infinite tool loop.
    if (n % 2 === 1) {
      return {
        ...base,
        text: `Attempt ${n}: writing the files.`,
        toolCalls: [
          {
            id: `c${n}a`,
            name: 'propose_edit',
            arguments: { path: 'good.txt', content: `BROKEN attempt ${n}\n`, summary: 'overwrite' },
          },
          {
            id: `c${n}b`,
            name: 'propose_edit',
            arguments: { path: 'new.txt', content: `created by attempt ${n}\n`, summary: 'create' },
          },
        ],
      };
    }
    return { ...base, text: 'DONE: wrote both files' };
  }

  if (sys.includes('You are an independent verifier')) {
    // High confidence so the tie-break never fires and every attempt is a
    // clean, unambiguous rejection.
    return {
      ...base,
      text: JSON.stringify({
        verdict: 'fail',
        confidence: 0.95,
        reason: 'the change is wrong',
        evidence: 'checked the files',
      }),
    };
  }

  return { ...base, text: 'Summary text.' };
};

const { TaskRunner } = require(path.join(D, 'orchestrator'));
const { TaskStore } = require(path.join(D, 'store'));

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-bt-data-'));
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-bt-proj-'));
  fs.writeFileSync(path.join(rootPath, 'good.txt'), ORIGINAL_GOOD);

  const store = new TaskStore(dataDir, 'cb-bt', 'backtrack-test');
  const events = [];

  const runner = new TaskRunner(
    'backtrack-test',
    'edit good.txt and create new.txt',
    {
      rootPath,
      codebaseId: 'cb-bt',
      retrievalUrl: null,
      env: {},
      enabledModelIds: ['groq:llama-3.1-8b'],
      maxCostUsd: 0.5,
      maxSeconds: 2700,
    },
    store,
    (body) => {
      events.push(body);
      // Auto-approve every diff, as "approve all" in the UI would. The point is
      // that a rollback must undo even edits a human explicitly accepted.
      if (body.type === 'approval_request') {
        setImmediate(() => runner.resolveApproval({ requestId: body.request.requestId, approved: true }));
      }
    },
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

  const restores = events.filter((e) => e.type === 'intervention' && e.cause === 'workspace_restored');
  const goodExists = fs.existsSync(path.join(rootPath, 'good.txt'));
  const goodNow = goodExists ? fs.readFileSync(path.join(rootPath, 'good.txt'), 'utf8') : '<missing>';
  const newExists = fs.existsSync(path.join(rootPath, 'new.txt'));

  console.log(`\n  implementer attempts: ${Math.ceil(implementerCalls / 2)}`);
  console.log(`  workspace_restored interventions: ${restores.length}`);
  console.log(`  good.txt: ${JSON.stringify(goodNow)}`);
  console.log(`  new.txt exists: ${newExists}`);

  console.log('\n== backtracking: a rejected attempt must not survive on disk ==');

  t('an existing file the agent overwrote is restored byte-for-byte', () => {
    assert.strictEqual(goodNow, ORIGINAL_GOOD);
  });
  t('a file the agent created is deleted, not left behind', () => {
    assert.strictEqual(newExists, false, 'new.txt should not exist after every attempt failed');
  });
  t('the rollback is surfaced as an intervention, never silently', () => {
    assert.ok(restores.length >= 1, 'expected at least one workspace_restored intervention');
  });
  t('the intervention names the files it reverted', () => {
    assert.ok(/good\.txt/.test(restores[0].detail), restores[0].detail);
    assert.ok(/new\.txt/.test(restores[0].detail), restores[0].detail);
  });
  t('every failed attempt rolls back, not just the last one', () => {
    // 3 retries => 2 mid-loop rollbacks + 1 final rollback.
    assert.ok(restores.length >= 2, `only ${restores.length} rollback(s) for ${Math.ceil(implementerCalls / 2)} attempts`);
  });
  t('the retry prompt tells the model its edits were reverted', () => {
    const convo = store.loadSnapshot().conversations.s1 || [];
    const retryMsg = convo.find((m) => m.role === 'user' && /REVERTED/.test(m.content || ''));
    assert.ok(retryMsg, 'no retry message mentioned the revert — the model would assume its edits survived');
  });
  t('the subtask still ends failed (rollback is not a pass)', () => {
    assert.strictEqual(store.loadSnapshot().subtasks.find((s) => s.id === 's1').status, 'failed');
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(rootPath, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
