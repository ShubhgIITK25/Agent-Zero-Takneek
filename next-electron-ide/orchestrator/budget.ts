/**
 * ============================================================================
 *  BUDGET LEDGER — the hard ceilings, enforced before the fact
 * ============================================================================
 * The PS gives two hard ceilings per evaluation task: $0.50 and 2700 seconds.
 * Breaching either scores A=0 for that task "regardless of partial progress".
 *
 * The important design consequence: a ceiling check AFTER a call has already
 * been made is useless, because the money is already spent. So this ledger
 * exposes `canAfford()`, which the orchestrator consults BEFORE dispatching,
 * using a conservative estimate of what the call will cost. If the estimate
 * does not fit, the router is asked for a cheaper model instead, and only if
 * nothing fits does the task stop.
 *
 * We stop at a fraction of the ceiling (RESERVE), not at the ceiling itself,
 * because the orchestrator still needs budget to write out a final answer and
 * because token estimates are approximate. Running to exactly $0.50 and then
 * discovering the estimate was 5% low is the failure mode this avoids.
 */

export type BudgetSnapshot = {
  costUsd: number;
  elapsedSeconds: number;
  promptTokens: number;
  completionTokens: number;
  maxCostUsd: number;
  maxSeconds: number;
};

/** Keep this much of each ceiling in hand for the wrap-up call. */
const COST_RESERVE = 0.08; // 8%
const TIME_RESERVE = 0.06; // 6%

export class Budget {
  private startedAt: number;
  private cost = 0;
  private promptTokens = 0;
  private completionTokens = 0;

  constructor(
    readonly maxCostUsd: number,
    readonly maxSeconds: number,
    /** Non-zero when resuming: spend already booked in a previous session. */
    priorCostUsd = 0,
    priorElapsedSeconds = 0
  ) {
    this.cost = priorCostUsd;
    this.startedAt = Date.now() - priorElapsedSeconds * 1000;
  }

  record(promptTokens: number, completionTokens: number, costUsd: number): void {
    this.promptTokens += promptTokens;
    this.completionTokens += completionTokens;
    this.cost += costUsd;
  }

  get costUsd(): number {
    return this.cost;
  }

  get elapsedSeconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  get costRemaining(): number {
    return Math.max(0, this.maxCostUsd * (1 - COST_RESERVE) - this.cost);
  }

  get timeRemaining(): number {
    return Math.max(0, this.maxSeconds * (1 - TIME_RESERVE) - this.elapsedSeconds);
  }

  /**
   * Would a call estimated at `estimatedCost` still leave us inside the
   * reserved ceiling? Checked before dispatch, never after.
   */
  canAfford(estimatedCost: number): boolean {
    return this.cost + estimatedCost <= this.maxCostUsd * (1 - COST_RESERVE);
  }

  /** Hard stop conditions. Distinct from canAfford: these mean "abort now". */
  breached(): { breached: boolean; which?: 'cost' | 'time'; detail?: string } {
    if (this.cost >= this.maxCostUsd) {
      return { breached: true, which: 'cost', detail: `spent $${this.cost.toFixed(4)} of $${this.maxCostUsd} ceiling` };
    }
    if (this.elapsedSeconds >= this.maxSeconds) {
      return { breached: true, which: 'time', detail: `${Math.round(this.elapsedSeconds)}s of ${this.maxSeconds}s ceiling` };
    }
    return { breached: false };
  }

  /** True once we are inside the reserve — time to wrap up, not start work. */
  inReserve(): boolean {
    return this.costRemaining <= 0 || this.timeRemaining <= 0;
  }

  /**
   * How much of each spendable ceiling is still in hand, as 0..1.
   *
   * `canAfford` answers "can I pay for this one call", which is the wrong
   * question for a decision that commits to a whole extra round of work. The
   * re-planner uses this instead: replanning buys a planner call PLUS two or
   * three fresh subtask executions, so it is only worth starting while a
   * meaningful share of BOTH ceilings remains. Starting a re-plan at 90% spent
   * reliably converts a partial result into a ceiling breach, which scores
   * zero — strictly worse than accepting the failed subtask.
   */
  get fractionRemaining(): { cost: number; time: number } {
    const spendableCost = this.maxCostUsd * (1 - COST_RESERVE);
    const spendableTime = this.maxSeconds * (1 - TIME_RESERVE);
    return {
      cost: spendableCost > 0 ? this.costRemaining / spendableCost : 0,
      time: spendableTime > 0 ? this.timeRemaining / spendableTime : 0,
    };
  }

  snapshot(): BudgetSnapshot {
    return {
      costUsd: this.cost,
      elapsedSeconds: this.elapsedSeconds,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      maxCostUsd: this.maxCostUsd,
      maxSeconds: this.maxSeconds,
    };
  }
}
