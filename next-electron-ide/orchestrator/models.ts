/**
 * ============================================================================
 *  MODEL REGISTRY — and the eligibility rule that gates it
 * ============================================================================
 * The PS constraint is: every model used anywhere in the pipeline must have
 * TOTAL parameter count <= 80B. "Total, not active" is the part that actually
 * bites, because the cheapest-looking models on every provider right now are
 * sparse MoE models advertised by their *active* parameter count.
 *
 * Two entries below exist specifically to prove that rule is enforced rather
 * than assumed:
 *   - `openai/gpt-oss-120b`      120B dense           -> INELIGIBLE
 *   - `nvidia/nemotron-3-super-120b-a12b`  120B total / 12B active -> INELIGIBLE
 * The second one would pass a naive "is it small and cheap" check and pass a
 * naive active-param check too. It is in the registry, visibly blocked, so the
 * settings screen can show *why* it is blocked instead of silently omitting it.
 *
 * `paramsBTotal: null` means the provider does not publish a parameter count.
 * Unpublished is treated as INELIGIBLE, not as "probably fine" — an
 * unverifiable model is a disqualification risk, which is exactly why the
 * Gemini wiring this replaced had to go.
 *
 * VERIFY BEFORE SUBMISSION: provider catalogues churn. Model ids here were
 * checked against provider docs in Aug 2026. `npm run verify:models` (see
 * scripts/verify-models.mjs) re-checks ids and pricing against the live
 * /models endpoints so a renamed model surfaces as a failure, not a 404 at
 * demo time.
 */

export type ProviderId = "groq" | "openrouter" | "ollama" | "gemini";

export type ModelEntry = {
  id: string;
  /** the exact string sent as `model` in the API request */
  apiId: string;
  label: string;
  provider: ProviderId;
  /** TOTAL parameters in billions. null = provider does not publish it. */
  paramsBTotal: number | null;
  /** Active params for MoE models; informational only, never used for eligibility. */
  paramsBActive?: number;
  contextWindow: number;
  /** USD per 1M tokens. Zero for local and for free-tier routes. */
  pricing: { inputPerM: number; outputPerM: number };
  tier: "free" | "payg" | "local";
  /** What the router is willing to hand this model. */
  good_at: ("planning" | "codegen" | "analysis" | "simple" | "verification")[];
  /** Rough tokens/sec, used only to break ties on the time term. */
  speed: "fast" | "medium" | "slow";
  notes?: string;
};

export const PARAM_LIMIT_B = 80;

export const MODEL_REGISTRY: ModelEntry[] = [
  // ---------------------------------------------------------------- Groq ---
  // Free tier, OpenAI-compatible, and by far the fastest of the three, which
  // matters for the T term in S_task even though cost is weighted ~2x harder.
  {
    id: "groq:llama-3.1-8b",
    apiId: "llama-3.1-8b-instant",
    label: "Llama 3.1 8B Instant",
    provider: "groq",
    paramsBTotal: 8,
    contextWindow: 131072,
    pricing: { inputPerM: 0.05, outputPerM: 0.08 },
    tier: "free",
    good_at: ["simple", "verification"],
    speed: "fast",
    notes:
      "Cheapest sensible default for simple edits and pass/fail verification.",
  },
  {
    id: "groq:gpt-oss-20b",
    apiId: "openai/gpt-oss-20b",
    label: "GPT-OSS 20B",
    provider: "groq",
    paramsBTotal: 20,
    contextWindow: 131072,
    pricing: { inputPerM: 0.1, outputPerM: 0.5 },
    tier: "free",
    good_at: ["codegen", "analysis", "verification"],
    speed: "fast",
    notes: "Good cost/quality midpoint; open weights, size published.",
  },
  {
    id: "groq:qwen3.6-27b",
    apiId: "qwen/qwen3.6-27b",
    label: "Qwen 3.6 27B",
    provider: "groq",
    paramsBTotal: 27,
    contextWindow: 131072,
    pricing: { inputPerM: 0.15, outputPerM: 0.6 },
    tier: "free",
    good_at: ["codegen", "analysis", "planning"],
    speed: "fast",
    notes: "Preview model on Groq — strong at code for its size.",
  },
  {
    id: "groq:llama-3.3-70b",
    apiId: "llama-3.3-70b-versatile",
    label: "Llama 3.3 70B Versatile",
    provider: "groq",
    paramsBTotal: 70,
    contextWindow: 131072,
    pricing: { inputPerM: 0.59, outputPerM: 0.79 },
    tier: "free",
    good_at: ["planning", "codegen", "analysis"],
    speed: "medium",
    notes:
      "The heavy end of what the constraint allows. Reserve for planning and hard codegen.",
  },
  {
    id: "groq:gpt-oss-120b",
    apiId: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B",
    provider: "groq",
    paramsBTotal: 120,
    contextWindow: 131072,
    pricing: { inputPerM: 0.15, outputPerM: 0.75 },
    tier: "free",
    good_at: ["planning", "codegen", "analysis"],
    speed: "medium",
    notes:
      "INELIGIBLE: 120B dense, over the 80B ceiling. Listed so the block is visible.",
  },

  // ---------------------------------------------------------- OpenRouter ---
  // Second provider exists mainly so failover is real: when Groq 429s, the
  // router has somewhere to go without losing the subtask.
  {
    id: "openrouter:gemma-4-31b",
    apiId: "google/gemma-4-31b-it:free",
    label: "Gemma 4 31B IT",
    provider: "openrouter",
    paramsBTotal: 31,
    contextWindow: 262144,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "free",
    good_at: ["codegen", "analysis", "planning"],
    speed: "medium",
    notes:
      "Free route, open weights, large context. Good failover target for Groq codegen.",
  },
  {
    id: "openrouter:gemma-4-26b-a4b",
    apiId: "google/gemma-4-26b-a4b-it:free",
    label: "Gemma 4 26B-A4B (MoE)",
    provider: "openrouter",
    paramsBTotal: 26,
    paramsBActive: 4,
    contextWindow: 262144,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "free",
    good_at: ["simple", "analysis", "verification"],
    speed: "fast",
    notes:
      "MoE: 26B total / 4B active. Eligible on TOTAL (26B), which is the number the rule uses.",
  },
  {
    id: "openrouter:nemotron-nano-30b",
    apiId: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    label: "Nemotron 3 Nano 30B-A3B",
    provider: "openrouter",
    paramsBTotal: 30,
    paramsBActive: 3,
    contextWindow: 262144,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "free",
    good_at: ["analysis", "verification", "planning"],
    speed: "fast",
    notes:
      "Reasoning-tuned MoE, 30B total. Useful as the tie-break third opinion.",
  },
  {
    id: "openrouter:lfm-2.5-2.6b",
    apiId: "liquid/lfm-2.5-2.6b:free",
    label: "LFM 2.5 2.6B",
    provider: "openrouter",
    paramsBTotal: 2.6,
    contextWindow: 65536,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "free",
    good_at: ["simple"],
    speed: "fast",
    notes: "Floor model. Only worth routing trivial classification/edits here.",
  },
  {
    id: "openrouter:nemotron-super-120b",
    apiId: "nvidia/nemotron-3-super-120b-a12b:free",
    label: "Nemotron 3 Super 120B-A12B",
    provider: "openrouter",
    paramsBTotal: 120,
    paramsBActive: 12,
    contextWindow: 262144,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "free",
    good_at: ["planning", "codegen"],
    speed: "medium",
    notes:
      "INELIGIBLE: 120B TOTAL despite only 12B active. This is the exact trap the rule targets.",
  },

  // -------------------------------------------------------------- Ollama ---
  // Zero marginal cost, which is the strongest possible lever on the C term.
  // Sizes assume ~4-bit quantisation to fit 16GB RAM / 8GB VRAM.
  {
    id: "ollama:qwen2.5-coder-7b",
    apiId: "qwen2.5-coder:7b",
    label: "Qwen2.5 Coder 7B (local)",
    provider: "ollama",
    paramsBTotal: 7,
    contextWindow: 32768,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "local",
    good_at: ["simple", "codegen", "verification"],
    speed: "medium",
    notes:
      "Free at the margin. Fits 8GB VRAM quantised. Best cost lever available.",
  },
  {
    id: "ollama:qwen2.5-coder-14b",
    apiId: "qwen2.5-coder:14b",
    label: "Qwen2.5 Coder 14B (local)",
    provider: "ollama",
    paramsBTotal: 14,
    contextWindow: 32768,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "local",
    good_at: ["codegen", "analysis"],
    speed: "slow",
    notes:
      "Tight on 8GB VRAM at 4-bit; verify it loads on your box before relying on it.",
  },
  {
    id: "ollama:gemma3-12b",
    apiId: "gemma3:12b",
    label: "Gemma 3 12B (local)",
    provider: "ollama",
    paramsBTotal: 12,
    contextWindow: 131072,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "local",
    good_at: ["analysis", "simple", "verification"],
    speed: "slow",
    notes:
      "Local Gemma. Long context for its size, useful for analysis over big retrievals.",
  },
  // Open-weights Gemma served through the Gemini API (generativelanguage.*),
  // so the same GEMINI_API_KEY and REST adapter are reused. Free tier, and
  // 31B total keeps it inside the 80B ceiling.
  {
    id: "gemini:gemma-4-31b",
    apiId: "gemini/gemma-4-31b-it",
    label: "Gemma 4 31B IT (Gemini API)",
    provider: "gemini",
    paramsBTotal: 31,
    contextWindow: 131072,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "free",
    good_at: ["codegen", "analysis", "planning"],
    speed: "medium",
    notes:
      "Gemma 4 31B open weights via the Gemini API. Free tier. Gemma has no " +
      "system role, so the adapter folds the system prompt into the first user turn.",
  },
];

export type Eligibility = { eligible: boolean; reason: string };

/**
 * The single gate. Everything that picks a model calls this — the router at
 * runtime AND the settings screen at display time — so there is exactly one
 * definition of "allowed" in the codebase and no path around it.
 */
export function checkEligibility(m: ModelEntry): Eligibility {
  if (m.paramsBTotal == null) {
    return {
      eligible: false,
      reason:
        "Provider does not publish a parameter count — unverifiable, treated as ineligible.",
    };
  }
  if (m.paramsBTotal > PARAM_LIMIT_B) {
    const activeNote =
      m.paramsBActive != null
        ? ` (${m.paramsBActive}B active, but the rule counts total)`
        : "";
    return {
      eligible: false,
      reason: `${m.paramsBTotal}B total parameters${activeNote} exceeds the ${PARAM_LIMIT_B}B ceiling.`,
    };
  }
  return {
    eligible: true,
    reason: `${m.paramsBTotal}B total parameters, within the ${PARAM_LIMIT_B}B ceiling.`,
  };
}

export function eligibleModels(): ModelEntry[] {
  return MODEL_REGISTRY.filter((m) => checkEligibility(m).eligible);
}

export function findModel(id: string): ModelEntry | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

/** USD for one call. Local models are genuinely free, not nominally free. */
export function costOf(
  m: ModelEntry,
  promptTokens: number,
  completionTokens: number,
): number {
  return (
    (promptTokens / 1e6) * m.pricing.inputPerM +
    (completionTokens / 1e6) * m.pricing.outputPerM
  );
}

/** Which settings key each provider needs. Ollama needs a host, not a key. */
export const PROVIDER_CONFIG: Record<
  ProviderId,
  { keyName: string; label: string; optional?: boolean; defaultValue?: string }
> = {
  groq: { keyName: "GROQ_API_KEY", label: "Groq" },
  openrouter: { keyName: "OPENROUTER_API_KEY", label: "OpenRouter" },
  ollama: {
    keyName: "OLLAMA_HOST",
    label: "Ollama (local)",
    optional: true,
    defaultValue: "http://127.0.0.1:11434",
  },
  gemini: { keyName: "GEMINI_API_KEY", label: "Gemini" },
};
