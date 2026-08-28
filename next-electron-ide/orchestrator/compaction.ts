/**
 * ============================================================================
 *  CONTEXT COMPACTION — decide when, and never lose the load-bearing facts
 * ============================================================================
 * Requirement: the system decides on its own when to compress, must recognise
 * when compaction is unavoidable to stay under a context limit, and must not
 * lose or misremember earlier information afterwards.
 *
 * TRIGGER — two thresholds against the ACTIVE model's real window, not a
 * constant. A fixed "compact every 20 messages" rule is wrong in both
 * directions: it compacts a tiny conversation on a 262k model for no reason,
 * and it sails past the limit on a 32k local model.
 *   SOFT (70%): compact opportunistically at a message boundary. Cheap, and
 *               it keeps the next call's prompt cost down — which matters
 *               because input tokens are billed on every single turn.
 *   HARD (88%): compact or the next call fails outright.
 *
 * WHAT SURVIVES — this is the part that makes it not lossy:
 *   1. The system prompt, verbatim.
 *   2. `pinnedFacts` — AGENTS.md rules, the task goal, file paths already
 *      modified, decisions taken. Re-injected VERBATIM as a system message
 *      after every compaction, so they cannot degrade through repeated
 *      summarisation. This is the concrete answer to "does a stated preference
 *      still hold after a compaction event".
 *   3. The last KEEP_RECENT messages, verbatim — recent tool results are what
 *      the model is actively reasoning about.
 *   4. Everything older becomes ONE summary message produced by a cheap model.
 *
 * WHY NOT DROP-OLDEST (the obvious cheap alternative): it silently loses the
 * decisions that explain why the code is in its current state, and the agent
 * then re-derives them wrongly. Summarising costs one small call; dropping
 * costs correctness. We pay the call.
 *
 * A tool-call/tool-result pair is never split across the boundary — most APIs
 * reject an assistant tool_call whose matching tool message is missing.
 */

import { ChatMessage, estimateMessageTokens, callModel, ToolCall } from './providers';
import { ModelEntry } from './models';

export const SOFT_THRESHOLD = 0.7;
export const HARD_THRESHOLD = 0.88;
const KEEP_RECENT = 6;

export type CompactionOutcome = {
  messages: ChatMessage[];
  beforeTokens: number;
  afterTokens: number;
  summarizedCount: number;
  preserved: string[];
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
};

export function shouldCompact(
  messages: ChatMessage[],
  model: ModelEntry
): { compact: boolean; forced: boolean; usedRatio: number } {
  const used = estimateMessageTokens(messages);
  const ratio = used / model.contextWindow;
  return { compact: ratio >= SOFT_THRESHOLD, forced: ratio >= HARD_THRESHOLD, usedRatio: ratio };
}

/**
 * Walk backwards from the tail and stop at a boundary that does not orphan a
 * tool result from the assistant message that requested it.
 */
function safeSplitIndex(messages: ChatMessage[], desiredKeep: number): number {
  let idx = Math.max(1, messages.length - desiredKeep);
  while (idx > 1 && messages[idx]?.role === 'tool') idx -= 1;
  return idx;
}

export async function compact(
  messages: ChatMessage[],
  activeModel: ModelEntry,
  summariserModel: ModelEntry,
  pinnedFacts: string[],
  env: Record<string, string>
): Promise<CompactionOutcome> {
  const beforeTokens = estimateMessageTokens(messages);

  const system = messages.find((m) => m.role === 'system');
  const splitAt = safeSplitIndex(messages, KEEP_RECENT);
  const older = messages.slice(system ? 1 : 0, splitAt);
  const recent = messages.slice(splitAt);

  if (older.length === 0) {
    return {
      messages,
      beforeTokens,
      afterTokens: beforeTokens,
      summarizedCount: 0,
      preserved: pinnedFacts,
      costUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  const transcript = older
    .map((m) => {
      if (m.role === 'assistant') {
        const calls = (m.toolCalls ?? []).map((c: ToolCall) => `${c.name}(${JSON.stringify(c.arguments).slice(0, 300)})`).join('; ');
        return `ASSISTANT: ${m.content ?? ''}${calls ? `\n  tool calls: ${calls}` : ''}`;
      }
      if (m.role === 'tool') return `TOOL[${m.name}]: ${m.content.slice(0, 1200)}`;
      return `${m.role.toUpperCase()}: ${m.content}`;
    })
    .join('\n');

  const summaryPrompt: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You compress an agent transcript so work can continue without re-reading it. ' +
        'Preserve with total fidelity: files read or modified and their exact paths, decisions made and why, ' +
        'commands run and their outcomes, errors encountered, and anything still outstanding. ' +
        'Drop only redundant restatement and superseded intermediate reasoning. ' +
        'Never invent detail. If a fact is uncertain, mark it uncertain rather than resolving it. ' +
        'Write compact prose under 400 words. No preamble.',
    },
    { role: 'user', content: `Compress this transcript:\n\n${transcript}` },
  ];

  let summaryText: string;
  let costUsd = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    const result = await callModel(summariserModel, summaryPrompt, [], env);
    summaryText = result.text.trim();
    costUsd = result.costUsd;
    promptTokens = result.promptTokens;
    completionTokens = result.completionTokens;
  } catch {
    // Summarising failed (provider down, rate limit). A forced compaction still
    // has to shed tokens or the next call dies, so fall back to a truncated
    // mechanical digest. Degraded, but honest about being degraded — and the
    // pinned facts below still survive intact, which is the part that matters.
    summaryText =
      '[Automatic summary unavailable — mechanical digest]\n' +
      older
        .map((m) => (m.role === 'tool' ? `tool ${m.name}: ${m.content.slice(0, 200)}` : `${m.role}: ${(m.role === 'assistant' ? m.content ?? '' : m.content).slice(0, 200)}`))
        .join('\n')
        .slice(0, 4000);
  }

  const rebuilt: ChatMessage[] = [];
  if (system) rebuilt.push(system);
  rebuilt.push({
    role: 'system',
    content: `[Compacted context] Earlier work on this subtask, summarised:\n${summaryText}`,
  });
  // Pinned facts go in AFTER the summary and verbatim, so they are never
  // paraphrased by a summariser and never drift across repeated compactions.
  if (pinnedFacts.length) {
    rebuilt.push({
      role: 'system',
      content:
        'These constraints remain in force and were NOT summarised — follow them exactly:\n' +
        pinnedFacts.map((f) => `- ${f}`).join('\n'),
    });
  }
  rebuilt.push(...recent);

  return {
    messages: rebuilt,
    beforeTokens,
    afterTokens: estimateMessageTokens(rebuilt),
    summarizedCount: older.length,
    preserved: pinnedFacts,
    costUsd,
    promptTokens,
    completionTokens,
  };
}
