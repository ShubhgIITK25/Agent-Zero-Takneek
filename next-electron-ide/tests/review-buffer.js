/**
 * The review buffer must show EXACTLY what will be written.
 *   npm run build:orchestrator && node tests/review-buffer.js
 *
 * src/lib/review-buffer.ts builds the buffer Monaco renders during an inline
 * diff review. orchestrator/diff.ts's applyAcceptedBlocks() decides what
 * actually lands on disk. If those two ever disagree, the user keeps a hunk
 * they can see and something else gets written — the worst possible failure
 * for an approval gate, and a silent one.
 *
 * So the assertion here is not "the buffer looks plausible": for every
 * combination of kept/denied hunks, folding the rendered rows must equal, byte
 * for byte, what the orchestrator will write. The renderer source is
 * transpiled on the fly (typescript is already a devDependency) so this tests
 * the file that actually ships rather than a copy.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const D = path.join(__dirname, '..', 'orchestrator-dist');
const { buildFileDiff, applyAcceptedBlocks } = require(path.join(D, 'diff'));

// --- load src/lib/review-buffer.ts without a build step ---------------------
const srcPath = path.join(__dirname, '..', 'src', 'lib', 'review-buffer.ts');
const transpiled = ts.transpileModule(fs.readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('exports', 'module', 'require', transpiled)(mod.exports, mod, require);
const { buildReviewRows, applyDecisionsToRows, blockStats, firstLineOfBlock } = mod.exports;

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

/** Every subset of the given block ids — the full decision space. */
function subsets(ids) {
  const out = [[]];
  for (const id of ids) {
    for (const existing of [...out]) out.push([...existing, id]);
  }
  return out;
}

const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n');

console.log('\n== review buffer: rows reconstruct the file faithfully ==');

// Two edits far enough apart to stay separate hunks, plus untouched regions.
const oldA = lines(40, (i) => `line ${i}`);
const newA = oldA
  .split('\n')
  .map((l, i) => (i === 4 ? 'line 5 CHANGED' : i === 30 ? 'line 31 CHANGED' : l))
  .join('\n');
const diffA = buildFileDiff('src/a.ts', oldA, newA);
const rowsA = buildReviewRows(diffA);

t('the diff really did produce more than one hunk (the interesting case)', () => {
  assert.ok(diffA.blocks.length >= 2, `expected >=2 blocks, got ${diffA.blocks.length}`);
});

t('dropping the added lines reproduces the original file exactly', () => {
  const reconstructed = rowsA
    .filter((r) => r.kind !== 'add')
    .map((r) => r.text)
    .join('\n');
  assert.strictEqual(reconstructed, oldA);
});

t('dropping the deleted lines reproduces the proposed file exactly', () => {
  const reconstructed = rowsA
    .filter((r) => r.kind !== 'del')
    .map((r) => r.text)
    .join('\n');
  assert.strictEqual(reconstructed, newA);
});

t('every add/del row carries the block id it belongs to', () => {
  const orphan = rowsA.find((r) => r.kind !== 'context' && r.blockId === null);
  assert.strictEqual(orphan, undefined, `orphan row: ${JSON.stringify(orphan)}`);
});

t('no row claims a block id the orchestrator did not mint', () => {
  const real = new Set(diffA.blocks.map((b) => b.id));
  const bogus = rowsA.find((r) => r.blockId !== null && !real.has(r.blockId));
  assert.strictEqual(bogus, undefined, `unknown block id: ${bogus && bogus.blockId}`);
});

console.log('\n== review buffer: the preview equals what gets written ==');

/** The core contract, checked over the whole decision space of one diff. */
function assertPreviewMatchesDisk(diff, label) {
  const rows = buildReviewRows(diff);
  const allIds = diff.blocks.map((b) => b.id);
  for (const kept of subsets(allIds)) {
    const denied = new Set(allIds.filter((id) => !kept.includes(id)));
    const preview = applyDecisionsToRows(rows, denied);
    const onDisk = applyAcceptedBlocks(diff, kept);
    assert.strictEqual(
      preview,
      onDisk,
      `${label}: preview != disk for kept=[${kept.join(', ')}]\n--- preview ---\n${preview}\n--- disk ---\n${onDisk}`
    );
  }
}

t('multi-hunk edit: all 4 keep/deny combinations match applyAcceptedBlocks', () => {
  assertPreviewMatchesDisk(diffA, 'two-hunk edit');
});

t('keeping everything matches the agent proposal', () => {
  const rows = buildReviewRows(diffA);
  assert.strictEqual(applyDecisionsToRows(rows, new Set()), diffA.newContent);
});

t('denying everything leaves the file byte-identical to the original', () => {
  const rows = buildReviewRows(diffA);
  const allDenied = new Set(diffA.blocks.map((b) => b.id));
  assert.strictEqual(applyDecisionsToRows(rows, allDenied), oldA);
});

console.log('\n== review buffer: shapes that break naive implementations ==');

t('a brand new file (no original) renders as pure additions', () => {
  const created = 'export const hello = 1;\nexport const world = 2;\n';
  const diff = buildFileDiff('src/new.ts', null, created);
  const rows = buildReviewRows(diff);
  assert.ok(
    rows.every((r) => r.kind === 'add'),
    'a new file should have no context or deletion rows'
  );
  assertPreviewMatchesDisk(diff, 'new file');
});

t('an edit on the very first line is not dropped', () => {
  const before = lines(10, (i) => `line ${i}`);
  const after = before.replace('line 1', 'line 1 CHANGED');
  const diff = buildFileDiff('src/first.ts', before, after);
  assertPreviewMatchesDisk(diff, 'first-line edit');
});

t('an edit on the very last line is not dropped', () => {
  const before = lines(10, (i) => `line ${i}`);
  const after = before.replace('line 10', 'line 10 CHANGED');
  const diff = buildFileDiff('src/last.ts', before, after);
  assertPreviewMatchesDisk(diff, 'last-line edit');
});

t('a pure deletion (lines removed, nothing added) round-trips', () => {
  const before = lines(20, (i) => `line ${i}`);
  const after = before
    .split('\n')
    .filter((_, i) => i < 8 || i > 11)
    .join('\n');
  const diff = buildFileDiff('src/del.ts', before, after);
  assertPreviewMatchesDisk(diff, 'pure deletion');
});

t('a pure insertion into the middle round-trips', () => {
  const before = lines(20, (i) => `line ${i}`);
  const parts = before.split('\n');
  const after = [...parts.slice(0, 10), 'inserted A', 'inserted B', ...parts.slice(10)].join('\n');
  const diff = buildFileDiff('src/ins.ts', before, after);
  assertPreviewMatchesDisk(diff, 'pure insertion');
});

t('adjacent hunks (edits ~7 lines apart) do not duplicate or swallow context', () => {
  const before = lines(30, (i) => `line ${i}`);
  const after = before
    .split('\n')
    .map((l, i) => (i === 9 ? 'line 10 CHANGED' : i === 16 ? 'line 17 CHANGED' : l))
    .join('\n');
  const diff = buildFileDiff('src/adj.ts', before, after);
  const rows = buildReviewRows(diff);
  assert.strictEqual(
    rows.filter((r) => r.kind !== 'add').map((r) => r.text).join('\n'),
    before,
    'context around adjacent hunks was duplicated or lost'
  );
  assertPreviewMatchesDisk(diff, 'adjacent hunks');
});

t('a file whose trailing newline is removed keeps that distinction', () => {
  const before = 'a\nb\nc\n';
  const after = 'a\nb\nc';
  const diff = buildFileDiff('src/nl.ts', before, after);
  assertPreviewMatchesDisk(diff, 'trailing newline');
});

console.log('\n== review buffer: helpers used by the hunk toolbar ==');

t('blockStats counts the +/- the toolbar shows', () => {
  const first = diffA.blocks[0].id;
  const stats = blockStats(rowsA, first);
  assert.strictEqual(stats.added, 1);
  assert.strictEqual(stats.removed, 1);
});

t('firstLineOfBlock points at a row that really belongs to that hunk', () => {
  for (const b of diffA.blocks) {
    const line = firstLineOfBlock(rowsA, b.id);
    assert.strictEqual(rowsA[line - 1].blockId, b.id, `line ${line} is not in block ${b.id}`);
  }
});

t('hunk anchors are strictly increasing, so the toolbars stack in order', () => {
  const anchors = diffA.blocks.map((b) => firstLineOfBlock(rowsA, b.id));
  for (let i = 1; i < anchors.length; i++) {
    assert.ok(anchors[i] > anchors[i - 1], `anchor ${i} (${anchors[i]}) not after ${anchors[i - 1]}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
