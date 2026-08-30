/**
 * ============================================================================
 *  ENTRY POINT — newline-delimited JSON-RPC over stdio
 * ============================================================================
 * Spawned by electron/main.ts. Reads Commands from stdin, writes Events and
 * CommandReplies to stdout, one JSON object per line.
 *
 * stdout is RESERVED for protocol frames. Anything this process wants to say
 * for a human goes to stderr, which main.ts logs. A stray console.log here
 * would corrupt the stream — that is why there are none.
 *
 * The process holds at most one running task. The IDE is single-user and a
 * second concurrent task would contend for the same repository working tree,
 * which is a correctness problem, not a throughput opportunity: two agents
 * editing the same files with no coordination is exactly the "parallel agents
 * making conflicting changes" failure the PS asks about. Concurrency, if it
 * is ever added, belongs INSIDE a task (independent subtasks in the DAG), not
 * across tasks.
 */

import * as readline from 'readline';
import { Command, CommandReply, EventBody, OrchestratorEvent } from './protocol';
import { TaskStore } from './store';
import { TaskRunner } from './orchestrator';
import { callModel, ChatMessage } from './providers';
import { findModel, eligibleModels } from './models';

const dataDirArg = process.argv.indexOf('--data-dir');
const DATA_DIR = dataDirArg >= 0 ? process.argv[dataDirArg + 1] : process.cwd();

let current: { runner: TaskRunner; taskId: string; store: TaskStore } | null = null;

function write(obj: OrchestratorEvent | CommandReply): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function reply(id: string, ok: boolean, error?: string, data?: unknown): void {
  write({ kind: 'reply', id, ok, error, data });
}

function log(message: string): void {
  process.stderr.write(`[orchestrator] ${message}\n`);
}

function makeEmitter(taskId: string, store: TaskStore) {
  return (body: EventBody) => {
    const event: OrchestratorEvent = { kind: 'event', taskId, seq: store.nextSeq(), ts: Date.now(), ...body };
    store.appendEvent(event);
    write(event);
  };
}

/** Mirrors an approved command into the IDE's visible terminal panel. */
function echoToTerminal(taskId: string, store: TaskStore) {
  return (command: string) => {
    const event: OrchestratorEvent = {
      kind: 'event',
      taskId,
      seq: store.nextSeq(),
      ts: Date.now(),
      type: 'log',
      level: 'info',
      message: `$ ${command}`,
    };
    store.appendEvent(event);
    write(event);
  };
}

async function handle(cmd: Command): Promise<void> {
  switch (cmd.type) {
    case 'ping':
      reply(cmd.id, true, undefined, { pid: process.pid, models: eligibleModels().length });
      return;

    case 'start_task': {
      if (current) {
        reply(cmd.id, false, 'A task is already running. Cancel it first.');
        return;
      }
      const store = new TaskStore(DATA_DIR, cmd.config.codebaseId, cmd.taskId);
      const runner = new TaskRunner(
        cmd.taskId,
        cmd.prompt,
        cmd.config,
        store,
        makeEmitter(cmd.taskId, store),
        echoToTerminal(cmd.taskId, store),
        null
      );
      current = { runner, taskId: cmd.taskId, store };
      reply(cmd.id, true);
      // Run detached from the reply so the control channel stays responsive
      // for cancel and approval_response while the task is in flight.
      runner
        .run(false)
        .catch((err) => log(`task ${cmd.taskId} threw: ${err?.stack ?? err}`))
        .finally(() => {
          if (current?.taskId === cmd.taskId) current = null;
        });
      return;
    }

    case 'resume_task': {
      if (current) {
        reply(cmd.id, false, 'A task is already running.');
        return;
      }
      const store = new TaskStore(DATA_DIR, cmd.config.codebaseId, cmd.taskId);
      const snapshot = store.loadSnapshot();
      if (!snapshot) {
        reply(cmd.id, false, `No checkpoint found for task ${cmd.taskId}.`);
        return;
      }
      const runner = new TaskRunner(
        cmd.taskId,
        snapshot.prompt,
        cmd.config,
        store,
        makeEmitter(cmd.taskId, store),
        echoToTerminal(cmd.taskId, store),
        snapshot
      );
      current = { runner, taskId: cmd.taskId, store };
      reply(cmd.id, true, undefined, { resumedFromStep: snapshot.step });
      runner
        .run(true)
        .catch((err) => log(`resume ${cmd.taskId} threw: ${err?.stack ?? err}`))
        .finally(() => {
          if (current?.taskId === cmd.taskId) current = null;
        });
      return;
    }

    case 'revert_latest': {
      if (current) {
        reply(cmd.id, false, 'Stop or finish the running task before reverting a workspace change.');
        return;
      }
      const store = new TaskStore(DATA_DIR, cmd.codebaseId, cmd.taskId);
      const snapshot = store.loadSnapshot();
      if (!snapshot) {
        reply(cmd.id, false, `No checkpoint found for task ${cmd.taskId}.`);
        return;
      }
      try {
        const change = store.revertLatestFileChange(snapshot.rootPath);
        if (!change) {
          reply(cmd.id, false, 'No tracked file change is available to revert.');
          return;
        }
        const emit = makeEmitter(cmd.taskId, store);
        emit({ type: 'workspace_reverted', changeId: change.changeId, path: change.path });
        reply(cmd.id, true, undefined, { changeId: change.changeId, path: change.path });
      } catch (err) {
        reply(cmd.id, false, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    case 'cancel_task':
      if (current?.taskId === cmd.taskId) {
        current.runner.cancel();
        reply(cmd.id, true);
      } else {
        reply(cmd.id, false, 'No such running task.');
      }
      return;

    case 'approval_response':
      if (!current) {
        reply(cmd.id, false, 'No running task to approve for.');
        return;
      }
      current.runner.resolveApproval(cmd.decision);
      reply(cmd.id, true);
      return;

    case 'isolated_query': {
      // `/bytheway`: genuinely isolated. It builds its own two-message
      // conversation, passes no tools, and never touches `current` — so it
      // cannot read or contaminate a running task's history in either
      // direction. Isolation here is structural, not a convention.
      const model =
        cmd.config.enabledModelIds.map((id) => findModel(id)).find((m) => m && eligibleModels().some((e) => e.id === m.id)) ??
        eligibleModels()[0];
      if (!model) {
        reply(cmd.id, false, 'No eligible model is enabled. Open Agent -> Settings.');
        return;
      }
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Answer directly and concisely. You have no project context and no tools.' },
        { role: 'user', content: cmd.question },
      ];
      try {
        const result = await callModel(model, messages, [], cmd.config.env);
        reply(cmd.id, true, undefined, {
          answer: result.text,
          modelId: model.id,
          costUsd: result.costUsd,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
        });
      } catch (err) {
        reply(cmd.id, false, err instanceof Error ? err.message : String(err));
      }
      return;
    }
  }
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let cmd: Command;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    log(`unparseable command line: ${trimmed.slice(0, 200)}`);
    return;
  }
  handle(cmd).catch((err) => {
    log(`handler threw: ${err?.stack ?? err}`);
    if ('id' in cmd && typeof cmd.id === 'string') {
      reply(cmd.id, false, err instanceof Error ? err.message : String(err));
    }
  });
});

// Main closed the pipe: the IDE is going away. Exit rather than lingering as
// an orphan holding the user's repository open.
rl.on('close', () => process.exit(0));

process.on('uncaughtException', (err) => {
  log(`uncaught: ${err?.stack ?? err}`);
  // Do not exit. A task's checkpoint is on disk; staying alive lets the user
  // see the failure and resume, where dying loses the control channel too.
});

write({ kind: 'event', taskId: '', seq: 0, ts: Date.now(), type: 'ready' });
log(`ready, data dir ${DATA_DIR}, ${eligibleModels().length} eligible models`);
