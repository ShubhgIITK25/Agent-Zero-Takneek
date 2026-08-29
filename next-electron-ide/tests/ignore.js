/**
 * Dependency-free unit tests for the .nexideignore / .ignore matcher.
 *   npm run build:orchestrator && node tests/ignore.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const D = path.join(__dirname, '..', 'orchestrator-dist');
const { compileIgnoreRules, matchIgnored, loadIgnoreMatcher } = require(path.join(D, 'ignore'));

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

console.log('\n== ignore: gitignore-style context exclusion ==');

t('blank lines and comments are skipped', () => {
  const rules = compileIgnoreRules('\n# a comment\n\n  \n*.log\n');
  assert.strictEqual(rules.length, 1);
});

t('a plain name matches at any depth, files inside it too', () => {
  const rules = compileIgnoreRules('node_modules');
  assert.ok(matchIgnored(rules, 'node_modules'));
  assert.ok(matchIgnored(rules, 'node_modules/left-pad/index.js'));
  assert.ok(matchIgnored(rules, 'packages/app/node_modules/left-pad/index.js'));
  assert.ok(!matchIgnored(rules, 'src/node_modules_helper.ts'), 'must not match as a substring');
});

t('a trailing slash still excludes everything under the directory', () => {
  const rules = compileIgnoreRules('dist/');
  assert.ok(matchIgnored(rules, 'dist/bundle.js'));
  assert.ok(matchIgnored(rules, 'dist/nested/deep.js'));
});

t('a leading slash anchors to the project root only', () => {
  const rules = compileIgnoreRules('/build');
  assert.ok(matchIgnored(rules, 'build/out.js'));
  assert.ok(!matchIgnored(rules, 'packages/app/build/out.js'), 'anchored pattern must not match nested occurrences');
});

t('* matches within a segment, not across slashes', () => {
  const rules = compileIgnoreRules('*.env');
  assert.ok(matchIgnored(rules, '.env'));
  assert.ok(matchIgnored(rules, 'config/.env'));
  assert.ok(matchIgnored(rules, 'production.env'));
});

t('** matches across segments', () => {
  const rules = compileIgnoreRules('**/*.generated.ts');
  assert.ok(matchIgnored(rules, 'src/api/client.generated.ts'));
  assert.ok(matchIgnored(rules, 'client.generated.ts'));
});

t('a later negation re-includes a specific path', () => {
  const rules = compileIgnoreRules(['*.log', '!keep/important.log'].join('\n'));
  assert.ok(matchIgnored(rules, 'debug.log'));
  assert.ok(matchIgnored(rules, 'keep/other.log'));
  assert.ok(!matchIgnored(rules, 'keep/important.log'), 'negated path should be allowed back in');
});

t('an unrelated file is never ignored', () => {
  const rules = compileIgnoreRules('*.log\ndist/\n/build');
  assert.ok(!matchIgnored(rules, 'src/orchestrator.ts'));
});

t('.git is always excluded even with no ignore file at all', () => {
  assert.ok(matchIgnored([], '.git/HEAD'));
});

console.log('\n== ignore: loading from disk ==');

t('.nexideignore is preferred over .ignore when both exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-ignore-'));
  fs.writeFileSync(path.join(dir, '.nexideignore'), '*.nx\n');
  fs.writeFileSync(path.join(dir, '.ignore'), '*.legacy\n');
  const m = loadIgnoreMatcher(dir);
  assert.strictEqual(m.sourceFile, '.nexideignore');
  assert.ok(m.isIgnored('thing.nx'));
  assert.ok(!m.isIgnored('thing.legacy'), '.ignore should not apply once .nexideignore is found');
});

t('falls back to .ignore when .nexideignore is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-ignore-'));
  fs.writeFileSync(path.join(dir, '.ignore'), '*.legacy\n');
  const m = loadIgnoreMatcher(dir);
  assert.strictEqual(m.sourceFile, '.ignore');
  assert.ok(m.isIgnored('thing.legacy'));
});

t('neither file present means nothing is ignored beyond .git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-ignore-'));
  const m = loadIgnoreMatcher(dir);
  assert.strictEqual(m.sourceFile, null);
  assert.strictEqual(m.patternCount, 0);
  assert.ok(!m.isIgnored('src/index.ts'));
  assert.ok(m.isIgnored('.git/HEAD'));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
