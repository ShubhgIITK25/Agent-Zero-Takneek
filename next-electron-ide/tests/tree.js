/**
 * The call tree must always be renderable.
 *   node tests/tree.js
 *
 * The dashboard recurses over `children`, so a cycle or a dangling parent in
 * the node list would hang the UI rather than merely look wrong. Both are
 * reachable in practice - replaying a truncated events.jsonl, or building the
 * tree for one subtask's nodes in isolation, leaves children whose parent is
 * not in the set - so the builder must degrade to a forest instead of
 * trusting the data.
 *
 * The two properties asserted everywhere below: every input node appears
 * exactly once, and walking `children` always terminates.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const srcPath = path.join(__dirname, '..', 'src', 'lib', 'trace.ts');
const transpiled = ts.transpileModule(fs.readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('exports', 'module', 'require', transpiled)(mod.exports, mod, require);
const { buildCallTree, subtreeTotals, treeDepth } = mod.exports;

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

const n = (nodeId, parentId, extra = {}) => ({
  nodeId,
  parentId,
  role: 'implementer',
  subtaskId: null,
  modelId: 'm',
  provider: 'p',
  prompt: '',
  promptTokens: 1,
  completionTokens: 1,
  costUsd: 0.001,
  latencyMs: 1,
  startedAt: 0,
  thoughts: [],
  toolCalls: [],
  contextItems: [],
  contextTotalTokens: 0,
  ...extra,
});

/** Walks the forest with a hard visit cap, so a cycle fails loudly instead of hanging. */
function collect(roots, cap = 10000) {
  const seen = [];
  const stack = [...roots];
  let steps = 0;
  while (stack.length) {
    if (++steps > cap) throw new Error('tree walk did not terminate - cycle survived buildCallTree');
    const item = stack.pop();
    seen.push(item.node.nodeId);
    for (const c of item.children) stack.push(c);
  }
  return seen;
}

function assertLossless(nodes, roots) {
  const got = collect(roots).sort();
  const want = nodes.map((x) => x.nodeId).sort();
  assert.deepStrictEqual(got, want, 'every node must appear exactly once');
}

console.log('\n== call tree: the shape the orchestrator actually produces ==');

// planner -> impl -> verifier -> retry impl -> verifier2
const pipeline = [
  n('plan', null, { role: 'planner' }),
  n('i1', 'plan'),
  n('i2', 'plan'), // second step of the same attempt: a SIBLING, not nested
  n('v1', 'i2', { role: 'verifier' }),
  n('i3', 'v1'), // retry, caused by the verifier that rejected attempt 1
  n('v2', 'i3', { role: 'verifier' }),
];

t('a real pipeline forms one tree rooted at the planner', () => {
  const roots = buildCallTree(pipeline);
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0].node.nodeId, 'plan');
  assertLossless(pipeline, roots);
});

t('steps of one attempt stay siblings rather than chaining', () => {
  const roots = buildCallTree(pipeline);
  const planKids = roots[0].children.map((c) => c.node.nodeId);
  assert.deepStrictEqual(planKids, ['i1', 'i2']);
});

t('a retry nests under the verifier that forced it', () => {
  const roots = buildCallTree(pipeline);
  const i2 = roots[0].children.find((c) => c.node.nodeId === 'i2');
  const v1 = i2.children[0];
  assert.strictEqual(v1.node.nodeId, 'v1');
  assert.strictEqual(v1.children[0].node.nodeId, 'i3');
});

t('depth is assigned from the root down', () => {
  const roots = buildCallTree(pipeline);
  assert.strictEqual(roots[0].depth, 0);
  assert.strictEqual(roots[0].children[0].depth, 1);
  assert.strictEqual(treeDepth(roots), 5, 'plan > i2 > v1 > i3 > v2');
});

t('children keep the order the calls were made in', () => {
  const roots = buildCallTree([n('r', null), n('c3', 'r'), n('c1', 'r'), n('c2', 'r')]);
  assert.deepStrictEqual(
    roots[0].children.map((c) => c.node.nodeId),
    ['c3', 'c1', 'c2']
  );
});

console.log('\n== call tree: inputs that must not hang the dashboard ==');

t('a node whose parent is missing becomes a root instead of vanishing', () => {
  const nodes = [n('a', 'ghost'), n('b', null)];
  const roots = buildCallTree(nodes);
  assertLossless(nodes, roots);
  assert.strictEqual(roots.length, 2);
});

t('rendering one subtask in isolation keeps all of its nodes', () => {
  // Exactly what the "By subtask" view does: the planner parent is not in set.
  const subset = pipeline.filter((x) => x.nodeId !== 'plan');
  const roots = buildCallTree(subset);
  assertLossless(subset, roots);
  assert.deepStrictEqual(roots.map((r) => r.node.nodeId).sort(), ['i1', 'i2']);
});

t('a self-referential parent does not disappear or recurse', () => {
  const nodes = [n('a', 'a')];
  const roots = buildCallTree(nodes);
  assertLossless(nodes, roots);
  assert.strictEqual(roots[0].children.length, 0);
});

t('a two-node cycle degrades to roots rather than hanging', () => {
  const nodes = [n('a', 'b'), n('b', 'a')];
  const roots = buildCallTree(nodes);
  assertLossless(nodes, roots);
});

t('a three-node cycle degrades to roots rather than hanging', () => {
  const nodes = [n('a', 'c'), n('b', 'a'), n('c', 'b')];
  const roots = buildCallTree(nodes);
  assertLossless(nodes, roots);
});

t('a healthy node hanging off a cyclic chain is still kept', () => {
  const nodes = [n('a', 'b'), n('b', 'a'), n('leaf', 'a'), n('ok', null)];
  const roots = buildCallTree(nodes);
  assertLossless(nodes, roots);
});

t('an empty node list yields an empty forest', () => {
  assert.deepStrictEqual(buildCallTree([]), []);
  assert.strictEqual(treeDepth([]), 0);
});

console.log('\n== call tree: rolled-up totals for a collapsed branch ==');

t('subtreeTotals sums the node and everything it caused', () => {
  const roots = buildCallTree(pipeline);
  const totals = subtreeTotals(roots[0]);
  assert.strictEqual(totals.calls, 6);
  assert.strictEqual(totals.tokens, 12);
  assert.ok(Math.abs(totals.costUsd - 0.006) < 1e-9, `got ${totals.costUsd}`);
});

t('a leaf reports only itself', () => {
  const roots = buildCallTree([n('solo', null)]);
  assert.strictEqual(subtreeTotals(roots[0]).calls, 1);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
