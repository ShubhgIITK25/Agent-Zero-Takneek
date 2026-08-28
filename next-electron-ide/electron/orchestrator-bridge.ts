/**
 * ============================================================================
 *  ORCHESTRATOR BRIDGE — main process side of the stdio channel
 * ============================================================================
 * Owns the child process lifecycle and translates between two worlds:
 *   renderer  <-- ipcMain/webContents -->  main  <-- stdio JSON-RPC -->  child
 *
 * Three things this file is responsible for and that are easy to get wrong:
 *
 * 1. SPAWNING WITHOUT A SYSTEM NODE. We launch `process.execPath` (the Electron
 *    binary) with ELECTRON_RUN_AS_NODE=1, which makes it behave as a plain
 *    Node runtime. This is why the packaged app does not require the user to
 *    have Node installed — unlike the Python retrieval service, which does
 *    need an interpreter. Same reason `orchestrator-dist` is plain CommonJS.
 *
 * 2. THE WATCHDOG. EOF on stdout means the child is gone. We restart it (with
 *    backoff, capped) so the IDE keeps working, and we tell the renderer, so a
 *    task that was mid-flight can be resumed from its checkpoint rather than
 *    silently appearing to hang. An unbounded restart loop on a child that
 *    crashes at startup would spin the CPU forever, hence MAX_RESTARTS.
 *
 * 3. NOT HANGING ON A PENDING APPROVAL. If the child dies while the UI is
 *    waiting for an Approve/Reject, or the window closes while the child waits
 *    for one, both sides must unwind. Command promises are rejected on death;
 *    the child's own cancel path resolves its pending approvals.
 */

import { BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

type PendingCommand = { resolve: (v: any) => void; reject: (e: Error) => void };

const MAX_RESTARTS = 5;

export class OrchestratorBridge {
  private child: ChildProcess | null = null;
  private pending = new Map<string, PendingCommand>();
  private counter = 0;
  private restarts = 0;
  private ready = false;
  private deliberateStop = false;

  constructor(
    private scriptPath: string,
    private dataDir: string,
    private getWindow: () => BrowserWindow | null
  ) {}

  private send(target: string, payload: unknown): void {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(target, payload);
  }

  start(): void {
    if (this.child) return;
    this.deliberateStop = false;

    // turns electron binary into a plain node runtime, so no separate node installation is needed on the user's machine
    const child = spawn(process.execPath, [this.scriptPath, '--data-dir', this.dataDir], {
      // Turns the Electron binary into a plain Node runtime, so no separate
      // Node installation is needed on the user's machine.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => this.onLine(line));
    }
    child.stderr?.on('data', (d) => console.log(`[orchestrator] ${d.toString().trim()}`));

    child.on('error', (err) => {
      console.log('[orchestrator] spawn failed:', err);
      this.ready = false;
      this.send('orchestrator:status', { state: 'unavailable', message: String(err) });
    });

    child.on('exit', (code, signal) => {
      this.ready = false;
      this.child = null;
      // Anything still waiting on a reply will never get one.
      for (const [, p] of this.pending) p.reject(new Error('orchestrator process exited'));
      this.pending.clear();

      if (this.deliberateStop) return;

      console.log(`[orchestrator] exited (code ${code}, signal ${signal})`);
      if (this.restarts < MAX_RESTARTS) {
        this.restarts += 1;
        const delay = Math.min(1000 * this.restarts, 5000);
        this.send('orchestrator:status', {
          state: 'restarting',
          message: `Orchestrator exited unexpectedly. Restarting (${this.restarts}/${MAX_RESTARTS})…`,
        });
        setTimeout(() => this.start(), delay);
      } else {
        this.send('orchestrator:status', {
          state: 'unavailable',
          message: 'Orchestrator crashed repeatedly and was not restarted. Check the console for its stderr output.',
        });
      }
    });
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // never let a malformed frame take the bridge down
    }

    if (msg.kind === 'reply') {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.data ?? null);
        else p.reject(new Error(msg.error ?? 'orchestrator command failed'));
      }
      return;
    }

    if (msg.kind === 'event') {
      if (msg.type === 'ready') {
        this.ready = true;
        this.restarts = 0;
        this.send('orchestrator:status', { state: 'ready' });
        return;
      }
      // Everything else is trace data the dashboard renders.
      this.send('orchestrator:event', msg);
    }
  }

  private command(type: string, payload: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin) {
        reject(new Error('Orchestrator is not running.'));
        return;
      }
      const id = `c${++this.counter}`;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ kind: 'command', type, id, ...payload }) + '\n');

      // A command that never gets a reply would leak a promise and a UI
      // spinner forever. Time it out and clean up.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Orchestrator did not answer "${type}" within 30s.`));
        }
      }, 30_000);
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  startTask(taskId: string, prompt: string, config: unknown) {
    return this.command('start_task', { taskId, prompt, config });
  }
  resumeTask(taskId: string, config: unknown) {
    return this.command('resume_task', { taskId, config });
  }
  cancelTask(taskId: string) {
    return this.command('cancel_task', { taskId });
  }
  respondToApproval(decision: unknown) {
    return this.command('approval_response', { decision });
  }
  isolatedQuery(question: string, config: unknown) {
    return this.command('isolated_query', { question, config });
  }
  ping() {
    return this.command('ping', {});
  }

  stop(): void {
    this.deliberateStop = true;
    try {
      this.child?.stdin?.end();
      this.child?.kill();
    } catch {
      // already gone
    }
    this.child = null;
    this.ready = false;
  }
}

export function orchestratorScriptPath(isDev: boolean): string {
  // Dev: compiled next to electron-dist/. Packaged: inside the asar app dir.
  return isDev
    ? path.join(__dirname, '..', 'orchestrator-dist', 'index.js')
    : path.join(__dirname, '..', 'orchestrator-dist', 'index.js');
}
