/**
 * ============================================================================
 *  PROVIDER CLIENTS — OpenAI-compatible path, Ollama path, Gemini path
 * ============================================================================
 * Groq and OpenRouter both speak OpenAI's /chat/completions with the same
 * tool-calling shape, so they share a client and differ only in base URL,
 * auth header, and a couple of extra headers OpenRouter wants. Ollama's
 * /api/chat is close but not identical (no `tool_call_id`, different token
 * accounting fields), so it gets its own small adapter. Gemini's
 * generateContent REST API has a fundamentally different message format
 * (`contents` with `parts`, `systemInstruction` as a top-level field,
 * `functionResponse` instead of `role: tool`), so it also gets its own
 * adapter rather than a pile of conditionals inside one function.
 *
 * Everything returns the same `LLMResult`, so router.ts and agents.ts never
 * branch on provider.
 *
 * Failure classification matters more than it looks: the router needs to tell
 * "this provider is rate-limited, try another one" (retryable elsewhere) from
 * "this request was malformed" (retrying anywhere is pointless). That is what
 * `ProviderError.retryable` and `.rateLimited` carry.
 */

import { ModelEntry, costOf } from './models';

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Opaque blob Gemini 3.x attaches to a functionCall part (JSON field
   *  `thoughtSignature`). Must be round-tripped verbatim in history or the model
   *  returns a 400 "Function call is missing a thought_signature". */
  _geminiThoughtSignature?: string;
};

export type ToolSchema = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type LLMResult = {
  text: string;
  toolCalls: ToolCall[];
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
};

export class ProviderError extends Error {
  retryable: boolean;
  rateLimited: boolean;
  status?: number;
  constructor(message: string, opts: { retryable: boolean; rateLimited: boolean; status?: number }) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = opts.retryable;
    this.rateLimited = opts.rateLimited;
    this.status = opts.status;
  }
}

/**
 * Rough token estimate used for routing decisions and compaction triggers
 * BEFORE a call happens (when no usage numbers exist yet). ~3.6 chars/token is
 * a reasonable average for source code, which is denser than prose. Actual
 * accounting always uses the provider's reported usage, never this.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export function estimateMessageTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (m.role === 'assistant') {
      total += estimateTokens(m.content ?? '');
      for (const c of m.toolCalls ?? []) total += estimateTokens(JSON.stringify(c.arguments)) + 8;
    } else {
      total += estimateTokens(m.content);
    }
    total += 4; // per-message envelope overhead
  }
  return total;
}

const REQUEST_TIMEOUT_MS = 90_000;

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A network failure or timeout is retryable on ANOTHER provider — the
    // request itself was fine, this endpoint just did not answer.
    throw new ProviderError(`network error contacting ${url}: ${msg}`, { retryable: true, rateLimited: false });
  } finally {
    clearTimeout(timer);
  }
}

function classifyHttp(status: number, text: string): ProviderError {
  if (status === 429) {
    return new ProviderError(`rate limited (429): ${text.slice(0, 200)}`, { retryable: true, rateLimited: true, status });
  }
  if (status === 401 || status === 403) {
    return new ProviderError(`auth failed (${status}) — check the API key in Settings`, { retryable: false, rateLimited: false, status });
  }
  if (status >= 500) {
    return new ProviderError(`provider error (${status}): ${text.slice(0, 200)}`, { retryable: true, rateLimited: false, status });
  }
  // 4xx other than the above means we built a bad request. Retrying the same
  // payload on a different provider will fail identically — do not mask it.
  return new ProviderError(`bad request (${status}): ${text.slice(0, 300)}`, { retryable: false, rateLimited: false, status });
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (Groq, OpenRouter)
// ---------------------------------------------------------------------------

function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              })),
            }
          : {}),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

async function callOpenAICompatible(
  model: ModelEntry,
  messages: ChatMessage[],
  tools: ToolSchema[],
  env: Record<string, string>
): Promise<LLMResult> {
  const isGroq = model.provider === 'groq';
  const baseUrl = isGroq
    ? env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'
    : env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const apiKey = isGroq ? env.GROQ_API_KEY : env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new ProviderError(
      `No API key for ${model.provider}. Add ${isGroq ? 'GROQ_API_KEY' : 'OPENROUTER_API_KEY'} in Agent -> Settings.`,
      { retryable: false, rateLimited: false }
    );
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (!isGroq) {
    // OpenRouter attributes traffic with these; harmless but expected.
    headers['HTTP-Referer'] = 'https://localhost/nexide';
    headers['X-Title'] = 'NEXide';
  }

  const started = Date.now();
  const res = await postJson(`${baseUrl}/chat/completions`, headers, {
    model: model.apiId,
    messages: toOpenAIMessages(messages),
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          tool_choice: 'auto',
        }
      : {}),
    temperature: 0.2,
  });

  if (!res.ok) {
    throw classifyHttp(res.status, await res.text().catch(() => ''));
  }

  const data: any = await res.json();
  const latencyMs = Date.now() - started;

  // Some free routes return an `error` object with HTTP 200. Treat it as the
  // failure it is rather than silently producing an empty assistant turn.
  if (data.error) {
    const msg = String(data.error.message ?? JSON.stringify(data.error));
    const rateLimited = /rate|quota|limit/i.test(msg);
    throw new ProviderError(`provider returned an error body: ${msg}`, { retryable: true, rateLimited });
  }

  const choice = data.choices?.[0]?.message;
  if (!choice) {
    throw new ProviderError(`no choices in response: ${JSON.stringify(data).slice(0, 300)}`, { retryable: true, rateLimited: false });
  }

  const toolCalls: ToolCall[] = (choice.tool_calls ?? []).map((c: any) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(c.function?.arguments || '{}');
    } catch {
      // A model emitting malformed JSON args is common on small models. Keep
      // the raw string so the agent loop can tell the model what broke rather
      // than crashing the whole subtask.
      args = { __malformed: String(c.function?.arguments ?? '') };
    }
    return { id: c.id ?? `call_${Math.random().toString(36).slice(2)}`, name: c.function?.name ?? 'unknown', arguments: args };
  });

  const promptTokens = data.usage?.prompt_tokens ?? estimateMessageTokens(messages);
  const completionTokens = data.usage?.completion_tokens ?? estimateTokens(choice.content ?? '');

  return {
    text: choice.content ?? '',
    toolCalls,
    promptTokens,
    completionTokens,
    costUsd: costOf(model, promptTokens, completionTokens),
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

async function callOllama(
  model: ModelEntry,
  messages: ChatMessage[],
  tools: ToolSchema[],
  env: Record<string, string>
): Promise<LLMResult> {
  const host = env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  const started = Date.now();

  // Ollama identifies tool responses by name, not by tool_call_id.
  const ollamaMessages = messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', content: m.content, name: m.name };
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content ?? '',
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) }
          : {}),
      };
    }
    return { role: m.role, content: m.content };
  });

  const res = await postJson(`${host}/api/chat`, {}, {
    model: model.apiId,
    messages: ollamaMessages,
    stream: false,
    ...(tools.length
      ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
      : {}),
    options: { temperature: 0.2 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 404) {
      throw new ProviderError(
        `Ollama has no model "${model.apiId}" pulled. Run: ollama pull ${model.apiId}`,
        { retryable: false, rateLimited: false, status: 404 }
      );
    }
    throw classifyHttp(res.status, body);
  }

  const data: any = await res.json();
  const latencyMs = Date.now() - started;
  const msg = data.message ?? {};

  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => ({
    id: `ollama_${Date.now()}_${i}`,
    name: c.function?.name ?? 'unknown',
    arguments: (c.function?.arguments ?? {}) as Record<string, unknown>,
  }));

  const promptTokens = data.prompt_eval_count ?? estimateMessageTokens(messages);
  const completionTokens = data.eval_count ?? estimateTokens(msg.content ?? '');

  return {
    text: msg.content ?? '',
    toolCalls,
    promptTokens,
    completionTokens,
    costUsd: 0, // local inference has no per-token dollar cost, by definition
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Gemini (generativelanguage.googleapis.com)
// ---------------------------------------------------------------------------

/**
 * Convert our flat ChatMessage list to Gemini's `contents` array.
 *
 * Rules:
 *  - `system` messages are returned separately as `systemInstruction` text;
 *    Gemini does not accept `role: system` inside `contents`.
 *  - `tool` messages become a `user` turn containing a `functionResponse` part.
 *    Gemini groups multi-tool responses: consecutive tool messages for the same
 *    assistant turn are collapsed into one user content with multiple parts.
 *  - `assistant` messages become `model` turns; tool calls become
 *    `functionCall` parts and any text becomes a `text` part.
 */
function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction: { parts: { text: string }[] } | undefined;
  contents: unknown[];
} {
  const systemParts: { text: string }[] = [];
  const contents: unknown[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    if (m.role === 'system') {
      systemParts.push({ text: m.content });
      continue;
    }

    if (m.role === 'tool') {
      // Collect all consecutive tool-result messages into a single user turn.
      const parts: unknown[] = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const t = messages[i] as { role: 'tool'; toolCallId: string; name: string; content: string };
        parts.push({
          functionResponse: {
            name: t.name,
            response: { output: t.content },
          },
        });
        i++;
      }
      i--; // outer loop will increment
      contents.push({ role: 'user', parts });
      continue;
    }

    if (m.role === 'assistant') {
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) {
        const fcPart: Record<string, unknown> = { functionCall: { name: tc.name, args: tc.arguments } };
        // Sibling of `functionCall` on the Part, camelCase per the v1beta REST API.
        if (tc._geminiThoughtSignature != null) fcPart.thoughtSignature = tc._geminiThoughtSignature;
        parts.push(fcPart);
      }
      if (parts.length === 0) parts.push({ text: '' });
      contents.push({ role: 'model', parts });
      continue;
    }

    // role === 'user'
    contents.push({ role: 'user', parts: [{ text: m.content }] });
  }

  return {
    systemInstruction: systemParts.length > 0 ? { parts: systemParts } : undefined,
    contents,
  };
}

async function callGemini(
  model: ModelEntry,
  messages: ChatMessage[],
  tools: ToolSchema[],
  env: Record<string, string>
): Promise<LLMResult> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ProviderError(
      'No API key for Gemini. Add GEMINI_API_KEY in Agent -> Settings.',
      { retryable: false, rateLimited: false }
    );
  }

  // The registry stores apiId as "gemini/<model-name>" for namespacing clarity.
  // The actual Gemini REST endpoint uses just the model name.
  const modelName = model.apiId.startsWith('gemini/') ? model.apiId.slice('gemini/'.length) : model.apiId;
  const baseUrl = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
  const url = `${baseUrl}/models/${modelName}:generateContent?key=${apiKey}`;

  const { systemInstruction, contents } = toGeminiContents(messages);

  // Gemma models are served through the same Gemini API but have no system
  // role — passing `systemInstruction` to them is a 400. Fold that text into
  // the first user turn instead so the same adapter serves both.
  const isGemma = /gemma/i.test(modelName);
  if (isGemma && systemInstruction) {
    const sysText = systemInstruction.parts.map((p) => p.text).join('\n\n');
    const firstUser = (contents as any[]).find((c) => c?.role === 'user');
    if (firstUser) firstUser.parts.unshift({ text: `${sysText}\n\n---\n\n` });
    else (contents as any[]).unshift({ role: 'user', parts: [{ text: sysText }] });
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig: { temperature: 0.2 },
  };
  if (systemInstruction && !isGemma) body.systemInstruction = systemInstruction;
  if (tools.length) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }

  const started = Date.now();
  const res = await postJson(url, {}, body);
  const latencyMs = Date.now() - started;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Gemini uses 429 for quota, 400 for bad requests, 401/403 for auth.
    throw classifyHttp(res.status, text);
  }

  const data: any = await res.json();

  // Gemini surfaces quota/safety errors inside a 200 body.
  if (data.error) {
    const msg = String(data.error.message ?? JSON.stringify(data.error));
    const rateLimited = /quota|rate|limit/i.test(msg);
    throw new ProviderError(`Gemini returned an error body: ${msg}`, { retryable: true, rateLimited });
  }

  const candidate = data.candidates?.[0];
  if (!candidate) {
    const reason = data.promptFeedback?.blockReason ?? 'unknown';
    throw new ProviderError(
      `Gemini returned no candidates (blockReason: ${reason})`,
      { retryable: false, rateLimited: false }
    );
  }

  const parts: any[] = candidate.content?.parts ?? [];
  let text = '';
  const toolCalls: ToolCall[] = [];

  // The v1beta REST API returns this as `thoughtSignature` (camelCase); the proto
  // name `thought_signature` never appears in a JSON response, so reading only
  // the snake_case form captured nothing and the next tool turn 400'd with
  // "Function call is missing a thought_signature". Read camelCase first, keep
  // snake_case as a fallback for a proxy that might rewrite it.
  const sigOf = (part: any): string | null => {
    const s = part?.thoughtSignature ?? part?.thought_signature;
    return s != null ? String(s) : null;
  };

  let turnSignature: string | null = null;
  for (const part of parts) {
    turnSignature = turnSignature ?? sigOf(part);
    if (typeof part.text === 'string') {
      text += part.text;
    } else if (part.functionCall) {
      const fc = part.functionCall;
      const sig = sigOf(part);
      toolCalls.push({
        // Gemini doesn't assign call IDs; synthesise a stable-ish one.
        id: `gemini_${Date.now()}_${toolCalls.length}`,
        name: fc.name ?? 'unknown',
        arguments: (fc.args ?? {}) as Record<string, unknown>,
        // Preserved so toGeminiContents can round-trip it into history.
        ...(sig != null ? { _geminiThoughtSignature: sig } : {}),
      });
    }
  }

  // Gemini attaches the signature to just one part per turn — usually the first
  // functionCall, but sometimes a leading thought part. If the calls themselves
  // carried none but the turn did, pin it to the first call so the history
  // round-trip still satisfies the check instead of 400'ing next request.
  if (turnSignature && toolCalls.length && !toolCalls.some((c) => c._geminiThoughtSignature != null)) {
    toolCalls[0]._geminiThoughtSignature = turnSignature;
  }

  const usage = data.usageMetadata ?? {};
  const promptTokens: number = usage.promptTokenCount ?? estimateMessageTokens(messages);
  const completionTokens: number = usage.candidatesTokenCount ?? estimateTokens(text);

  return {
    text,
    toolCalls,
    promptTokens,
    completionTokens,
    costUsd: costOf(model, promptTokens, completionTokens),
    latencyMs,
  };
}

// ---------------------------------------------------------------------------

export async function callModel(
  model: ModelEntry,
  messages: ChatMessage[],
  tools: ToolSchema[],
  env: Record<string, string>
): Promise<LLMResult> {
  if (model.provider === 'ollama') return callOllama(model, messages, tools, env);
  if (model.provider === 'gemini') return callGemini(model, messages, tools, env);
  return callOpenAICompatible(model, messages, tools, env);
}
