/**
 * ============================================================================
 *  MODEL REGISTRY - and the eligibility rule that gates it
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
 * Unpublished is treated as INELIGIBLE, not as "probably fine" - an
 * unverifiable model is a disqualification risk, which is exactly why the
 * Gemini wiring this replaced had to go.
 *
 * `qualityIndex` is the Artificial Analysis intelligence index as published in
 * the OpenRouter catalogue. It exists because parameter count turned out to be
 * a BAD capability proxy: llama-3.3-70b is 2.6x the size of qwen3.8-27b and
 * scores roughly a fifth of it on coding. The router uses this number, not
 * size, to decide what "escalate to something more capable" means. Where a
 * model has not been benchmarked the field is omitted and the router falls
 * back to size - stated rather than hidden.
 *
 * VERIFY BEFORE SUBMISSION: provider catalogues churn. Every id, price, and
 * context window below was checked on 2026-08-30 against the live sources -
 * openrouter.ai/api/v1/models, console.groq.com/docs/models, and
 * ollama.com/library. `npm run verify:models` (scripts/verify-models.mjs)
 * re-runs that check so a renamed model surfaces as a failing script rather
 * than a 404 in front of a judge. The one entry it cannot check is the Gemini
 * one, because that catalogue needs a key; see its note.
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
  /** For local models this is also the `num_ctx` we ask Ollama to allocate,
   *  so it must be a window the reference machine can actually hold. */
  contextWindow: number;
  /** USD per 1M tokens. Zero for local and for free-tier routes. */
  pricing: { inputPerM: number; outputPerM: number };
  tier: "free" | "payg" | "local";
  /** Artificial Analysis intelligence index (0-100), as published in the
   *  OpenRouter catalogue. For custom models this is the user's declared
   *  quality estimate, not a claim that the model was benchmarked. */
  qualityIndex?: number;
  /** What the router is willing to hand this model. */
  good_at: ("planning" | "codegen" | "analysis" | "simple" | "verification")[];
  /** Rough tokens/sec, used only to break ties on the time term. */
  speed: "fast" | "medium" | "slow";
  notes?: string;
};

export const PARAM_LIMIT_B = 80;

const LEGACY_MODEL_REGISTRY: ModelEntry[] = [
  // Ineligible on purpose: the settings/tests need a visible reason, not a hole.
  {
    id: "groq:gpt-oss-120b",
    apiId: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B (ineligible)",
    provider: "groq",
    paramsBTotal: 120,
    contextWindow: 131072,
    pricing: { inputPerM: 0.15, outputPerM: 0.6 },
    tier: "payg",
    good_at: ["codegen", "analysis"],
    speed: "medium",
    notes: "Listed so the 80B TOTAL rule has a concrete blocked example.",
  },
  {
    id: "openrouter:nemotron-super-120b",
    apiId: "nvidia/nemotron-3-super-120b-a12b",
    label: "Nemotron Super 120B-A12B (ineligible)",
    provider: "openrouter",
    paramsBTotal: 120,
    paramsBActive: 12,
    contextWindow: 262144,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "free",
    good_at: ["codegen", "analysis"],
    speed: "medium",
    notes: "120B total / 12B active. The active count is a trap; the rule counts total.",
  },
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
    pricing: { inputPerM: 0.075, outputPerM: 0.3 },
    tier: "payg",
    qualityIndex: 15.2,
    good_at: ["codegen", "analysis", "verification", "simple"],
    speed: "fast",
    notes:
      "Cheapest hosted model that still calls tools reliably. The workhorse for routine implementer turns.",
  },
  {
    id: "groq:qwen3.6-27b",
    apiId: "qwen/qwen3.6-27b",
    label: "Qwen 3.6 27B",
    provider: "groq",
    paramsBTotal: 27,
    contextWindow: 131072,
    pricing: { inputPerM: 0.6, outputPerM: 3.0 },
    tier: "payg",
    qualityIndex: 37.7,
    good_at: ["codegen", "analysis", "planning", "verification"],
    speed: "fast",
    notes:
      "Superseded by qwen3.8-27b on the same provider at similar cost - keep it enabled only as a same-provider fallback.",
  },
  {
    // The single most capable model that fits under 80B anywhere in the live
    // catalogue: intelligence 52.0 / coding 68.1 / agentic 50.9, versus 29.7 /
    // 43.4 / 14.4 for the next best free option. This is the model the planner,
    // verifier and tie-break want, and the reason `qualityIndex` exists at all.
    id: "groq:qwen3.8-27b",
    apiId: "qwen/qwen3.8-27b",
    label: "Qwen 3.8 27B",
    provider: "groq",
    paramsBTotal: 27,
    contextWindow: 131042,
    pricing: { inputPerM: 0.8, outputPerM: 4.0 },
    tier: "payg",
    qualityIndex: 52.0,
    good_at: ["planning", "analysis", "codegen", "verification"],
    speed: "fast",
    notes:
      "Best-in-class under the 80B ceiling. Dense 27B, so quality does not come with a hidden total-parameter cost. Priciest per token here - the router only reaches for it on hard subtasks and tie-breaks.",
  },
  {
    id: "groq:llama-3.3-70b",
    apiId: "llama-3.3-70b-versatile",
    label: "Llama 3.3 70B Versatile",
    provider: "groq",
    paramsBTotal: 70,
    contextWindow: 131072,
    pricing: { inputPerM: 0.59, outputPerM: 0.79 },
    tier: "payg",
    good_at: ["analysis", "planning"],
    speed: "medium",
    notes:
      "Biggest model here but no longer the best: it predates the current Qwen/Gemma generation and scores 11.9 on coding against qwen3.8-27b's 68.1. Kept for long-context analysis; deliberately NOT tagged for codegen.",
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
    paramsBTotal: 25.2,
    paramsBActive: 3.8,
    contextWindow: 262144,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "free",
    qualityIndex: 26.1,
    good_at: ["simple", "analysis", "verification"],
    speed: "fast",
    notes:
      "MoE: 25.2B total / 3.8B active. Eligible on TOTAL, which is the number the rule uses.",
  },
  {
    // Same weights as groq:qwen3.8-27b but roughly half the price and with a
    // 1M window, so this is both the cheaper way to reach the best model and
    // the failover that keeps a tie-break alive when Groq rate-limits.
    id: "openrouter:qwen3.8-27b",
    apiId: "qwen/qwen3.8-27b",
    label: "Qwen 3.8 27B (1M ctx)",
    provider: "openrouter",
    paramsBTotal: 27,
    contextWindow: 1000000,
    pricing: { inputPerM: 0.425, outputPerM: 2.55 },
    tier: "payg",
    qualityIndex: 52.0,
    good_at: ["planning", "analysis", "codegen", "verification"],
    speed: "medium",
    notes:
      "Cheaper route to the strongest eligible model, and the only one whose window survives a whole-repo retrieval. Slower than the Groq route, which is the trade the router weighs.",
  },
  {
    id: "openrouter:north-mini-code",
    apiId: "cohere/north-mini-code:free",
    label: "North Mini Code 30B-A3B",
    provider: "openrouter",
    paramsBTotal: 30,
    paramsBActive: 3,
    contextWindow: 256000,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "free",
    qualityIndex: 20.2,
    good_at: ["codegen", "simple"],
    speed: "fast",
    notes:
      "Purpose-built agentic coding model, and free. Coding index 36.5 - higher than the 120B model we are not allowed to use. Best zero-cost codegen route available.",
  },
  {
    id: "openrouter:nemotron-3.5-lightning",
    apiId: "nvidia/nemotron-3.5-lightning:free",
    label: "Nemotron 3.5 Lightning 30B-A3B",
    provider: "openrouter",
    paramsBTotal: 30,
    paramsBActive: 3,
    contextWindow: 1000000,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "free",
    qualityIndex: 23.6,
    good_at: ["analysis", "verification", "simple"],
    speed: "fast",
    notes:
      "Free, 3B active so it is genuinely fast, and a 1M window. The escape hatch when a context is too big for every paid model we can still afford.",
  },
  {
    id: "openrouter:qwen3.6-35b-a3b",
    apiId: "qwen/qwen3.6-35b-a3b",
    label: "Qwen 3.6 35B-A3B (MoE)",
    provider: "openrouter",
    paramsBTotal: 35,
    paramsBActive: 3,
    contextWindow: 262144,
    pricing: { inputPerM: 0.1, outputPerM: 0.9 },
    tier: "payg",
    qualityIndex: 32.1,
    good_at: ["codegen", "analysis", "verification"],
    speed: "fast",
    notes:
      "Best quality-per-dollar in the registry: 32.1 index at 1/8th the input price of qwen3.8-27b. The default paid choice when the free tiers are exhausted.",
  },
  {
    id: "openrouter:nemotron-nano-30b",
    apiId: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    label: "Nemotron 3 Nano 30B-A3B",
    provider: "openrouter",
    paramsBTotal: 30,
    paramsBActive: 3,
    contextWindow: 256000,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "free",
    qualityIndex: 13.8,
    good_at: ["analysis", "verification", "planning"],
    speed: "fast",
    notes:
      "Reasoning-tuned MoE, 30B total, free. Kept as a cheap third opinion, but qwen3.8-27b outscores it heavily - enable it for cost, not for quality.",
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

  // -------------------------------------------------------------- Ollama ---
  // Zero marginal cost, which is the strongest possible lever on the C term.
  // Sizes assume ~4-bit quantisation on the reference box: 16GB RAM, 8GB VRAM.
  //
  // `contextWindow` here is NOT the model's architectural maximum. It is the
  // window we ask Ollama to allocate (`num_ctx`), and the KV cache for it has
  // to fit in memory alongside the weights. Advertising gemma3's 131k here and
  // sending a 100k prompt would not fail loudly - Ollama would silently drop
  // the front of the conversation, which is the worst possible failure mode for
  // an agent that just put its instructions there. So these are the windows the
  // reference machine can genuinely hold.
  {
    id: "ollama:qwen2.5-coder-7b",
    apiId: "qwen2.5-coder:7b",
    label: "Qwen2.5 Coder 7B (local)",
    provider: "ollama",
    paramsBTotal: 7,
    contextWindow: 16384,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "local",
    good_at: ["simple", "codegen", "verification"],
    speed: "medium",
    notes:
      "~4.7GB at Q4 plus a 16k KV cache - the largest local model that fits 8GB VRAM entirely. Best cost lever available.",
  },
  {
    id: "ollama:llama3.1-8b",
    apiId: "llama3.1:8b",
    label: "Llama 3.1 8B (local)",
    provider: "ollama",
    paramsBTotal: 8,
    contextWindow: 16384,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "local",
    good_at: ["simple", "verification"],
    speed: "medium",
    notes:
      "Note the .1 - the original `llama3` tag has no tool-calling template and cannot drive an agent loop. 3.1 added it. Weak at code (coding index ~5), so it is tagged for simple edits and pass/fail verification only.",
  },
  {
    id: "ollama:granite4-7b-a1b",
    apiId: "granite4:7b-a1b-h",
    label: "Granite 4 7B-A1B (local, MoE)",
    provider: "ollama",
    paramsBTotal: 7,
    paramsBActive: 1,
    contextWindow: 16384,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "local",
    good_at: ["simple", "verification"],
    speed: "fast",
    notes:
      "Only 1B parameters active per token, so it is usable at real speed even with no GPU at all. The model to enable when the box is CPU-only and the alternative is not running locally.",
  },
  {
    id: "ollama:qwen2.5-coder-14b",
    apiId: "qwen2.5-coder:14b",
    label: "Qwen2.5 Coder 14B (local)",
    provider: "ollama",
    paramsBTotal: 14,
    contextWindow: 8192,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "local",
    good_at: ["codegen", "analysis"],
    speed: "slow",
    notes:
      "~9GB at Q4, so it spills past 8GB VRAM and part of it runs on CPU. Works, but expect several times the latency of the 7B. Verify it loads on your box before relying on it.",
  },
  {
    id: "ollama:gemma3-12b",
    apiId: "gemma3:12b",
    label: "Gemma 3 12B (local)",
    provider: "ollama",
    paramsBTotal: 12,
    contextWindow: 8192,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "local",
    good_at: ["analysis", "simple", "verification"],
    speed: "slow",
    notes:
      "Local Gemma. The weights support 128k context but the KV cache for it does not fit the reference box, so we allocate 8k.",
  },
  {
    id: "ollama:qwen3-coder-30b",
    apiId: "qwen3-coder:30b",
    label: "Qwen3 Coder 30B-A3B (local, MoE)",
    provider: "ollama",
    paramsBTotal: 30,
    paramsBActive: 3,
    contextWindow: 16384,
    pricing: { inputPerM: 0, outputPerM: 0 },
    tier: "local",
    good_at: ["codegen", "analysis", "simple"],
    speed: "medium",
    notes:
      "ABOVE THE REFERENCE SPEC: ~18GB at Q4, so it needs ~24GB RAM or a 24GB GPU. Listed because only 3B activate per token, so where it does fit it is both the best and the fastest local coder. Leave it disabled on a 16GB machine.",
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
    qualityIndex: 29.7,
    good_at: ["codegen", "analysis", "planning"],
    speed: "medium",
    notes:
      "Gemma 4 31B open weights via the Gemini API. Free tier. Gemma has no " +
      "system role, so the adapter folds the system prompt into the first user turn. " +
      "UNVERIFIED id: listing generativelanguage.googleapis.com needs a key, so this " +
      "is the one entry verify:models cannot check. The weights are confirmed real " +
      "(the OpenRouter route to the same model is enabled above); what is unconfirmed " +
      "is whether Google still serves them under this name. Enable the OpenRouter " +
      "route instead if a call 404s.",
  },
];

/** The deliberately small role roster shown in Settings. Verified against the
 * current Groq and OpenRouter catalogues on 2026-08-31. */
export const MODEL_REGISTRY: ModelEntry[] = [
  { id: 'openrouter:qwen3-next-80b-thinking', apiId: 'qwen/qwen3-next-80b-a3b-thinking', label: 'Planner: Qwen3 Next 80B-A3B Thinking', provider: 'openrouter', paramsBTotal: 80, paramsBActive: 3, contextWindow: 262144, pricing: { inputPerM: .15, outputPerM: 1.2 }, tier: 'payg', qualityIndex: 55, good_at: ['planning', 'analysis'], speed: 'medium', notes: 'Primary planner; thinking-only and tool-capable.' },
  { id: 'groq:llama-3.3-70b', apiId: 'llama-3.3-70b-versatile', label: 'Planner backup: Llama 3.3 70B', provider: 'groq', paramsBTotal: 70, contextWindow: 131072, pricing: { inputPerM: .59, outputPerM: .79 }, tier: 'payg', good_at: ['planning', 'analysis'], speed: 'fast', notes: 'Deprecated by Groq for free/developer tiers; keep only if your account still serves it.' },
  { id: 'openrouter:gemma-4-31b', apiId: 'google/gemma-4-31b-it:free', label: 'Verifier / review: Gemma 4 31B', provider: 'openrouter', paramsBTotal: 31, contextWindow: 262144, pricing: { inputPerM: 0, outputPerM: 0 }, tier: 'free', good_at: ['verification', 'analysis', 'simple'], speed: 'medium' },
  { id: 'groq:qwen3.8-27b', apiId: 'qwen/qwen3.8-27b', label: 'Main coder: Qwen 3.8 27B (Groq)', provider: 'groq', paramsBTotal: 27, contextWindow: 131042, pricing: { inputPerM: .8, outputPerM: 4 }, tier: 'payg', qualityIndex: 68.1, good_at: ['codegen', 'analysis', 'verification', 'simple'], speed: 'fast' },
  { id: 'openrouter:north-mini-code', apiId: 'cohere/north-mini-code:free', label: 'Agentic coder: North Mini Code', provider: 'openrouter', paramsBTotal: 30, paramsBActive: 3, contextWindow: 262144, pricing: { inputPerM: 0, outputPerM: 0 }, tier: 'free', good_at: ['codegen', 'simple'], speed: 'medium' },
  { id: 'openrouter:laguna-xs-2.1', apiId: 'poolside/laguna-xs-2.1:free', label: 'Agentic coder: Laguna XS 2.1', provider: 'openrouter', paramsBTotal: 33, paramsBActive: 3, contextWindow: 262144, pricing: { inputPerM: 0, outputPerM: 0 }, tier: 'free', good_at: ['codegen', 'simple'], speed: 'medium' },
  { id: 'openrouter:qwen3-coder-30b', apiId: 'qwen/qwen3-coder-30b-a3b-instruct', label: 'Agentic coder: Qwen3-Coder-30B-A3B', provider: 'openrouter', paramsBTotal: 30.5, paramsBActive: 3, contextWindow: 262144, pricing: { inputPerM: .07, outputPerM: .27 }, tier: 'payg', good_at: ['codegen', 'simple'], speed: 'medium' },
  { id: 'openrouter:nemotron-3-nano', apiId: 'nvidia/nemotron-3-nano-30b-a3b', label: 'Hard implement: Nemotron 3 Nano 30B-A3B', provider: 'openrouter', paramsBTotal: 30, paramsBActive: 3, contextWindow: 262144, pricing: { inputPerM: .05, outputPerM: .2 }, tier: 'payg', good_at: ['codegen', 'analysis', 'simple'], speed: 'medium' },
];

export type Eligibility = { eligible: boolean; reason: string };

/**
 * The single gate. Everything that picks a model calls this - the router at
 * runtime AND the settings screen at display time - so there is exactly one
 * definition of "allowed" in the codebase and no path around it.
 */
export function checkEligibility(m: ModelEntry): Eligibility {
  if (m.paramsBTotal == null) {
    return {
      eligible: false,
      reason:
        "Provider does not publish a parameter count - unverifiable, treated as ineligible.",
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
  return MODEL_REGISTRY.find((m) => m.id === id) ?? LEGACY_MODEL_REGISTRY.find((m) => m.id === id);
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

/** Return all eligible model IDs from the registry - used by the main process
 *  to auto-populate the enabled pool when the user only picks a core model. */
export function getDefaultEnabledIds(): string[] {
  return MODEL_REGISTRY
    .filter(m => checkEligibility(m).eligible)
    .map(m => m.id);
}
