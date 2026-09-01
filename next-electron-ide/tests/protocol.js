/**
 * End-to-end smoke test of the stdio JSON-RPC channel.
 *   npm run build:orchestrator && node tests/protocol.js
 *
 * Spawns the orchestrator exactly the way electron/main.ts does and drives the
 * real protocol: handshake -> ping -> start_task. The task is started with an
 * EMPTY model roster on purpose - the assertion is that this fails gracefully
 * with a visible intervention and a written checkpoint, rather than hanging or
 * crashing the process. Silent hangs are the failure mode that matters here.
 */
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const os = require('os');

const script = path.join(__dirname, '..', 'orchestrator-dist', 'index.js');
const dataDir = path.join(os.tmpdir(), 'codenawabs-protocol-test');

const child = spawn(process.execPath, [script, '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
const rl = readline.createInterface({ input: child.stdout });
const seen = [];
let finished = false;

const finish = (ok, why) => {
  if (finished) return;
  finished = true;
  console.log(ok ? `\n  PASS: ${why}` : `\n  FAIL: ${why}`);
  child.kill();
  process.exit(ok ? 0 : 1);
};

rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    console.log('  UNPARSEABLE FRAME:', line.slice(0, 120));
    return finish(false, 'orchestrator wrote a non-JSON line to stdout (stdout is reserved for protocol frames)');
  }
  seen.push(m);
  console.log('  <-', m.kind, m.kind === 'event' ? m.type : m.ok ? 'ok' : 'err: ' + m.error);

  if (m.kind === 'event' && m.type === 'ready') {
    child.stdin.write(JSON.stringify({ kind: 'command', type: 'ping', id: 'c1' }) + '\n');
  }
  if (m.kind === 'reply' && m.id === 'c1') {
    console.log('     pid', m.data.pid, '| eligible models', m.data.models);
    child.stdin.write(
      JSON.stringify({
        kind: 'command',
        type: 'start_task',
        id: 'c2',
        taskId: 't1',
        prompt: 'hello',
        config: {
          rootPath: os.tmpdir(),
          codebaseId: 'test',
          retrievalUrl: null,
          env: {},
          enabledModelIds: [],
          maxCostUsd: 0.5,
          maxSeconds: 2700,
        },
      }) + '\n'
    );
  }
  if (m.kind === 'reply' && m.id === 'c2') {
    setTimeout(() => {
      const types = seen.filter((x) => x.kind === 'event').map((x) => x.type);
      console.log('\n  event types seen:', types.join(', '));
      const ok =
        types.includes('ready') &&
        types.includes('task_started') &&
        types.includes('intervention') &&
        types.includes('checkpoint') &&
        types.includes('task_failed');
      finish(ok, ok ? 'handshake, task lifecycle, visible intervention and checkpoint all work' : 'unexpected event sequence');
    }, 2500);
  }
});

child.stderr.on('data', (d) => console.log('  [stderr]', d.toString().trim()));
setTimeout(() => finish(false, 'timed out waiting for the orchestrator'), 20000);
