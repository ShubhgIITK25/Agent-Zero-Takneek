/**
 * ============================================================================
 *  ROUTER — pick a model + provider per subtask, from real signals
 * ============================================================================
 * The requirement is not "have a router", it is "the decision must be based on
 * real, sensible signals" and "the routing decision can never be hidden". So
 * this scores candidates explicitly and returns the losing candidates with the
 * reason each lost, which the UI renders next to the winner. A router that
 * cannot explain a rejection is a router nobody can defend in Q&A.
 *
 * WHY SCORING AND NOT AN LLM CALL:
 * A tempting design is "ask a model which model to use". We rejected it: it
 * adds a full round-trip of latency and cost to every subtask (directly
 * hurting both terms of S_task) to answer a question that four numbers answer
 * deterministically. It is also unexplainable and unreproducible — the same
 * subtask could route differently twice, which makes the dashboard's routing
 * trace worthless as a debugging tool. Deterministic scoring is cheaper,
 * faster, reproducible, and defensible line by line.
 *
 * WHY NOT STATIC PER-CATEGORY MAPPING (codegen -> big, simple -> small):
 * That was the first version and it fails on the two signals that actually
 * move the score: it will happily route a 60k-token context to a 32k model,
 * and it keeps picking a provider that is currently rate-limited. Capability
 * matching is necessary but not sufficient.
 *
 * SCORE = capability fit + context fit + cost pressure + speed tiebreak,
 * with hard filters applied first (eligibility, context window, cooldown).
 */

import { ModelEntry, checkEligibility, findModel, costOf } from './models';
import { RoutingSignals, Subtask } from './protocol';

export type RouteResult = {
  model: ModelEntry;
  reason: string;
  rejected: { modelId: string; why: string }[];
  signals: RoutingSignals;
};

export class RateLimitTracker {
  /** provider -> epoch ms until which it is in backoff */
  private cooldownUntil = new Map<string, number>();
  private consecutiveFailures = new Map<string, number>();

  /** Exponential backoff, capped — a 429 storm should not park a provider forever. */
  penalise(provider: string, rateLimited: boolean): void {
    const n = (this.consecutiveFailures.get(provider) ?? 0) + 1;
    this.consecutiveFailures.set(provider, n);
    const baseMs = rateLimited ? 20_000 : 5_000;
    const waitMs = Math.min(baseMs * Math.pow(2, n - 1), 120_000);
    this.cooldownUntil.set(provider, Date.now() + waitMs);
  }

  clear(provider: string): void {
    this.consecutiveFailures.delete(provider);
    this.cooldownUntil.delete(provider);
  }

  inCooldown(provider: string): boolean {
    const until = this.cooldownUntil.get(provider);
    return until != null && until > Date.now();
  }

  cooldownList(): string[] {
    return [...this.cooldownUntil.entries()].filter(([, t]) => t > Date.now()).map(([p]) => p);
  }
}

const CATEGORY_TO_CAPABILITY: Record<Subtask['category'], ModelEntry['good_at'][number]> = {
  analysis: 'analysis',
  codegen: 'codegen',
  simple_edit: 'simple',
  verification: 'verification',
};

/** Assume a completion roughly this size when pre-costing a call. */
const ASSUMED_COMPLETION_TOKENS = 800;

/**
 * How hard a model's published quality index counts, per category.
 *
 * Not a flat weight, because the cost of being wrong is not flat. A bad
 * `simple_edit` is discovered on the next line. A bad plan is discovered after
 * every subtask under it has already been paid for, and a bad verification
 * verdict is never discovered at all — it ships. The planner and the tie-break
 * both route as `analysis`, and the verifier as `verification`, so weighting
 * those two categories is precisely how "spend quality where it matters" is
 * expressed in this router.
 *
 * Cost still dominates: the penalty term below reaches 45, so a free model
 * that fits keeps beating a paid one early in a task. That is intended — C is
 * weighted ~2x T in S_task. Quality decides between models of similar price.
 */
const QUALITY_WEIGHT: Record<Subtask['category'], number> = {
  analysis: 0.45,
  verification: 0.4,
  codegen: 0.3,
  simple_edit: 0.1,
};

/**
 * A single 0-100 capability number for a model.
 *
 * Parameter count was the original proxy and it has aged badly: llama-3.3-70b
 * is 2.6x the size of qwen3.8-27b and scores 11.9 against its 68.1 on coding.
 * So prefer the published benchmark index, and fall back to size only for
 * models nobody has scored — capped well below the top of the index, because
 * "big and unmeasured" is not evidence of being good.
 */
function capabilityOf(m: ModelEntry): number {
  if (m.qualityIndex != null) return m.qualityIndex;
  return Math.min(30, (m.paramsBTotal ?? 0) * 0.4);
}

export class Router {
  constructor(
    private enabledModelIds: string[],
    private rateLimits: RateLimitTracker
  ) {}

  /** Models the user enabled AND that pass the parameter-count gate. */
  private candidates(): ModelEntry[] {
    return this.enabledModelIds
      .map((id) => findModel(id))
      .filter((m): m is ModelEntry => !!m && checkEligibility(m).eligible);
  }

  route(signals: RoutingSignals, opts: { excludeModelIds?: string[] } = {}): RouteResult | null {
    const exclude = new Set(opts.excludeModelIds ?? []);
    const rejected: { modelId: string; why: string }[] = [];
    const wanted = CATEGORY_TO_CAPABILITY[signals.category];

    type Scored = { model: ModelEntry; score: number; parts: string[] };
    const scored: Scored[] = [];

    for (const m of this.candidates()) {
      // ---- hard filters: a failure here is disqualifying, not a low score ---
      if (exclude.has(m.id)) {
        rejected.push({ modelId: m.id, why: 'already tried and failed on this subtask' });
        continue;
      }
      if (this.rateLimits.inCooldown(m.provider)) {
        rejected.push({ modelId: m.id, why: `provider ${m.provider} is in rate-limit backoff` });
        continue;
      }
      // Leave room for the reply, not just the prompt.
      if (signals.estimatedContextTokens + ASSUMED_COMPLETION_TOKENS > m.contextWindow) {
        rejected.push({
          modelId: m.id,
          why: `context ~${signals.estimatedContextTokens} tok exceeds its ${m.contextWindow} window`,
        });
        continue;
      }
      const projectedCost = costOf(m, signals.estimatedContextTokens, ASSUMED_COMPLETION_TOKENS);
      if (projectedCost > signals.budgetRemaining) {
        rejected.push({
          modelId: m.id,
          why: `projected $${projectedCost.toFixed(4)} exceeds $${signals.budgetRemaining.toFixed(4)} remaining`,
        });
        continue;
      }

      // ---- soft scoring -----------------------------------------------------
      let score = 0;
      const parts: string[] = [];

      if (m.good_at.includes(wanted)) {
        score += 40;
        parts.push(`fits ${signals.category}`);
      } else {
        score -= 25;
        parts.push(`not tuned for ${signals.category}`);
      }

      // Cost pressure scales with how tight the remaining budget is: early in a
      // task a capable model is worth paying for; near the ceiling, cheap wins.
      // This is the mechanism that keeps us under $0.50 instead of hoping.
      const budgetPressure = signals.budgetRemaining > 0
        ? Math.min(1, projectedCost / (signals.budgetRemaining * 0.35))
        : 1;
      const costPenalty = budgetPressure * 45;
      score -= costPenalty;
      if (projectedCost === 0) {
        score += 18;
        parts.push('zero marginal cost');
      } else {
        parts.push(`~$${projectedCost.toFixed(4)}`);
      }

      // Headroom is good, but a 131k model on a 2k prompt is wasted money —
      // reward enough room, do not reward maximum room.
      const headroom = m.contextWindow / Math.max(1, signals.estimatedContextTokens);
      if (headroom > 3) score += 8;

      // Published capability, weighted by how expensive a wrong answer is in
      // this category. See QUALITY_WEIGHT.
      const capability = capabilityOf(m);
      score += capability * QUALITY_WEIGHT[signals.category];
      if (m.qualityIndex != null) parts.push(`quality ${m.qualityIndex}`);

      // Retries escalate: if a weaker model already failed this subtask, bias
      // toward capability over thrift. Repeating the cheap failure is the exact
      // "blindly retrying the same action" the PS penalises.
      if (signals.attemptNumber > 1) {
        score += Math.min(22, capability * 0.38);
        parts.push(`escalated for attempt ${signals.attemptNumber}`);
      }

      // Time is the lighter term (w_T 0.35 vs w_C 0.65) so speed only breaks ties.
      score += m.speed === 'fast' ? 6 : m.speed === 'medium' ? 3 : 0;

      scored.push({ model: m, score, parts });
    }

    if (scored.length === 0) return null;

    scored.sort((a, b) => b.score - a.score);
    const winner = scored[0];
    for (const loser of scored.slice(1)) {
      rejected.push({ modelId: loser.model.id, why: `scored ${loser.score.toFixed(1)} vs ${winner.score.toFixed(1)}` });
    }

    return {
      model: winner.model,
      reason: `${winner.model.label} (${winner.model.provider}): ${winner.parts.join(', ')}`,
      rejected,
      signals,
    };
  }

  /**
   * Failover: same subtask, same context, different model — used when a call
   * fails or the provider rate-limits. Progress is preserved because the
   * caller keeps the conversation and only swaps the model underneath it.
   */
  routeFallback(signals: RoutingSignals, failedModelIds: string[]): RouteResult | null {
    return this.route({ ...signals, escalated: true }, { excludeModelIds: failedModelIds });
  }
}
