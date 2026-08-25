/**
 * ============================================================================
 *  LLM ENDPOINT — wired to Google's Gemini API (generateContent)
 * ============================================================================
 * Everything downstream of this file is real and working: the agent loop
 * (agent.ts) drives multi-step tool use, tools.ts actually executes against
 * the filesystem/terminal, and ChatPanel.tsx gates every side-effecting tool
 * call behind a human Approve/Reject click. None of that is Gemini-specific
 * — this file is the one seam between "real orchestration" and "an actual
 * model," so switching providers later only means rewriting `callLLM`.
 *
 * ⚠ PS ELIGIBILITY WARNING: the brain file's hard constraint is every model
 * ≤80B TOTAL params. Google does not publish Gemini's parameter count, so
 * you cannot currently verify Gemini satisfies that constraint — using it
 * risks disqualification for the actual Takneek submission. This wiring is
 * genuinely useful for development (it's a real, working implementation you
 * can test against today), but don't ship it as your competition model
 * without either finding an authoritative param count or switching to a
 * provider that publishes one (open-weight models on Groq/OpenRouter/local
 * Ollama — sizes are public for those).
 *
 * Setup: open Agent → Settings and add a row named exactly `GEMINI_API_KEY`
 * with your key as the value. Never hardcode a real key in this file — it's
 * source code that ends up in your repo/.git history; Settings persists it
 * to a JSON file outside the project folder specifically so that doesn't
 * happen.
 */

export const LLM_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
export const LLM_MODEL = 'gemini-3.6-flash';

export type LLMRole = 'system' | 'user' | 'assistant' | 'tool';

export type LLMToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Opaque, provider-specific data that must be echoed back verbatim the
   * next time this call is replayed into the conversation history — e.g.
   * Gemini's `thoughtSignature`, required on function-call parts for its
   * "thinking" models (https://ai.google.dev/gemini-api/docs/thought-signatures).
   * Providers/agent code that don't care about this can ignore it; agent.ts
   * never inspects it, just carries it through history unchanged.
   */
  providerMeta?: unknown;
};

export type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LLMToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export type LLMToolSchema = {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments object. */
  parameters: Record<string, unknown>;
};

export type LLMResponse = { kind: 'text'; text: string } | { kind: 'tool-calls'; calls: LLMToolCall[] };

// ---------------------------------------------------------------------------
// Gemini-specific request/response shaping
// ---------------------------------------------------------------------------

/**
 * Gemini's function-declaration schema uses UPPERCASE type names (STRING,
 * OBJECT, ARRAY, ...) instead of JSON Schema's lowercase ones — everything
 * else about the shape (properties/items/required/description) matches, so
 * this just walks the tree and uppercases every "type" value.
 */
function toGeminiSchema(schema: unknown): unknown {
  if (schema == null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'type' && typeof value === 'string') {
      out.type = value.toUpperCase();
    } else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toGeminiSchema(v)])
      );
    } else if (key === 'items') {
      out.items = toGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Unlike OpenAI's protocol, Gemini's function-response parts identify the
 * function by NAME, not by our LLMMessage's toolCallId — so a tool-role
 * message has to look backwards through the conversation to find which
 * call (and therefore which name) it's answering.
 */
function resolveToolName(messages: LLMMessage[], toolCallId: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.toolCalls) {
      const match = m.toolCalls.find((c) => c.id === toolCallId);
      if (match) return match.name;
    }
  }
  return 'unknown_function';
}

type GeminiContent = { role: 'user' | 'model'; parts: Record<string, unknown>[] };

function toGeminiContents(messages: LLMMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // collected separately into systemInstruction
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length > 0) {
        contents.push({
          role: 'model',
          parts: m.toolCalls.map((c) => {
            const part: Record<string, unknown> = { functionCall: { name: c.name, args: c.arguments } };
            const meta = c.providerMeta as { thoughtSignature?: unknown } | undefined;
            if (meta?.thoughtSignature != null) part.thoughtSignature = meta.thoughtSignature;
            return part;
          }),
        });
      } else {
        contents.push({ role: 'model', parts: [{ text: m.content ?? '' }] });
      }
    } else if (m.role === 'tool') {
      const name = resolveToolName(messages, m.toolCallId);
      // NOTE: some Gemini API versions expect role: 'function' here instead
      // of 'user' for function-response turns — if you get a 400 back,
      // check the current REST reference and adjust this one line.
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: { result: m.content } } }],
      });
    }
  }
  return contents;
}

export async function callLLM(
  messages: LLMMessage[],
  tools: LLMToolSchema[],
  env: Record<string, string>
): Promise<LLMResponse> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No GEMINI_API_KEY found. Open Agent → Settings and add a variable named ' +
        'exactly GEMINI_API_KEY with your Google AI Studio key.'
    );
  }

  const systemText = messages
    .filter((m): m is Extract<LLMMessage, { role: 'system' }> => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const body: Record<string, unknown> = {
    contents: toGeminiContents(messages),
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    ...(tools.length > 0
      ? {
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: toGeminiSchema(t.parameters),
              })),
            },
          ],
        }
      : {}),
  };

  const url = `${LLM_ENDPOINT}/models/${LLM_MODEL}:generateContent`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Could not reach Gemini API: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini API request failed: ${res.status} ${res.statusText} — ${text}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate) {
    const blockReason = data.promptFeedback?.blockReason;
    throw new Error(
      blockReason
        ? `Gemini blocked this request (${blockReason}).`
        : `Gemini returned no candidates: ${JSON.stringify(data)}`
    );
  }

  const parts: Array<Record<string, unknown>> = candidate.content?.parts ?? [];
  const functionCallParts = parts.filter((p) => p.functionCall);

  if (functionCallParts.length > 0) {
    return {
      kind: 'tool-calls',
      calls: functionCallParts.map((p) => {
        const fc = p.functionCall as { name: string; args?: Record<string, unknown> };
        return {
          id: crypto.randomUUID(),
          name: fc.name,
          arguments: fc.args ?? {},
          providerMeta: p.thoughtSignature != null ? { thoughtSignature: p.thoughtSignature } : undefined,
        };
      }),
    };
  }

  const text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
  return { kind: 'text', text };
}

// ---------------------------------------------------------------------------
// Reference only: most OTHER providers worth considering under the PS's
// constraints (Groq, OpenRouter, Together, a local Ollama/llama.cpp server)
// speak an OpenAI-compatible /chat/completions API instead of Gemini's
// shape above. Swap this in (and update LLM_ENDPOINT/LLM_MODEL) if you move
// off Gemini — published open-weight param counts make PS eligibility much
// easier to verify than with Gemini.
// ---------------------------------------------------------------------------
//
// const apiKey = env.OPENROUTER_API_KEY;
// const res = await fetch(LLM_ENDPOINT, {
//   method: 'POST',
//   headers: {
//     'Content-Type': 'application/json',
//     ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
//   },
//   body: JSON.stringify({
//     model: LLM_MODEL,
//     messages: messages.map((m) =>
//       m.role === 'assistant'
//         ? {
//             role: 'assistant',
//             content: m.content,
//             tool_calls: m.toolCalls?.map((c) => ({
//               id: c.id,
//               type: 'function',
//               function: { name: c.name, arguments: JSON.stringify(c.arguments) },
//             })),
//           }
//         : m.role === 'tool'
//           ? { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
//           : { role: m.role, content: m.content }
//     ),
//     tools: tools.map((t) => ({
//       type: 'function',
//       function: { name: t.name, description: t.description, parameters: t.parameters },
//     })),
//   }),
// });
// const data = await res.json();
// const choice = data.choices[0].message;
// if (choice.tool_calls?.length) {
//   return {
//     kind: 'tool-calls',
//     calls: choice.tool_calls.map((c: any) => ({
//       id: c.id,
//       name: c.function.name,
//       arguments: JSON.parse(c.function.arguments || '{}'),
//     })),
//   };
// }
// return { kind: 'text', text: choice.content ?? '' };
