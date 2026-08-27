/**
 * ============================================================================
 *  AGENT LOOP — real orchestration; the only unfinished piece is llm.ts
 * ============================================================================
 * This drives an actual multi-step tool-use conversation: it calls
 * `callLLM` (src/lib/llm.ts), and if the model asks to use a tool, it looks
 * the tool up in tools.ts, gates side-effecting ones behind human approval
 * (via the `requestApproval` callback ChatPanel provides), executes it, and
 * feeds the result back to the model — repeating until the model returns a
 * plain-text answer or a stop condition trips.
 *
 * What IS implemented here (genuinely, not a stub):
 *   - Multi-step tool-calling loop with conversation state
 *   - Human-in-the-loop approval gate before any side-effecting tool runs
 *   - A step-limit guard (MAX_STEPS) and a same-call-repeated-3x loop guard
 *     — a minimal version of the PS's "detect stuck/looping tasks" ask
 *   - `/bytheway`: a genuinely isolated call — fresh system+user messages
 *     only, no access to the running session's history or tools — that
 *     does NOT touch or get appended to the main conversation
 *   - Codebase-aware RETRIEVAL: retrieve_context/open_file (tools.ts) hit
 *     the separate retrieval-service/ process — real tree-sitter AST
 *     chunking, BM25 + vector recall, 1-hop call-graph expansion, and
 *     reranking, isolated per project via codebase_id (see
 *     retrieval-service/server.py). The system prompt below steers the
 *     model to reach for retrieve_context first, since it returns a few
 *     relevant snippets instead of whole files — read_file/list_dir still
 *     exist for when the model already knows the exact absolute path it
 *     wants (e.g. a file it just wrote itself).
 *
 * What is explicitly NOT implemented — designed on purpose to stay out of
 * scope here, not overlooked:
 *   - Model/provider ROUTING (always calls whatever llm.ts is wired to)
 *   - Context COMPACTION (history just grows; nothing trims/summarizes it)
 *   - Multi-agent decomposition (this is one loop, one model, one role)
 *   - Session persistence across app restarts (AgentSession lives in memory
 *     only — closing the chat panel loses it)
 *   - AGENTS.md discovery/enforcement
 * Each of those is real design work the PS explicitly wants justified, not
 * defaulted — see README.md's "Notes for your Takneek build".
 */

import { callLLM, LLMMessage, LLMToolCall } from './llm';
import { findTool, TOOL_SCHEMAS } from './tools';

const MAX_STEPS = 8;
const MAX_IDENTICAL_REPEATS = 3;

export type AgentContext = {
  rootPath: string | null;
  activeFilePath: string | null;
  activeFileContent: string | null;
};

export type AgentEvent =
  | { type: 'tool-start'; call: LLMToolCall; sideEffecting: boolean }
  | { type: 'tool-result'; call: LLMToolCall; result: string; outcome: 'done' | 'rejected' | 'error' }
  | { type: 'assistant-text'; text: string }
  | { type: 'error'; message: string };

export type AgentCallbacks = {
  onEvent: (event: AgentEvent) => void;
  /** Resolve true to run a side-effecting tool call, false to skip it. */
  requestApproval: (call: LLMToolCall) => Promise<boolean>;
  runInTerminal: (command: string) => void;
  notifyFileChanged: (path: string) => void;
};

function buildSystemPrompt(): string {
  return (
    'You are a coding agent embedded in a desktop IDE. You have tools to search ' +
    'and read the open codebase, write and delete files, list directories, and ' +
    'run shell commands in the integrated terminal.\n\n' +
    'To find relevant code, call retrieve_context first — it searches the whole ' +
    'project and returns a handful of relevant snippets, not entire files. Only ' +
    'call open_file (or read_file for a path you already know) as a deliberate ' +
    'follow-up when a snippet genuinely is not enough — dumping whole files into ' +
    'context by default wastes tokens you do not have to spare.\n\n' +
    'Explain what you are about to do before calling a tool that writes, deletes, ' +
    'or runs a command — those require the user to approve them.'
  );
}

function contextMessage(context: AgentContext): LLMMessage | null {
  const parts: string[] = [];
  if (context.rootPath) parts.push(`Open project folder: ${context.rootPath}`);
  if (context.activeFilePath) {
    parts.push(`Active file: ${context.activeFilePath}`);
    if (context.activeFileContent != null) {
      parts.push(`Active file content:\n\`\`\`\n${context.activeFileContent}\n\`\`\``);
    }
  }
  if (parts.length === 0) return null;
  return { role: 'system', content: parts.join('\n\n') };
}

async function getEnv(): Promise<Record<string, string>> {
  if (typeof window === 'undefined' || !window.electronAPI) return {};
  const settings = await window.electronAPI.settingsGet();
  return settings.envVars;
}

export class AgentSession {
  private history: LLMMessage[] = [{ role: 'system', content: buildSystemPrompt() }];

  /** Runs one user turn to completion: possibly several tool round-trips. */
  async sendMessage(userText: string, context: AgentContext, callbacks: AgentCallbacks): Promise<void> {
    const ctxMsg = contextMessage(context);
    if (ctxMsg) this.history.push(ctxMsg);
    this.history.push({ role: 'user', content: userText });

    const env = await getEnv();
    let lastSignature = '';
    let repeatCount = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      let response;
      try {
        response = await callLLM(this.history, TOOL_SCHEMAS, env);
      } catch (err) {
        callbacks.onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        return;
      }

      if (response.kind === 'text') {
        this.history.push({ role: 'assistant', content: response.text });
        callbacks.onEvent({ type: 'assistant-text', text: response.text });
        return;
      }

      this.history.push({ role: 'assistant', content: null, toolCalls: response.calls });

      for (let i = 0; i < response.calls.length; i++) {
        const call = response.calls[i];
        const signature = `${call.name}:${JSON.stringify(call.arguments)}`;
        repeatCount = signature === lastSignature ? repeatCount + 1 : 1;
        lastSignature = signature;

        if (repeatCount >= MAX_IDENTICAL_REPEATS) {
          // Most LLM APIs require every tool_call in an assistant message to
          // have a matching tool-role response before the next request —
          // fill in placeholders for this call and any later ones in the
          // same batch we're skipping, so a real callLLM() implementation
          // doesn't choke on a dangling tool_call the next time this
          // session is used (aborting mid-batch would otherwise leave them
          // unanswered).
          for (const skipped of response.calls.slice(i)) {
            const content = 'Skipped: loop guard tripped before this call could run.';
            this.history.push({ role: 'tool', toolCallId: skipped.id, content });
            callbacks.onEvent({ type: 'tool-start', call: skipped, sideEffecting: findTool(skipped.name)?.sideEffecting ?? false });
            callbacks.onEvent({ type: 'tool-result', call: skipped, result: content, outcome: 'error' });
          }
          callbacks.onEvent({
            type: 'error',
            message: `Stopped: the agent called ${call.name} with identical arguments ${MAX_IDENTICAL_REPEATS} times in a row — likely stuck in a loop.`,
          });
          return;
        }

        const tool = findTool(call.name);

        // Emit tool-start unconditionally (even for an unknown tool) so the
        // UI always has a bubble to attach the matching tool-result to —
        // otherwise an unknown-tool error would resolve against nothing and
        // silently vanish instead of being shown.
        callbacks.onEvent({ type: 'tool-start', call, sideEffecting: tool?.sideEffecting ?? false });

        if (!tool) {
          const content = `Unknown tool "${call.name}". Available tools: ${TOOL_SCHEMAS.map((t) => t.name).join(', ')}.`;
          this.history.push({ role: 'tool', toolCallId: call.id, content });
          callbacks.onEvent({ type: 'tool-result', call, result: content, outcome: 'error' });
          continue;
        }

        if (tool.sideEffecting) {
          const approved = await callbacks.requestApproval(call);
          if (!approved) {
            const content = 'User rejected this action.';
            this.history.push({ role: 'tool', toolCallId: call.id, content });
            callbacks.onEvent({ type: 'tool-result', call, result: content, outcome: 'rejected' });
            continue;
          }
        }

        try {
          const result = await tool.execute(call.arguments, {
            rootPath: context.rootPath,
            runInTerminal: callbacks.runInTerminal,
            notifyFileChanged: callbacks.notifyFileChanged,
          });
          this.history.push({ role: 'tool', toolCallId: call.id, content: result });
          callbacks.onEvent({ type: 'tool-result', call, result, outcome: 'done' });
        } catch (err) {
          const message = `Error: ${err instanceof Error ? err.message : String(err)}`;
          this.history.push({ role: 'tool', toolCallId: call.id, content: message });
          callbacks.onEvent({ type: 'tool-result', call, result: message, outcome: 'error' });
        }
      }
      // Loop back and call the model again with the tool results appended.
    }

    callbacks.onEvent({
      type: 'error',
      message: `Stopped after ${MAX_STEPS} tool-calling steps without a final answer (step-limit guard).`,
    });
  }
}

/**
 * `/bytheway` — an isolated, zero-context aside. Deliberately bypasses
 * AgentSession entirely: no tools, no history, no system prompt beyond
 * "answer directly." Nothing here reads or writes the caller's session.
 */
export async function runIsolatedQuery(question: string): Promise<string> {
  const env = await getEnv();
  const response = await callLLM(
    [
      { role: 'system', content: 'Answer directly and concisely. You have no project context and no tools.' },
      { role: 'user', content: question },
    ],
    [],
    env
  );
  return response.kind === 'text' ? response.text : '(model returned tool calls in an isolated query — ignored)';
}
