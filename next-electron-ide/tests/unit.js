/**
 * Dependency-free unit tests for the orchestrator's pure logic.
 *   npm run build:orchestrator && node tests/unit.js
 *
 * No test framework on purpose: these need to run on a clean machine during
 * evaluation without adding a dev dependency. node:assert is enough.
 *
 * What is covered here is specifically the logic that is easy to get subtly
 * wrong and hard to notice: partial-approval diff reconstruction, defensive
 * parsing of small-model output, the 80B TOTAL parameter rule, routing
 * decisions, and pre-dispatch budget enforcement.
 */
const assert = require('assert');
const path = require('path');
const D = path.join(__dirname, '..', 'orchestrator-dist');
const { buildFileDiff, applyAcceptedBlocks, renderUnified } = require(path.join(D, 'diff'));
const { extractJson, parsePlan, parseVerdict } = require(path.join(D, 'agents'));
const { Router, RateLimitTracker } = require(path.join(D, 'router'));
const { checkEligibility, findModel, MODEL_REGISTRY } = require(path.join(D, 'models'));
const { Budget } = require(path.join(D, 'budget'));

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

console.log('\n== diff: block-level partial approval ==');
const oldC = ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 2;', '}', '', 'function c() {', '  return 3;', '}'].join('\n');
const newC = ['function a() {', '  return 100;', '}', '', 'function b() {', '  return 2;', '}', '', 'function c() {', '  return 300;', '}'].join('\n');
const d = buildFileDiff('x.js', oldC, newC);

t('produces two separate hunks for two distant edits', () => {
  assert.strictEqual(d.blocks.length, 2, `got ${d.blocks.length} blocks`);
});
t('accept all == proposed content', () => {
  assert.strictEqual(applyAcceptedBlocks(d, d.blocks.map((b) => b.id)), newC);
});
t('reject all == original content', () => {
  assert.strictEqual(applyAcceptedBlocks(d, []), oldC);
});
t('accept only first hunk keeps second unchanged', () => {
  const r = applyAcceptedBlocks(d, [d.blocks[0].id]);
  assert.ok(r.includes('return 100;'), 'first edit should be applied');
  assert.ok(r.includes('return 3;') && !r.includes('return 300;'), 'second edit leaked in');
});
t('accept only second hunk keeps first unchanged', () => {
  const r = applyAcceptedBlocks(d, [d.blocks[1].id]);
  assert.ok(r.includes('return 1;'), 'first edit should NOT be applied');
  assert.ok(r.includes('return 300;'), 'second edit should be applied');
});
t('new file (no original) round-trips', () => {
  const nd = buildFileDiff('n.js', null, 'line1\nline2');
  assert.strictEqual(applyAcceptedBlocks(nd, nd.blocks.map((b) => b.id)), 'line1\nline2');
  assert.strictEqual(applyAcceptedBlocks(nd, []), '');
});
t('identical content yields zero blocks', () => {
  assert.strictEqual(buildFileDiff('s.js', oldC, oldC).blocks.length, 0);
});
t('unified render has +/- markers', () => {
  const u = renderUnified(d);
  assert.ok(u.includes('-  return 1;') && u.includes('+  return 100;'));
});
t('unknown block ids are ignored rather than thrown on', () => {
  // only-junk ids => nothing real accepted => original content, no exception
  assert.strictEqual(applyAcceptedBlocks(d, ['bogus#99', 'nope#0']), oldC);
});
t('every real block id plus junk still applies the full change', () => {
  const ids = [...d.blocks.map((b) => b.id), 'not-a-real-id'];
  assert.strictEqual(applyAcceptedBlocks(d, ids), newC);
});
t('buildFileDiff and applyAcceptedBlocks agree on hunk boundaries', () => {
  // three edits: two close (one hunk) + one far (separate hunk)
  const o = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const n2 = o
    .replace('line 2', 'LINE 2')
    .replace('line 4', 'LINE 4')
    .replace('line 25', 'LINE 25');
  const dd = buildFileDiff('m.js', o, n2);
  assert.strictEqual(dd.blocks.length, 2, `expected 2 hunks, got ${dd.blocks.length}`);
  // accept only the far hunk: near edits must NOT leak in
  const far = applyAcceptedBlocks(dd, [dd.blocks[1].id]);
  assert.ok(far.includes('LINE 25') && far.includes('line 2\n') && far.includes('line 4\n'));
  // accept only the near hunk: far edit must NOT leak in
  const near = applyAcceptedBlocks(dd, [dd.blocks[0].id]);
  assert.ok(near.includes('LINE 2') && near.includes('LINE 4') && near.includes('line 25'));
});

console.log('\n== agents: defensive parsing of small-model output ==');
t('parses fenced json', () => assert.deepStrictEqual(extractJson('sure!\n```json\n{"a":1}\n```\nhope that helps'), { a: 1 }));
t('parses bare json amid prose', () => assert.deepStrictEqual(extractJson('Here you go: {"a":2} done'), { a: 2 }));
t('tolerates trailing commas', () => assert.deepStrictEqual(extractJson('{"a":3,}'), { a: 3 }));
t('returns null on garbage', () => assert.strictEqual(extractJson('no json at all'), null));
t('plan falls back to a single subtask on unparseable output', () => {
  const p = parsePlan('total nonsense', 'fix the bug');
  assert.strictEqual(p.subtasks.length, 1);
  assert.strictEqual(p.subtasks[0].detail, 'fix the bug');
});
t('plan drops forward/cyclic dependencies that would deadlock the scheduler', () => {
  const p = parsePlan(
    JSON.stringify({
      trivial: false,
      restated_goal: 'g',
      subtasks: [
        { id: 's1', title: 'A', detail: 'a', category: 'codegen', dependsOn: ['s2'] },
        { id: 's2', title: 'B', detail: 'b', category: 'codegen', dependsOn: ['s1'] },
      ],
    }),
    'x'
  );
  assert.deepStrictEqual(p.subtasks[0].dependsOn, [], 'forward dep s1->s2 must be dropped');
  assert.deepStrictEqual(p.subtasks[1].dependsOn, ['s1'], 'backward dep kept');
});
t('unparseable verdict becomes low-confidence, never a silent pass', () => {
  const v = parseVerdict('I think it is broken honestly');
  assert.strictEqual(v.verdict, 'fail');
  assert.ok(v.confidence < 0.6, 'must be low confidence so it triggers the tie-break');
});

console.log('\n== models: the 80B TOTAL (not active) rule ==');
t('120B dense is blocked', () => assert.strictEqual(checkEligibility(findModel('groq:gpt-oss-120b')).eligible, false));
t('120B-total / 12B-active MoE is blocked on TOTAL', () => {
  const e = checkEligibility(findModel('openrouter:nemotron-super-120b'));
  assert.strictEqual(e.eligible, false);
  assert.ok(/12B active/.test(e.reason), 'reason should name the active-vs-total trap: ' + e.reason);
});
t('26B-total / 4B-active MoE is allowed', () => {
  assert.strictEqual(checkEligibility(findModel('openrouter:gemma-4-26b-a4b')).eligible, true);
});
t('Gemini Gemma is in the active Settings/routing registry', () => {
  const gemini = MODEL_REGISTRY.find((m) => m.id === 'gemini:gemma-4-31b');
  assert.ok(gemini, 'Gemini model must be visible to Settings and default routing');
  assert.strictEqual(gemini.provider, 'gemini');
  assert.strictEqual(checkEligibility(gemini).eligible, true);
});
t('unpublished parameter count is blocked', () => {
  assert.strictEqual(checkEligibility({ paramsBTotal: null, contextWindow: 1, pricing: {} }).eligible, false);
});

console.log('\n== router: signal-driven selection ==');
const enabled = ['groq:llama-3.1-8b', 'groq:llama-3.3-70b', 'ollama:qwen2.5-coder-7b', 'groq:gpt-oss-120b'];
const r = new Router(enabled, new RateLimitTracker());
const base = {
  category: 'simple_edit',
  estimatedContextTokens: 1000,
  budgetRemaining: 0.4,
  timeRemaining: 2000,
  attemptNumber: 1,
  cooldownProviders: [],
};

t('an ineligible model is never routed even when the user enabled it', () => {
  assert.notStrictEqual(r.route(base).model.id, 'groq:gpt-oss-120b');
});
t('prefers a zero-cost local model for a simple task', () => {
  const res = r.route(base);
  assert.strictEqual(res.model.id, 'ollama:qwen2.5-coder-7b', 'got ' + res.model.id + ' - ' + res.reason);
});
t('escalates to a more capable model on retry instead of repeating', () => {
  const first = r.route({ ...base, category: 'codegen' });
  const retry = r.route({ ...base, category: 'codegen', attemptNumber: 3 });
  assert.ok((retry.model.paramsBTotal ?? 0) >= (first.model.paramsBTotal ?? 0));
});
t('a rate-limited provider is excluded, with the reason recorded', () => {
  const rl = new RateLimitTracker();
  rl.penalise('ollama', true);
  const res = new Router(enabled, rl).route(base);
  assert.notStrictEqual(res.model.provider, 'ollama');
  // The reason must be actionable, not just present: it names the provider and
  // says how long the wait is, so the user can decide to switch rather than sit
  // and retry. (It used to read "in rate-limit backoff", which said neither.)
  const why = res.rejected.find((x) => /^ollama:/.test(x.why))?.why ?? '';
  assert.ok(/ollama/.test(why), `reason does not name the provider: "${why}"`);
  assert.ok(/retrying in ~/.test(why), `reason does not say how long: "${why}"`);
});
t('a context larger than the window is rejected with a reason', () => {
  const res = r.route({ ...base, estimatedContextTokens: 40000 });
  assert.ok(res.rejected.some((x) => /exceeds its .* window/.test(x.why)));
});
t('returns null when nothing is affordable', () => {
  const r3 = new Router(['groq:llama-3.3-70b'], new RateLimitTracker());
  assert.strictEqual(r3.route({ ...base, budgetRemaining: 0.0000001 }), null);
});
t('failover excludes the model that just failed', () => {
  assert.notStrictEqual(
    r.routeFallback({ ...base, category: 'codegen' }, ['ollama:qwen2.5-coder-7b']).model.id,
    'ollama:qwen2.5-coder-7b'
  );
});
t('planner role prefers the designated OpenRouter planner over the 27B coder', () => {
  const plannerRouter = new Router(
    ['groq:qwen3.8-27b', 'openrouter:qwen3-next-80b-thinking'],
    new RateLimitTracker(),
    undefined,
    [],
    'groq:qwen3.8-27b',
  );
  const result = plannerRouter.route({ ...base, role: 'planner', budgetRemaining: 0.4 });
  assert.ok(result, 'planner route should be available');
  assert.strictEqual(result.model.id, 'openrouter:qwen3-next-80b-thinking', result.reason);
  assert.ok(
    result.rejected.some((entry) => entry.modelId === 'groq:qwen3.8-27b' && /not tagged for planning/.test(entry.why)),
    'the 27B coder should be rejected from a planner route when a planner model is available',
  );
});
t('planner role falls back explicitly when no planner-capable model is usable', () => {
  const result = new Router(['groq:qwen3.8-27b'], new RateLimitTracker()).route({
    ...base,
    role: 'planner',
  });
  assert.ok(result, 'analysis fallback should keep a task runnable');
  assert.ok(/analysis fallback/.test(result.reason), result.reason);
});

console.log('\n== budget: ceilings enforced before dispatch, not after ==');
t('the reserve stops spending before the hard ceiling', () => {
  const b = new Budget(0.5, 2700);
  b.record(1000, 1000, 0.46);
  assert.strictEqual(b.canAfford(0.01), false);
  assert.strictEqual(b.breached().breached, false);
});
t('a hard breach is detected at the ceiling', () => {
  const b = new Budget(0.5, 2700);
  b.record(0, 0, 0.51);
  assert.strictEqual(b.breached().which, 'cost');
});
t('prior cost carries across a resume; elapsed wall-clock does not', () => {
  const b = new Budget(0.5, 2700, 0.2, 0);
  assert.strictEqual(b.costUsd, 0.2);
  assert.ok(b.elapsedSeconds < 5);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
