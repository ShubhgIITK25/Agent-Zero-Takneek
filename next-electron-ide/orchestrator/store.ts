/**
 * ============================================================================
 *  CHECKPOINT STORE — append-only event log + snapshot, per task
 * ============================================================================
 * Layout, under Electron's userData dir (outside any project folder, so a
 * task's trace never lands inside the user's repo):
 *
 *   tasks/<codebaseId>/<taskId>/events.jsonl   append-only, one event per line
 *   tasks/<codebaseId>/<taskId>/state.json     latest snapshot, atomically replaced
 *
 * Why an append-only JSONL log rather than a table in SQLite:
 *   - Crash safety comes for free. A partially-written last line is detectable
 *     (it will not parse) and discardable; every line before it is intact.
 *     A torn write in the middle of a B-tree page is not similarly forgiving.
 *   - The dashboard wants exactly this shape anyway: an ordered event stream
 *     it replays. No query planner needed, no schema migration when a new
 *     event type is added.
 *   - Zero native dependencies. better-sqlite3 would need an Electron ABI
 *     rebuild on three platforms; this needs fs.
 * The trade-off we accept: no indexed queries across tasks. That is fine
 * because the access pattern is always "one task, in order". If cross-task
 * analytics is ever wanted, the log is trivially importable into anything.
 *
 * `state.json` is written with write-temp-then-rename, which is atomic on both
 * POSIX and NTFS — so a crash mid-checkpoint leaves the PREVIOUS good snapshot
 * rather than a truncated one. That property is what makes resume trustworthy.
 */

import * as fs from 'fs';
import * as path from 'path';
import { OrchestratorEvent, Subtask } from './protocol';
import { ChatMessage } from './providers';

export type TaskSnapshot = {
  taskId: string;
  codebaseId: string;
  rootPath: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  step: number;
  status: 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  subtasks: Subtask[];
  /** Per-subtask conversation, so a resume restarts mid-subtask, not mid-task. */
  conversations: Record<string, ChatMessage[]>;
  costUsd: number;
  elapsedSeconds: number;
  /** Facts compaction must never drop. Rebuilt into every compacted context. */
  pinnedFacts: string[];
  agentsMd: string | null;
  summary?: string;
};

export class TaskStore {
  private dir: string;
  private eventsPath: string;
  private statePath: string;
  private seq = 0;

  constructor(dataDir: string, codebaseId: string, readonly taskId: string) {
    this.dir = path.join(dataDir, 'tasks', codebaseId, taskId);
    this.eventsPath = path.join(this.dir, 'events.jsonl');
    this.statePath = path.join(this.dir, 'state.json');
    fs.mkdirSync(this.dir, { recursive: true });
    // Continue the sequence across a resume so the renderer's gap detection
    // does not see a phantom rewind after a crash.
    this.seq = this.countExistingEvents();
  }

  private countExistingEvents(): number {
    try {
      const raw = fs.readFileSync(this.eventsPath, 'utf8');
      return raw.split('\n').filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  appendEvent(event: OrchestratorEvent): void {
    try {
      fs.appendFileSync(this.eventsPath, JSON.stringify(event) + '\n', 'utf8');
    } catch {
      // Losing a trace line must never kill a running task. The event still
      // reaches the UI over stdio; only the post-hoc replay loses this row.
    }
  }

  /** Reads the log back for post-completion inspection, skipping a torn tail. */
  readEvents(): OrchestratorEvent[] {
    try {
      const raw = fs.readFileSync(this.eventsPath, 'utf8');
      const out: OrchestratorEvent[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // Torn final line from a crash — everything before it is still good.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Atomic: temp file then rename, so a crash never leaves a half state.json. */
  saveSnapshot(snapshot: TaskSnapshot): void {
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    fs.renameSync(tmp, this.statePath);
  }

  loadSnapshot(): TaskSnapshot | null {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as TaskSnapshot;
    } catch {
      return null;
    }
  }

  static listTasks(dataDir: string, codebaseId: string): TaskSnapshot[] {
    const base = path.join(dataDir, 'tasks', codebaseId);
    let ids: string[];
    try {
      ids = fs.readdirSync(base);
    } catch {
      return [];
    }
    const out: TaskSnapshot[] = [];
    for (const id of ids) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(base, id, 'state.json'), 'utf8')));
      } catch {
        // A task directory with no readable snapshot (crashed before first
        // checkpoint) is simply not resumable — skip it rather than fail.
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  static readEventsFor(dataDir: string, codebaseId: string, taskId: string): OrchestratorEvent[] {
    const p = path.join(dataDir, 'tasks', codebaseId, taskId, 'events.jsonl');
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const out: OrchestratorEvent[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          /* torn tail */
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}
