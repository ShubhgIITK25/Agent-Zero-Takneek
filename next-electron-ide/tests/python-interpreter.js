/**
 * Python interpreter resolution for the retrieval service
 * (electron/python-interpreter.ts).
 *
 *   npm run build:electron && node tests/python-interpreter.js
 *
 * The bug this guards against: spawning bare `python3`, which almost never has
 * tree-sitter / fastembed / sqlite-vec, so the retrieval service runs in
 * permanent keyword-only degraded mode on any machine that did not pip-install
 * the requirements globally. Resolution must prefer, in order: an explicit
 * CODENAWABS_PYTHON, the legacy NEXIDE_PYTHON alias, the project-local retrieval-service/.venv, an activated
 * $VIRTUAL_ENV, and only then fall back to PATH - flagging the fallback so the
 * caller can warn.
 *
 * The function is pure (fs check and paths are injected), so every branch is
 * exercised here without touching a real filesystem.
 */
const assert = require('assert');
const path = require('path');

const { resolvePythonInterpreter, venvInterpreter } = require(
  path.join(__dirname, '..', 'electron-dist', 'python-interpreter'),
);

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

const SERVICE = '/app/retrieval-service';
// On Windows the real caller passes a backslash path from retrievalServiceDir();
// use one here so the join matches what main.ts actually produces.
const SERVICE_WIN = 'C:\\app\\retrieval-service';

/** A resolver call with sensible defaults; `existing` is the set of paths that "exist". */
function resolve({
  env = {},
  platform = 'linux',
  existing = [],
} = {}) {
  const set = new Set(existing);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return resolvePythonInterpreter({
    serviceDir: platform === 'win32' ? SERVICE_WIN : SERVICE,
    env,
    platform,
    exists: (p) => set.has(p),
    join,
  });
}

const posixVenv = path.posix.join(SERVICE, '.venv', 'bin', 'python');
const winVenv = path.win32.join(SERVICE_WIN, '.venv', 'Scripts', 'python.exe');

// --------------------------------------------------------------------------
console.log('\n== CODENAWABS_PYTHON is the explicit override ==');

t('a bare command name is trusted without an existence check', () => {
  const r = resolve({ env: { CODENAWABS_PYTHON: 'python3.12' }, existing: [] });
  assert.strictEqual(r.command, 'python3.12');
  assert.strictEqual(r.source, 'CODENAWABS_PYTHON');
  assert.strictEqual(r.isFallback, false);
});

t('an override path that exists is used', () => {
  const r = resolve({
    env: { CODENAWABS_PYTHON: '/opt/py/bin/python' },
    existing: ['/opt/py/bin/python'],
  });
  assert.strictEqual(r.command, '/opt/py/bin/python');
  assert.strictEqual(r.source, 'CODENAWABS_PYTHON');
});

t('an override path that does NOT exist is rejected, and resolution continues', () => {
  const r = resolve({
    env: { CODENAWABS_PYTHON: '/opt/py/bin/python' },
    existing: [posixVenv], // the venv is there to fall through to
  });
  assert.strictEqual(r.command, posixVenv);
  assert.strictEqual(r.source, 'retrieval-service/.venv');
});

t('override beats an existing local venv', () => {
  const r = resolve({
    env: { CODENAWABS_PYTHON: 'my-python' },
    existing: [posixVenv],
  });
  assert.strictEqual(r.command, 'my-python');
});

t('the legacy NEXIDE_PYTHON alias still works', () => {
  const r = resolve({ env: { NEXIDE_PYTHON: 'legacy-python' }, existing: [] });
  assert.strictEqual(r.command, 'legacy-python');
  assert.strictEqual(r.source, 'NEXIDE_PYTHON (legacy)');
  assert.strictEqual(r.isFallback, false);
});

t('the new variable wins when both names are configured', () => {
  const r = resolve({ env: { CODENAWABS_PYTHON: 'new-python', NEXIDE_PYTHON: 'legacy-python' }, existing: [] });
  assert.strictEqual(r.command, 'new-python');
  assert.strictEqual(r.source, 'CODENAWABS_PYTHON');
});

// --------------------------------------------------------------------------
console.log('\n== the project-local venv is the common case ==');

t('retrieval-service/.venv is used when present (linux)', () => {
  const r = resolve({ existing: [posixVenv] });
  assert.strictEqual(r.command, posixVenv);
  assert.strictEqual(r.source, 'retrieval-service/.venv');
  assert.strictEqual(r.isFallback, false);
});

t('retrieval-service/.venv is used when present (windows)', () => {
  const r = resolve({ platform: 'win32', existing: [winVenv] });
  assert.strictEqual(r.command, winVenv);
  assert.strictEqual(r.source, 'retrieval-service/.venv');
});

t('the local venv beats an activated $VIRTUAL_ENV', () => {
  const r = resolve({
    env: { VIRTUAL_ENV: '/home/u/other' },
    existing: [posixVenv, '/home/u/other/bin/python'],
  });
  assert.strictEqual(r.command, posixVenv);
});

// --------------------------------------------------------------------------
console.log('\n== an activated $VIRTUAL_ENV is the third choice ==');

t('$VIRTUAL_ENV is used when its interpreter exists and no local venv does', () => {
  const r = resolve({
    env: { VIRTUAL_ENV: '/home/u/env' },
    existing: ['/home/u/env/bin/python'],
  });
  assert.strictEqual(r.command, '/home/u/env/bin/python');
  assert.strictEqual(r.source, '$VIRTUAL_ENV');
  assert.strictEqual(r.isFallback, false);
});

t('a $VIRTUAL_ENV whose interpreter is missing does not count', () => {
  const r = resolve({ env: { VIRTUAL_ENV: '/home/u/env' }, existing: [] });
  assert.strictEqual(r.isFallback, true);
});

// --------------------------------------------------------------------------
console.log('\n== PATH is the last resort, and it is flagged ==');

t('nothing found -> python3 on linux, marked as fallback', () => {
  const r = resolve({ existing: [] });
  assert.strictEqual(r.command, 'python3');
  assert.strictEqual(r.isFallback, true);
  assert.match(r.source, /PATH/);
});

t('nothing found -> python on windows, marked as fallback', () => {
  const r = resolve({ platform: 'win32', existing: [] });
  assert.strictEqual(r.command, 'python');
  assert.strictEqual(r.isFallback, true);
});

t('an empty CODENAWABS_PYTHON is ignored, not spawned', () => {
  const r = resolve({ env: { CODENAWABS_PYTHON: '   ' }, existing: [] });
  assert.strictEqual(r.command, 'python3');
  assert.strictEqual(r.isFallback, true);
});

// --------------------------------------------------------------------------
console.log('\n== venvInterpreter path shape ==');

t('posix venv layout', () => {
  assert.strictEqual(
    venvInterpreter('/x/.venv', 'linux', path.posix.join),
    '/x/.venv/bin/python',
  );
});

t('windows venv layout', () => {
  assert.strictEqual(
    venvInterpreter('C:\\x\\.venv', 'win32', path.win32.join),
    'C:\\x\\.venv\\Scripts\\python.exe',
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
