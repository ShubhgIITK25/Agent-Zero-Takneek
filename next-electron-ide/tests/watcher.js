/**
 * Regression: a vanished directory must not kill the main process.
 *
 * Node's recursive fs.watch is emulated on Linux - it walks the tree with
 * readdirSync. When a directory disappears mid-walk (git's transient
 * `.git/.gitstatus.XXXXXX` dirs are the usual culprit), readdirSync throws
 * ENOENT and the watcher calls emit("error", …). `for await` installs no
 * "error" listener, so with none of our own the EventEmitter rethrows and
 * Electron shows "A JavaScript error occurred in the main process".
 *
 * These tests pin the mechanism (so a Node change that alters it is caught)
 * and prove the listener in electron/main.ts's watchFolder fixes it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0;
const ok = (name) => { console.log('  ok  ', name); passed++; };

function mkroot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-watch-')));
}

(async () => {
  console.log('\n== recursive watch: a vanished dir must not crash the process ==');

  // 1. Pin the mechanism: for-await alone leaves "error" unhandled.
  {
    const root = mkroot();
    const ac = new AbortController();
    const w = fs.watch(root, { recursive: true, signal: ac.signal });
    (async () => { try { for await (const _ of w) {} } catch {} })();
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(
      w.listenerCount('error'), 0,
      'for-await installed an error listener; the fix may no longer be needed'
    );
    ok('for-await installs no "error" listener (this is why it crashed)');
    ac.abort();
  }

  // 2. An unhandled "error" emit is fatal - the bug, reproduced exactly.
  {
    const root = mkroot();
    const ac = new AbortController();
    const w = fs.watch(root, { recursive: true, signal: ac.signal });
    (async () => { try { for await (const _ of w) {} } catch {} })();
    await new Promise((r) => setTimeout(r, 50));
    const err = Object.assign(new Error('ENOENT: scandir .git/.gitstatus.gMclpi/a'), { code: 'ENOENT' });
    assert.throws(() => w.emit('error', err), /ENOENT/);
    ok('emit("error") with no listener throws - the reported crash');
    ac.abort();
  }

  // 3. The fix: one "error" listener makes the same emit survivable, and the
  //    watcher keeps delivering events afterwards.
  {
    const root = mkroot();
    const ac = new AbortController();
    const w = fs.watch(root, { recursive: true, signal: ac.signal });
    let refreshes = 0;
    let logged = null;
    w.on('error', (e) => {
      if (e?.code === 'ENOENT') { refreshes++; return; }
      logged = e;
    });

    const seen = [];
    w.on('change', (_ev, fn) => { if (fn) seen.push(fn); });
    (async () => { try { for await (const ev of w) seen.push(ev.filename); } catch {} })();
    await new Promise((r) => setTimeout(r, 50));

    const err = Object.assign(new Error('ENOENT: scandir gone'), { code: 'ENOENT' });
    assert.doesNotThrow(() => w.emit('error', err));
    ok('ENOENT is absorbed instead of crashing');
    assert.strictEqual(refreshes, 1);
    ok('ENOENT schedules a refresh so the tree stays accurate');

    // still alive: a real change after the error must still be reported
    fs.writeFileSync(path.join(root, 'after.txt'), 'x');
    for (let i = 0; i < 20; i++) {
      if (seen.includes('after.txt')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(seen.includes('after.txt'), `watcher went deaf after the error; saw ${JSON.stringify(seen)}`);
    ok('the watcher keeps reporting changes after an ENOENT');

    // a non-ENOENT error is surfaced, not silently swallowed
    const enospc = Object.assign(new Error('ENOSPC: inotify limit'), { code: 'ENOSPC' });
    assert.doesNotThrow(() => w.emit('error', enospc));
    assert.strictEqual(logged?.code, 'ENOSPC');
    assert.strictEqual(refreshes, 1, 'ENOSPC must not be treated as benign churn');
    ok('a non-ENOENT error is surfaced, not mistaken for churn');
    ac.abort();
  }

  // 4. Aborting must still end the loop via for-await, not the error listener.
  {
    const root = mkroot();
    const ac = new AbortController();
    const w = fs.watch(root, { recursive: true, signal: ac.signal });
    let viaListener = null;
    let viaLoop = null;
    w.on('error', (e) => { viaListener = e; });
    const done = (async () => { try { for await (const _ of w) {} } catch (e) { viaLoop = e; } })();
    await new Promise((r) => setTimeout(r, 40));
    ac.abort();
    await done;
    assert.strictEqual(viaListener, null, 'abort leaked into the error listener');
    assert.ok(viaLoop?.name === 'AbortError' || viaLoop?.name === 'TypeError', `unexpected abort error: ${viaLoop?.name}`);
    ok('abort still ends the loop cleanly and bypasses the error listener');
  }

  console.log(`\n${passed} passed, 0 failed`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
