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

/**
 * ============================================================================
 *  HEALTH REGISTRY — what we know, and what we have just learned, about models
 * ============================================================================
 * The Settings screen probes every provider's catalogue and labels each model
 * working / invalid-key / rate-limited / unavailable / offline. Until now that
 * verdict lived and died in the renderer: the router never saw it, so a model
 * the user could plainly see marked "unavailable" was still a routing
 * candidate, and every subtask rediscovered the same 404 at full price.
 *
 * This merges two sources of truth, and the ORDER matters:
 *
 *   1. RUNTIME EVIDENCE beats everything. A call that just returned 404 for a
 *      model id proves that id is not served, whatever a probe said earlier;
 *      and a call that just SUCCEEDED proves the model works, whatever a stale
 *      probe said. Runtime evidence is therefore checked first, in both
 *      directions.
 *   2. THE HEALTH SNAPSHOT fills the gap before any call has been made — which
 *      is exactly the window where the old behaviour wasted the most money,
 *      because nothing had failed yet to teach the router anything.
 *
 * WHAT IS DELIBERATELY *NOT* BLOCKED:
 *   - `rate-limited`: a quota resets. The provider cooldown in
 *     RateLimitTracker is the right tool — it expires; a health block does not.
 *   - `unknown` / missing: "never probed" is not evidence of breakage. Blocking
 *     on absent data would mean a user who never opened Settings can route
 *     nowhere at all.
 * Both of those would trade a wasted call for a task that cannot run, which is
 * the worse failure.
 */
export type HealthSnapshot = { state: string; detail: string; checkedAt: number };

/** Runtime scope of a failure: the model id itself, or the whole provider. */
export type HealthBlockScope = 'model' | 'provider' | null;

export class HealthRegistry {
  private snapshot: Record<string, HealthSnapshot>;
  /** modelId -> why, learned this task. */
  private modelBlocks = new Map<string, string>();
  /** provider -> why, learned this task. */
  private providerBlocks = new Map<string, string>();
  /** Models that have actually answered us. Overrides any snapshot claim. */
  private provenGood = new Set<string>();

  constructor(snapshot: Record<string, HealthSnapshot> = {}) {
    this.snapshot = snapshot ?? {};
  }

  /** Why this model must not be routed to right now, or null if it may be. */
  blockReason(modelId: string, provider: string): string | null {
    const runtimeModel = this.modelBlocks.get(modelId);
    if (runtimeModel) return runtimeModel;
    const runtimeProvider = this.providerBlocks.get(provider);
    if (runtimeProvider) return runtimeProvider;

    // A model that has answered us this task is good, whatever the probe said.
    if (this.provenGood.has(modelId)) return null;

    const state = this.snapshot[modelId]?.state;
    if (state === 'unavailable') {
      return `health check: ${provider} does not serve this model id`;
    }
    if (state === 'invalid-key') {
      return `health check: ${provider} rejected the configured API key`;
    }
    if (state === 'offline') {
      return `health check: ${provider} was unreachable or has no key configured`;
    }
    // working / rate-limited / unknown / never probed -> routable.
    return null;
  }

  /** A call came back. Clears any block; the model demonstrably works. */
  recordSuccess(modelId: string, provider: string): void {
    this.provenGood.add(modelId);
    this.modelBlocks.delete(modelId);
    this.providerBlocks.delete(provider);
  }

  /**
   * A call failed. Returns the scope actually blocked so the caller can say so.
   *
   * Only failures that will repeat identically are recorded. A 500, a timeout
   * or a 429 are moments, not verdicts, and belong to the cooldown. An
   * ambiguous 400 is not attributed either: it is at least as likely to be our
   * malformed request as a bad model, and blocking every model in turn for a
   * bug in our own payload would take the whole roster down.
   */
  recordFailure(
    modelId: string,
    provider: string,
    err: { status?: number; retryable: boolean; message: string }
  ): HealthBlockScope {
    if (err.retryable) return null;

    if (err.status === 401 || err.status === 403) {
      this.providerBlocks.set(provider, `${provider} rejected the API key at run time (${err.status})`);
      return 'provider';
    }
    if (err.status === 404 || /model[^.]{0,40}(not found|does not exist|unknown|decommissioned)/i.test(err.message)) {
      this.modelBlocks.set(modelId, `${provider} does not serve this model id (observed at run time)`);
      return 'model';
    }
    return null;
  }

  /** Everything currently blocked, for the dashboard and for tests. */
  blocks(): { scope: 'model' | 'provider'; id: string; why: string }[] {
    return [
      ...[...this.modelBlocks].map(([id, why]) => ({ scope: 'model' as const, id, why })),
      ...[...this.providerBlocks].map(([id, why]) => ({ scope: 'provider' as const, id, why })),
    ];
  }
}

export class RateLimitTracker {
  /** provider -> epoch ms until which it is in backoff */
  private cooldownUntil = new Map<string, number>();
  private consecutiveFailures = new Map<string, number>();
  /** provider -> why it is waiting, in words a person can act on. */
  private reason = new Map<string, string>();

  /**
   * Back off for as long as the situation actually warrants.
   *
   * Blind exponential backoff was wrong in both directions. Against a
   * PER-DAY quota it is far too short: the quota does not reset for hours, so
   * every retry buys another 429, another wasted round-trip, and another
   * alarming line in the chat — which is exactly the behaviour that made a
   * spent free tier look like a broken system. Against a per-minute quota it
   * is often too long, when the provider has told us precisely when it will
   * accept traffic again.
   *
   * So: use the provider's own hint when it gave one; treat a daily quota as
   * spent for the rest of this task; otherwise fall back to exponential.
   */
  penalise(
    provider: string,
    rateLimited: boolean,
    hint: { quotaScope?: 'minute' | 'day' | 'unknown'; retryAfterMs?: number; note?: string } = {}
  ): void {
    const n = (this.consecutiveFailures.get(provider) ?? 0) + 1;
    this.consecutiveFailures.set(provider, n);

    let waitMs: number;
    let why: string;
    if (hint.quotaScope === 'day') {
      // Long enough to outlive any single task. Not permanent: a resumed task
      // hours later should try again rather than inherit today's verdict.
      waitMs = 6 * 60 * 60_000;
      why = hint.note ?? 'daily quota spent';
    } else if (hint.retryAfterMs != null && hint.retryAfterMs > 0) {
      // Trust the provider, plus a second of margin for clock skew.
      waitMs = Math.min(hint.retryAfterMs + 1_000, 6 * 60 * 60_000);
      why = hint.note ?? 'provider asked us to wait';
    } else {
      const baseMs = rateLimited ? 20_000 : 5_000;
      waitMs = Math.min(baseMs * Math.pow(2, n - 1), 120_000);
      why = hint.note ?? (rateLimited ? 'rate limited' : 'call failed');
    }

    this.cooldownUntil.set(provider, Date.now() + waitMs);
    this.reason.set(provider, why);
  }

  clear(provider: string): void {
    this.consecutiveFailures.delete(provider);
    this.cooldownUntil.delete(provider);
    this.reason.delete(provider);
  }

  /** Seconds remaining, for a message a person can act on. 0 if not waiting. */
  cooldownRemainingSeconds(provider: string): number {
    const until = this.cooldownUntil.get(provider);
    if (until == null || until <= Date.now()) return 0;
    return Math.ceil((until - Date.now()) / 1000);
  }

  /** Why this provider is waiting, for the routing trace. */
  cooldownReason(provider: string): string | null {
    return this.inCooldown(provider) ? this.reason.get(provider) ?? 'rate limited' : null;
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
const ASSUMED_COMPLETION_TOKENS = 600;

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
    private rateLimits: RateLimitTracker,
    /** Defaulted so existing callers and tests keep working unchanged. */
    private health: HealthRegistry = new HealthRegistry()
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
      // Health first: this is the only filter that can rule a model out
      // BEFORE it has cost anything, which is the whole point of it.
      const unhealthy = this.health.blockReason(m.id, m.provider);
      if (unhealthy) {
        rejected.push({ modelId: m.id, why: unhealthy });
        continue;
      }
      if (this.rateLimits.inCooldown(m.provider)) {
        // Say what is being waited on and for how long. "in backoff" told the
        // user nothing they could act on; "daily quota spent, 5h58m" tells
        // them to switch provider rather than sit and retry.
        const secs = this.rateLimits.cooldownRemainingSeconds(m.provider);
        const human =
          secs >= 3600 ? `${Math.round(secs / 360) / 10}h` : secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`;
        rejected.push({
          modelId: m.id,
          why: `${m.provider}: ${this.rateLimits.cooldownReason(m.provider)} — retrying in ~${human}`,
        });
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
