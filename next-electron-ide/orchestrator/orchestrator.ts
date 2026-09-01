/**
 * ============================================================================
 *  ORCHESTRATOR - the pipeline
 * ============================================================================
 *   ingest -> decompose -> [ route -> execute -> verify -> retry? ]* -> aggregate
 *   with a checkpoint written at every step boundary.
 *
 * THE THREE INDEPENDENT CAPS, and why three rather than one:
 *   retries  (per subtask)  catches "same approach failing repeatedly"
 *   steps    (per subtask)  catches "making tool calls forever without finishing"
 *   tokens   (per subtask)  catches "each step is cheap but there are hundreds"
 * A single step cap misses the third case entirely: 40 cheap steps and 6
 * expensive ones both hit "6 steps" at wildly different costs. They are
 * genuinely different failure modes, so they get genuinely different limits.
 * Whichever fires first halts the subtask and EMITS AN INTERVENTION - never a
 * silent stop, because a failsafe nobody can see is a failsafe nobody trusts.
 *
 * ESCALATION, NOT REPETITION: when a subtask fails, the retry does not re-run
 * the same model on the same context. `attemptNumber` feeds the router, which
 * biases toward a more capable model, and the failure reason is fed back into
 * the conversation so the next attempt knows what went wrong. Blindly retrying
 * the same action is the specific behaviour the PS calls out.
 *
 * DISAGREEMENT: implementer says done, verifier says fail. Neither wins by
 * default. If the verifier is confident, its fail stands. If it is unsure
 * (confidence < 0.6) we spend one call on a third model and take its answer.
 * Silently trusting either side is the thing we are avoiding.
 */

import {
  ApprovalDecision,
  EventBody,
  FileDiff,
  PendingApproval,
  RoutingSignals,
  Subtask,
  TaskConfig,
} from './protocol';
import { Budget } from './budget';
import { Router, RateLimitTracker, HealthRegistry, ASSUMED_COMPLETION_TOKENS } from './router';
import { ModelEntry, checkEligibility, findModel, eligibleModels, costOf } from './models';
import { callModel, ChatMessage, estimateMessageTokens, estimateTokens, ProviderError, ToolCall } from './providers';
import { TaskStore, TaskSnapshot } from './store';
import { TOOLS, TOOL_SCHEMAS, VERIFIER_TOOL_SCHEMAS, findTool, ToolContext } from './tools';
import { compact, shouldCompact } from './compaction';
import { loadAgentsMd, agentsMdSystemMessage } from './agentsmd';
import { loadIgnoreMatcher } from './ignore';
import * as agents from './agents';
import { applyAcceptedBlocks } from './diff';
import * as fs from 'fs/promises';
import * as path from 'path';
import { extractJson } from './agents';

const MAX_RETRIES_PER_SUBTASK = 3;
const MAX_STEPS_PER_SUBTASK = 12;
const MAX_TOKENS_PER_SUBTASK = 60_000;
const MAX_IDENTICAL_REPEATS = 3;

// ---------------------------------------------------------------------------
// Re-planning bounds
// ---------------------------------------------------------------------------
// Re-planning is the one mechanism here that can ADD work to a task that is
// already going badly, so every one of these is a hard stop rather than a
// heuristic. Together they bound the worst case at:
//   2 re-plans x (1 planner call + 3 subtasks x 3 retries x 12 steps)
// and the budget/time gates below cut it off long before that in practice.
//
// Why re-plan at all: the retry ladder already re-runs a subtask on a stronger
// model with the verifier's complaint fed back in. If all three of those fail,
// the model is not the problem - the subtask is. A fourth retry is exactly the
// "blindly retrying the same action" the PS penalises; changing the plan is the
// only remaining lever.

/** Whole-task budget. A task gets this many re-plans total, not per subtask. */
/**
 * Below this fraction of the cost ceiling, parallelism is switched off. See
 * the scheduler: concurrent dispatches can each pass the affordability check
 * and still breach together.
 */
const PARALLEL_BUDGET_FLOOR = 0.25;

const MAX_REPLANS_PER_TASK = 2;
/** Only original (depth-0) subtasks may be re-planned, so replacements that
 *  fail are simply failed - no recursive tree of re-plans. */
const MAX_REPLAN_DEPTH = 1;
/** Cap on how far one re-plan may widen the DAG. */
const MAX_REPLACEMENTS_PER_REPLAN = 3;
/** Do not START a re-plan unless this share of each ceiling is still in hand.
 *  A re-plan buys a planner call plus a fresh round of subtask work; beginning
 *  one at 90% spent reliably converts a partial result into a ceiling breach,
 *  and a breach scores zero - strictly worse than accepting the failure. */
const REPLAN_MIN_COST_FRACTION = 0.25;
const REPLAN_MIN_TIME_FRACTION = 0.2;

export type Emit = (body: EventBody) => void;

let nodeCounter = 0;
const newNodeId = () => `n${++nodeCounter}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TaskRunner {
  private budget: Budget;
  private router: Router;
  private rateLimits = new RateLimitTracker();
  /** Seeded from the Settings probe, then corrected by what actually happens. */
  private health: HealthRegistry;
  private cancelled = false;
  private activeAbortController: AbortController | null = null;
  private pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
  private snapshot: TaskSnapshot;
  private step = 0;
  private notes: string[] = [];
  private changedFiles = new Set<string>();
  /**
   * BACKTRACK POINT - the workspace as it stood before the subtask now running
   * touched it. Captured lazily: the first time a subtask writes a given file,
   * that file's prior content is stashed here (`content: null` == the file did
   * not exist yet). Restoring this map undoes every edit the subtask made.
   *
   * Why lazily and per-file rather than a snapshot of the tree: we do not know
   * in advance which files an agent will touch, and copying a repo before every
   * attempt would cost more than the task. Capturing at the moment of write is
   * exact, costs one read per distinct file, and needs no VCS.
   *
   * Why not `git stash` / `git checkout .`: the project root is not guaranteed
   * to be a git repo, and even when it is, an agent that reaches into the user's
   * index or stash to undo its own mistake is a far worse failure mode than the
   * one it is fixing. This state is entirely our own.
   */
  /**
   * KEYED BY SUBTASK. With subtasks running in parallel there is no single
   * "current" backtrack point: two subtasks editing at once would otherwise
   * share one undo map, and rolling back a failed subtask would revert the
   * other one's approved edits along with its own.
   */
  private backtrack = new Map<string, Map<string, { content: string | null; wasTracked: boolean }>>();
  /** Controlled writes per subtask, for durable rollback history. */
  private activeFileChanges = new Map<string, { changeId: string; path: string }[]>();
  /**
   * Files each subtask changed. The verifier is told what to check, and under
   * parallelism the global set would hand it another subtask's files and
   * invite it to fail work it was never asked to judge.
   */
  private changedBySubtask = new Map<string, Set<string>>();
  /**
   * ONE approval outstanding at a time, across every parallel subtask.
   *
   * This is not a nicety. The review UI holds exactly one pending diff, so a
   * second concurrent approval_request would replace the first in the
   * renderer - and the first request's promise, which an agent is blocked on,
   * would never resolve. That is a permanent hang, not a glitch. Serialising
   * here also makes propose -> approve -> write a critical section, which is
   * half of what keeps two subtasks from interleaving writes to one file.
   */
  private approvalGate: Promise<void> = Promise.resolve();
  /** Last concurrency set emitted, so the event fires on change rather than per tick. */
  private lastConcurrencyKey = '';
  /**
   * Providers we have already explained a rate limit for, keyed by quota.
   *
   * Without this, three parallel subtasks hitting the same spent free tier
   * produce three identical notices, and a long task produces one per subtask
   * - turning a single fact ("this provider is out of quota today") into a
   * wall of repetition that buries everything else.
   */
  private reportedRateLimits = new Set<string>();
  /** Re-plans spent on this task. Bounded by MAX_REPLANS_PER_TASK. */
  private replansUsed = 0;
  /** .nexideignore / .ignore - loaded once per task, not re-read on every tool call. */
  private ignore: ReturnType<typeof loadIgnoreMatcher>;
  /**
   * CALL HIERARCHY. Every node the dashboard draws hangs off one of these two.
   *
   * The tree is CAUSAL, not chronological: a node's parent is the call that
   * caused it to happen. The planner is the root because it produced the
   * subtasks; a verifier hangs off the implementer whose claim it is judging;
   * a retry hangs off the verifier that rejected the previous attempt. Read
   * top-down that spells out *why* the task did what it did, which a flat list
   * ordered by time cannot express - in a flat list, attempt 2 and the verifier
   * that forced it are just two adjacent rows.
   *
   * Steps within one attempt stay SIBLINGS rather than chaining into each
   * other. They are sequential turns in one conversation, not nested calls, and
   * chaining them would bury a 12-step loop twelve levels deep for no gain.
   */
  private planNodeId: string | null = null;
  /** Most recent successful node per subtask - the anchor the next call hangs off. */
  private lastNodeBySubtask = new Map<string, string>();

  constructor(
    readonly taskId: string,
    private prompt: string,
    private config: TaskConfig,
    private store: TaskStore,
    private emit: Emit,
    private echoToTerminal: (cmd: string) => void,
    resumeFrom: TaskSnapshot | null
  ) {
    this.budget = new Budget(
      config.maxCostUsd,
      config.maxSeconds,
      resumeFrom?.costUsd ?? 0,
      // Elapsed time does NOT carry over across a resume: the 2700s ceiling is
      // wall-clock for the evaluation run, and a task resumed the next morning
      // has not been burning the clock overnight. Cost DOES carry over, since
      // dollars already spent are spent.
      0
    );
    this.health = new HealthRegistry(config.modelHealth ?? {});
    this.router = new Router(
      config.enabledModelIds,
      this.rateLimits,
      this.health,
      config.customModels ?? [],
      config.coreModelId,
      config.minVerifierQuality,
    );

    const agentsMd = loadAgentsMd(config.rootPath);
    this.ignore = loadIgnoreMatcher(config.rootPath);
    if (this.ignore.sourceFile) {
      emit({
        type: 'log',
        level: 'info',
        message: `Context ignore: ${this.ignore.patternCount} pattern(s) loaded from ${this.ignore.sourceFile} - matching paths are excluded from retrieve_context, read_file and list_dir.`,
      });
    }
    this.snapshot = resumeFrom ?? {
      taskId,
      codebaseId: config.codebaseId,
      rootPath: config.rootPath,
      prompt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      step: 0,
      status: 'running',
      subtasks: [],
      conversations: {},
      costUsd: 0,
      elapsedSeconds: 0,
      pinnedFacts: agentsMd ? agentsMd.rules : [],
      agentsMd: agentsMd ? agentsMdSystemMessage(agentsMd) : null,
    };
    this.step = this.snapshot.step;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.activeAbortController?.abort();
    this.snapshot.status = 'cancelled';
    this.checkpoint();
    this.emit({ type: 'task_cancelled' });
    // Unblock anything waiting on a human so the process can wind down rather
    // than sitting on a promise that will never resolve.
    for (const [requestId, resolve] of this.pendingApprovals) {
      resolve({ requestId, approved: false, acceptedBlockIds: [] });
    }
    this.pendingApprovals.clear();
  }

  resolveApproval(decision: ApprovalDecision): void {
    const resolver = this.pendingApprovals.get(decision.requestId);
    if (resolver) {
      this.pendingApprovals.delete(decision.requestId);
      resolver(decision);
    }
  }

  // -------------------------------------------------------------- helpers ---

  /**
   * Announce which subtasks are executing right now, but only when the SET
   * changes - a per-tick heartbeat would bury the dashboard in noise and still
   * not say anything a changed set does not.
   */
  private emitConcurrency(runningIds: string[], maxParallel: number): void {
    const key = [...runningIds].sort().join('|');
    if (key === this.lastConcurrencyKey) return;
    this.lastConcurrencyKey = key;
    this.emit({
      type: 'concurrency',
      running: runningIds.map((id) => ({
        subtaskId: id,
        title: this.snapshot.subtasks.find((s) => s.id === id)?.title ?? id,
      })),
      maxParallel,
    });
  }

  private checkpoint(): void {
    this.step += 1;
    this.snapshot.step = this.step;
    this.snapshot.updatedAt = Date.now();
    this.snapshot.costUsd = this.budget.costUsd;
    this.snapshot.elapsedSeconds = this.budget.elapsedSeconds;
    this.store.saveSnapshot(this.snapshot);
    this.emit({
      type: 'checkpoint',
      step: this.step,
      subtaskStates: this.snapshot.subtasks.map((s) => ({ id: s.id, status: s.status })),
    });
  }

  private emitBudget(): void {
    const b = this.budget.snapshot();
    this.emit({
      type: 'budget_update',
      costUsd: b.costUsd,
      elapsedSeconds: b.elapsedSeconds,
      maxCostUsd: b.maxCostUsd,
      maxSeconds: b.maxSeconds,
      promptTokens: b.promptTokens,
      completionTokens: b.completionTokens,
    });
  }

  /** Hard ceiling check, run before every dispatch. */
  private ceilingBreached(): boolean {
    const b = this.budget.breached();
    if (b.breached) {
      this.emit({
        type: 'intervention',
        subtaskId: null,
        cause: b.which === 'cost' ? 'cost_ceiling' : 'time_ceiling',
        detail: b.detail ?? '',
        action: 'Halting the task. Exceeding a ceiling scores zero, so stopping beats continuing.',
      });
      return true;
    }
    return false;
  }

  private toolContext(subtaskId: string, nodeId: string): ToolContext {
    return {
      rootPath: this.config.rootPath,
      codebaseId: this.config.codebaseId,
      retrievalUrl: this.config.retrievalUrl,
      ignore: this.ignore,
      echoToTerminal: this.echoToTerminal,
      proposeDiff: (diffs, summary) => this.requestDiffApproval(subtaskId, nodeId, diffs, summary),
    };
  }

  /**
   * Raise an approval request and BLOCK until the UI answers. This is the
   * blocking round-trip: the orchestrator genuinely stops here.
   */
  /** Serialises whatever it wraps against every other approval in the task. */
  private async withApprovalGate<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.approvalGate;
    let release!: () => void;
    this.approvalGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private requestDiffApproval(
    subtaskId: string,
    nodeId: string,
    diffs: FileDiff[],
    summary: string
  ): Promise<{ approved: boolean; written: string[]; fullyApplied: boolean; rejectedBlocks: number; stale: string[] }> {
    return this.withApprovalGate(() => this.requestDiffApprovalLocked(subtaskId, nodeId, diffs, summary));
  }

  private requestCommandApproval(subtaskId: string, command: string): Promise<boolean> {
    return this.withApprovalGate(() => this.requestCommandApprovalLocked(subtaskId, command));
  }

  private async requestDiffApprovalLocked(
    subtaskId: string,
    nodeId: string,
    diffs: FileDiff[],
    summary: string
  ): Promise<{ approved: boolean; written: string[]; fullyApplied: boolean; rejectedBlocks: number; stale: string[] }> {
    const requestId = `ap_${this.taskId}_${++nodeCounter}`;
    const request: PendingApproval = { requestId, taskId: this.taskId, kind: 'diff', subtaskId, summary, diff: diffs };

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.pendingApprovals.set(requestId, resolve);
      this.emit({ type: 'approval_request', request });
    });

    this.emit({
      type: 'approval_resolved',
      requestId,
      approved: decision.approved,
      acceptedBlockIds: decision.acceptedBlockIds ?? [],
    });

    if (!decision.approved) return { approved: false, written: [], fullyApplied: false, rejectedBlocks: 0, stale: [] };

    // An explicit list means block-level review; its absence means a plain
    // accept-all. `null`, not a pre-expanded list, so the per-file fallback
    // below can tell "user reviewed and picked none here" from "no list sent".
    const explicit = Array.isArray(decision.acceptedBlockIds) ? decision.acceptedBlockIds : null;
    const written: string[] = [];
    const stale: string[] = [];
    let fullyApplied = true;
    let rejectedBlocks = 0;

    for (const d of diffs) {
      const blockIds = d.blocks.map((b) => b.id);
      if (blockIds.length === 0) continue;

      let acceptedHere = explicit ? blockIds.filter((id) => explicit.includes(id)) : blockIds;

      // Approved, but nothing here matched - an id/serialisation mismatch, not
      // a real rejection (the UI disables "Accept" at zero selected). Landing
      // nothing on disk after an approval is exactly what makes the agent
      // re-propose forever, so apply the whole change and say so.
      if (acceptedHere.length === 0) {
        this.emit({
          type: 'log',
          level: 'warn',
          message: `Approval for ${d.path} carried no matching block ids (${explicit?.length ?? 0} sent); applying the full change.`,
        });
        acceptedHere = blockIds;
      }

      const finalContent = applyAcceptedBlocks(d, acceptedHere);
      const cleanPath = d.path.replace(/^[a-zA-Z]:/, '').replace(/^\/+/, '');
      const full = path.resolve(this.config.rootPath, cleanPath);
      let beforeContent: string | null = null;
      try {
        beforeContent = await fs.readFile(full, 'utf8');
      } catch {
        // New file: the safe revert state is "does not exist".
      }
      // THE READ-MODIFY-WRITE RACE. The diff was computed against the file as
      // it looked when the agent proposed it. If the bytes on disk have moved
      // since - a parallel subtask's approved edit, or the user typing in the
      // editor while the review sat open - then these hunks describe a file
      // that no longer exists, and writing them would silently revert whoever
      // got there first. Serialising approvals is not enough to prevent this;
      // only comparing against what was actually read is.
      if ((beforeContent ?? null) !== (d.oldContent ?? null)) {
        stale.push(d.path);
        fullyApplied = false;
        this.emit({
          type: 'intervention',
          subtaskId,
          cause: 'stale_proposal',
          detail: `${d.path} changed on disk after this edit was proposed, so the approved hunks no longer match the file.`,
          action: 'Refusing the write and telling the agent to re-read the file and propose again - applying it would silently undo the other change.',
        });
        continue;
      }
      // Stash what is there now, BEFORE overwriting it, so a failed
      // verification can put it back. Must happen on the write path - this is
      // the only point at which the pre-edit content still exists.
      await this.captureBacktrackPoint(subtaskId, d.path, full);
      const changeId = `chg_${this.taskId}_${Date.now()}_${++nodeCounter}`;
      // Persist the before-state before touching the workspace. If the task
      // data directory is unavailable, the write is not attempted and the
      // later revert action cannot promise a safe recovery.
      const fileChange = this.store.recordFileChange(
        changeId,
        d.path,
        beforeContent,
        finalContent,
      );
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, finalContent, 'utf8');
      written.push(d.path);
      this.changedFiles.add(d.path);
      let mine = this.changedBySubtask.get(subtaskId);
      if (!mine) {
        mine = new Set<string>();
        this.changedBySubtask.set(subtaskId, mine);
      }
      mine.add(d.path);
      const log = this.activeFileChanges.get(subtaskId);
      if (log) log.push({ changeId, path: d.path });
      this.emit({ type: 'file_change', nodeId, subtaskId, ...fileChange });

      if (acceptedHere.length < blockIds.length) {
        fullyApplied = false;
        rejectedBlocks += blockIds.length - acceptedHere.length;
        this.notes.push(
          `Partial approval on ${d.path}: ${acceptedHere.length}/${blockIds.length} blocks applied.`
        );
      }
    }
    return { approved: true, written, fullyApplied, rejectedBlocks, stale };
  }

  private async requestCommandApprovalLocked(subtaskId: string, command: string): Promise<boolean> {
    const requestId = `ap_${this.taskId}_${++nodeCounter}`;
    const request: PendingApproval = {
      requestId,
      taskId: this.taskId,
      kind: 'command',
      subtaskId,
      summary: `Run: ${command}`,
      command,
    };
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.pendingApprovals.set(requestId, resolve);
      this.emit({ type: 'approval_request', request });
    });
    this.emit({ type: 'approval_resolved', requestId, approved: decision.approved, acceptedBlockIds: [] });
    return decision.approved;
  }

  /**
   * One model call with routing, failover, budget accounting and full tracing.
   * Every LLM call in the system goes through here, which is what makes the
   * dashboard's per-node numbers complete rather than best-effort.
   */
  private async dispatch(opts: {
    role: 'planner' | 'implementer' | 'verifier' | 'tiebreak' | 'compactor';
    subtaskId: string | null;
    parentId: string | null;
    messages: ChatMessage[];
    tools: typeof TOOL_SCHEMAS;
    signals: RoutingSignals;
    contextItems?: { path: string; lines?: string; tokens: number; source: 'retrieval' | 'manual' | 'agents_md' | 'plan' | 'history' }[];
  }): Promise<{ nodeId: string; text: string; toolCalls: ToolCall[]; model: ModelEntry } | null> {
    const tried: string[] = [];
    const MAX_ATTEMPTS = 8;
    const MAX_WAITS = 4;
    let waits = 0;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (this.cancelled) return null;
      const route = tried.length === 0 ? this.router.route(opts.signals) : this.router.routeFallback(opts.signals, tried);
      if (!route) {
        const waitMs = this.rateLimits.soonestReadyMs();
        if (waitMs > 0 && waits < MAX_WAITS) {
          const sleepMs = Math.min(Math.max(waitMs + 250, 500), 20_000);
          this.emit({
            type: 'intervention',
            subtaskId: opts.subtaskId,
            cause: 'rate_limited',
            severity: 'info',
            detail: `Every remaining route is cooling down (tried: ${tried.join(', ') || 'none'}).`,
            action: `Waiting ${Math.ceil(sleepMs / 1000)}s then retrying. No work is lost.`,
          });
          await sleep(sleepMs);
          waits++;
          attempt--;
          continue;
        }
        this.emit({
          type: 'intervention',
          subtaskId: opts.subtaskId,
          cause: 'provider_failover',
          severity: 'error',
          detail: `No eligible model available (tried: ${tried.join(', ') || 'none'})`,
          action: 'All enabled routes are unavailable. In Settings, test and enable another curated or custom provider/model ID, then retry the task.',
        });
        return null;
      }

      // PRE-DISPATCH BUDGET GATE. The router already drops candidates whose
      // projected cost exceeds the budget in `opts.signals`, but that snapshot
      // is taken once per implementer step and goes stale the moment a PARALLEL
      // subtask records a spend. This re-checks against the live ledger, right
      // before the only line in the system that actually costs money. A breach
      // scores zero regardless of partial progress, so the last dollar is never
      // worth gambling - the reserve (12% of the ceiling) is deliberately left
      // for the wrap-up summary and never spent here.
      const projected = costOf(
        route.model,
        estimateMessageTokens(opts.messages),
        ASSUMED_COMPLETION_TOKENS,
      );
      if (!this.budget.canAfford(projected)) {
        tried.push(route.model.id);
        this.emit({
          type: 'intervention',
          subtaskId: opts.subtaskId,
          cause: 'cost_ceiling',
          detail: `${route.model.label} projected at $${projected.toFixed(4)}; only $${this.budget.costRemaining.toFixed(4)} spendable before the reserve.`,
          action: 'Excluding it and trying a cheaper model; the step fails if none fits.',
        });
        continue;
      }

      const nodeId = newNodeId();
      this.emit({
        type: 'routing_decision',
        subtaskId: opts.subtaskId ?? '',
        nodeId,
        modelId: route.model.id,
        provider: route.model.provider,
        reason: route.reason,
        signals: route.signals,
        rejected: route.rejected,
      });

      this.emit({
        type: 'agent_call_start',
        nodeId,
        parentId: opts.parentId,
        role: opts.role,
        subtaskId: opts.subtaskId,
        modelId: route.model.id,
        provider: route.model.provider,
        prompt: opts.messages.map((m) => `[${m.role}] ${m.role === 'assistant' ? m.content ?? '' : m.content}`).join('\n\n').slice(0, 20000),
      });

      if (opts.contextItems?.length) {
        this.emit({
          type: 'context_snapshot',
          nodeId,
          subtaskId: opts.subtaskId,
          items: opts.contextItems,
          totalTokens: estimateMessageTokens(opts.messages),
        });
      }

      const controller = new AbortController();
      this.activeAbortController = controller;
      try {
        const result = await callModel(route.model, opts.messages, opts.tools, this.config.env, controller.signal);
        if (this.cancelled || controller.signal.aborted) {
          return null;
        }
        this.rateLimits.recordSuccess(route.model.provider, route.model.id, route.model.tier);
        this.budget.record(result.promptTokens, result.completionTokens, result.costUsd);

        this.emit({
          type: 'agent_call_end',
          nodeId,
          modelId: route.model.id,
          provider: route.model.provider,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
          output: result.text.slice(0, 20000),
        });
        if (result.text.trim()) this.emit({ type: 'thought', nodeId, text: result.text.slice(0, 4000) });
        this.emitBudget();

        // Only a call that actually returned becomes an anchor. A failover
        // attempt that threw is still a node in the tree - a sibling under the
        // same parent, which is exactly right ("tried A, then B") - but it
        // caused nothing, so nothing should hang off it.
        if (opts.subtaskId) this.lastNodeBySubtask.set(opts.subtaskId, nodeId);
        // Proof this model works - outranks any stale health snapshot.
        this.health.recordSuccess(route.model.id, route.model.provider);

        return { nodeId, text: result.text, toolCalls: result.toolCalls, model: route.model };
      } catch (err) {
        if (this.cancelled || controller.signal.aborted) {
          return null;
        }
        const pe = err instanceof ProviderError ? err : new ProviderError(String(err), { retryable: true, rateLimited: false });
        this.emit({
          type: 'agent_call_end',
          nodeId,
          modelId: route.model.id,
          provider: route.model.provider,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          latencyMs: 0,
          output: '',
          error: pe.message,
        });

        // Rate-limited models stay out via cooldown, not via `tried`, so they
        // can be retried after the wait. A hard failure (404, bad key, bad
        // request) must never be retried on the same id.
        if (!pe.rateLimited) tried.push(route.model.id);

        // A permanent failure is evidence about the MODEL or the KEY, not a
        // reason to abandon the step. Recording it takes the offender out of
        // the running for the rest of the task, and then we re-route - a
        // retired model id on Groq must not stop a task when OpenRouter can
        // serve the same request. Only when nothing healthy is left does the
        // step fail, and by then the loop above has said why.
        const scope = this.health.recordFailure(route.model.id, route.model.provider, {
          status: pe.status,
          retryable: pe.retryable,
          message: pe.message,
        });
        if (scope) {
          this.emit({
            type: 'intervention',
            subtaskId: opts.subtaskId,
            cause: 'model_unhealthy',
            detail: `${route.model.label} (${route.model.provider}): ${pe.message}`,
            action:
              scope === 'provider'
                ? `Excluding every ${route.model.provider} model for the rest of this task - the key is being rejected, so retrying it just burns time.`
                : `Excluding ${route.model.id} for the rest of this task - the provider does not serve that id, so no retry can succeed.`,
          });
        }

        if (!pe.retryable) {
          this.emit({
            type: 'intervention',
            subtaskId: opts.subtaskId,
            cause: 'provider_failover',
            detail: pe.message,
            action: 'Not retryable on this model - re-routing the same context to another one.',
          });
          continue;
        }

        const provider = route.model.provider;
        const cooldownScope =
          pe.cooldownScope ??
          (pe.rateLimited ? 'model' : 'model');
        this.rateLimits.penalise(provider, pe.rateLimited, {
          quotaScope: pe.quotaScope,
          retryAfterMs: pe.retryAfterMs,
          scope: cooldownScope,
          modelId: route.model.id,
          note:
            pe.quotaScope === 'day'
              ? cooldownScope === 'free-tier'
                ? 'free-tier daily quota spent'
                : 'daily quota spent'
              : pe.quotaScope === 'minute'
                ? 'per-minute quota hit'
                : pe.humanMessage ?? undefined,
        });

        if (pe.rateLimited) {
          // A rate limit is NOT an error. It is the free tier working exactly
          // as documented, and the router is built to route around it. Saying
          // it once, calmly, as information is the honest report; a red block
          // per occurrence tells the user something is broken when nothing is.
          const key = `${provider}:${cooldownScope}:${pe.quotaScope ?? 'unknown'}`;
          if (!this.reportedRateLimits.has(key)) {
            this.reportedRateLimits.add(key);
            const secs = this.rateLimits.cooldownRemainingSeconds(provider, route.model.id, route.model.tier);
            const when =
              secs >= 3600
                ? `about ${Math.round(secs / 3600)}h`
                : secs >= 60
                  ? `about ${Math.round(secs / 60)} min`
                  : `${secs}s`;
            const who =
              cooldownScope === 'model'
                ? route.model.label
                : cooldownScope === 'free-tier'
                  ? `${provider} free routes`
                  : provider;
            const attemptedModel = `${route.model.label} (${route.model.apiId})`;
            this.emit({
              type: 'intervention',
              subtaskId: opts.subtaskId,
              cause: 'rate_limited',
              severity: 'info',
              detail:
                pe.quotaScope === 'day'
                  ? `${who} has used up its quota for today; the last attempted model was ${attemptedModel} (${pe.humanMessage ?? pe.message}).`
                  : `${who} is rate limited; the last attempted model was ${attemptedModel} (${pe.humanMessage ?? pe.message}).`,
              action:
                cooldownScope === 'model'
                  ? `Skipping ${attemptedModel} for ${when} and continuing on another. No work is lost.`
                  : pe.quotaScope === 'day'
                    ? `Skipping ${who} for the rest of this task and using the other routes. Nothing is lost - add and test another provider/model ID in Settings for more headroom.`
                    : `Pausing ${who} for ${when} after ${attemptedModel} was rejected, and continuing on another model. No work is lost.`,
            });
          }
          continue;
        }

        this.emit({
          type: 'intervention',
          subtaskId: opts.subtaskId,
          cause: 'provider_failover',
          severity: 'warn',
          detail: `${route.model.label} (${provider}) failed: ${pe.humanMessage ?? pe.message}`,
          action: 'Re-routing the same context to another model - no work is lost.',
        });
      } finally {
        if (this.activeAbortController === controller) {
          this.activeAbortController = null;
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------- the loop ---

  async run(resumed: boolean): Promise<void> {
    this.emit({ type: 'task_started', prompt: this.prompt, resumed });
    if (resumed) {
      const rolledBack = this.reconcileResumedState();
      this.emit({
        type: 'resumed',
        fromStep: this.step,
        note:
          `Restored ${this.snapshot.subtasks.filter((s) => s.status === 'done').length} completed subtask(s) from checkpoint` +
          (rolledBack ? `; ${rolledBack} in-flight subtask(s) rolled back to re-run.` : '.'),
      });
    }
    this.emitBudget();

    try {
      if (this.cancelled) return this.cancelledOut();
      if (this.snapshot.subtasks.length === 0) {
        const plan = await this.plan();
        if (this.cancelled) return this.cancelledOut();
        if (!plan) return this.fail('Planning failed - no eligible model could produce a plan.');
        this.snapshot.subtasks = plan.subtasks;
        this.snapshot.pinnedFacts = [
          `Overall goal: ${plan.restatedGoal}`,
          ...this.snapshot.pinnedFacts,
        ];
        this.emit({ type: 'plan_created', subtasks: plan.subtasks, shortCircuited: plan.trivial });
        this.checkpoint();
      }

      // ---- scheduling: run every ready subtask, up to the parallel limit ----
      //
      // "Ready" is unchanged from the sequential version - all dependencies
      // done - so the plan's dependency graph is still the only thing that
      // decides what may run. The single change is that more than one ready
      // subtask may be in flight at a time. Everything that made sequential
      // execution safe (the undo point, the approval prompt, the file write)
      // was made concurrency-safe first; see the fields on this class.
      const configuredParallel = Math.max(1, Math.min(6, this.config.maxParallelSubtasks ?? 1));
      const running = new Map<string, Promise<void>>();

      // How much work each subtask is holding up: 1 + the longest chain of
      // subtasks that transitively depend on it. Computed once per plan - the
      // dependency graph does not change while the scheduler runs, and a
      // re-plan rebuilds the scheduler's view anyway.
      //
      // WHY THIS MATTERS. With a limit of 3 and 5 subtasks ready, taking them
      // in array order can start three leaves while the one subtask that
      // unblocks the other half of the plan waits for a slot. Total time is
      // set by the critical path, so the subtask with the most work behind it
      // is the one that must start first. This is ordinary list scheduling,
      // and it changes only WHICH ready subtask goes first - never whether a
      // subtask is allowed to run, which stays entirely the dependency graph's
      // decision.
      const depWeight = new Map<string, number>();
      const weightOf = (id: string, seen = new Set<string>()): number => {
        const cached = depWeight.get(id);
        if (cached != null) return cached;
        // A cycle would recurse forever. The plan parser already drops forward
        // and unknown dependencies, so this is belt-and-braces for a re-plan.
        if (seen.has(id)) return 1;
        seen.add(id);
        const dependents = this.snapshot.subtasks.filter((s) => s.dependsOn.includes(id));
        const w = dependents.length === 0 ? 1 : 1 + Math.max(...dependents.map((d) => weightOf(d.id, seen)));
        seen.delete(id);
        depWeight.set(id, w);
        return w;
      };

      // Two subtasks that mean to edit the same file must not run at once.
      // Not for safety - the stale-proposal guard already refuses a write
      // computed against bytes that have moved - but for cost: that refusal
      // forces the losing agent to re-read and propose again, which is a whole
      // extra round-trip. Deferring here costs nothing, because the subtask
      // stays ready and takes the next free slot.
      const conflictsWithRunning = (s: Subtask): boolean => {
        const mine = s.touchesFiles;
        if (!mine || mine.length === 0) return false;
        for (const id of running.keys()) {
          const other = this.snapshot.subtasks.find((x) => x.id === id)?.touchesFiles;
          if (other && other.some((f) => mine.includes(f))) return true;
        }
        return false;
      };

      const readyNow = (): Subtask[] =>
        this.snapshot.subtasks
          .filter(
            (s) =>
              (s.status === 'pending' || s.status === 'blocked') &&
              !running.has(s.id) &&
              s.dependsOn.every((d) => this.snapshot.subtasks.find((x) => x.id === d)?.status === 'done')
          )
          // Longest critical path first; ties keep plan order so a plan with no
          // dependencies at all behaves exactly as it did before.
          .sort((a, b) => weightOf(b.id) - weightOf(a.id));

      const drain = async (): Promise<void> => {
        await Promise.allSettled([...running.values()]);
      };

      for (;;) {
        if (this.cancelled) {
          await drain();
          return this.cancelledOut();
        }
        if (this.ceilingBreached()) {
          await drain();
          return this.fail('Hard ceiling reached.');
        }

        // Near the ceiling, collapse to one at a time. Each dispatch checks
        // affordability before it fires, but N checks can each pass and still
        // overshoot together - and a breach scores zero, so the last stretch
        // of the budget is not where to spend concurrency.
        const tight = this.budget.fractionRemaining.cost < PARALLEL_BUDGET_FLOOR;
        const limit = tight ? 1 : configuredParallel;

        // The slot check and the conflict check both have to happen INSIDE this
        // loop, against the live `running` map. Filtering the batch up front
        // instead would compare every candidate against the same starting set
        // and happily dispatch two subtasks that conflict with each other,
        // since neither is running yet at the moment the filter looks.
        for (const next of readyNow()) {
          if (running.size >= limit) break;
          // A dependency failed permanently - this subtask can never run.
          // Retired before the conflict check: it is never going to write
          // anything, so holding it back behind a file would strand it.
          if (next.status === 'blocked') {
            next.status = 'skipped';
            this.emit({ type: 'subtask_finished', subtaskId: next.id, status: 'skipped', note: 'dependency failed' });
            continue;
          }
          if (conflictsWithRunning(next)) continue;
          const id = next.id;
          const inFlight = this.runSubtask(next)
            .catch((err) => {
              // A throw out of runSubtask must not take the whole task with it,
              // and must not leave its siblings orphaned mid-flight.
              next.status = 'failed';
              next.lastError = err instanceof Error ? err.message : String(err);
              this.emit({
                type: 'subtask_finished',
                subtaskId: id,
                status: 'failed',
                note: `Unexpected error: ${next.lastError}`,
              });
              this.blockDependents(id);
            })
            .finally(() => {
              running.delete(id);
              this.checkpoint();
            });
          running.set(id, inFlight);
        }

        this.emitConcurrency([...running.keys()], configuredParallel);

        if (running.size === 0) {
          // Nothing in flight. If skipping a blocked subtask above freed
          // something, go round again; otherwise the queue is genuinely dry.
          //
          // Note this uses readyNow(), NOT the conflict-filtered list: with
          // nothing running there is nothing to conflict with, so a subtask
          // deferred for a file overlap is always dispatchable here. That is
          // what stops the file rule from ever deadlocking the scheduler.
          if (readyNow().length > 0) continue;
          // Some subtasks never reached a terminal state: a dependency
          // deadlock - a cycle, a dependency that failed without its
          // dependents being marked, or a stale in-flight state from a crash.
          // Surface it and skip the stranded work rather than "finishing"
          // with silent holes.
          this.resolveDeadlockedSubtasks();
          break;
        }

        // Wake as soon as ANY subtask finishes, so a freed slot is refilled
        // immediately rather than waiting for the slowest of the batch.
        await Promise.race([...running.values()]);
      }
      this.emitConcurrency([], configuredParallel);

      if (this.cancelled) {
        return this.cancelledOut();
      }

      // Terminal by construction: the scheduling loop above only exits once
      // every subtask is 'done', 'failed', 'skipped' or 'replaced' (a 'blocked'
      // subtask is converted to 'skipped' as soon as it is selected). So "did
      // the task actually succeed" is exactly "did every subtask end 'done'" -
      // a failed subtask, or one skipped because its dependency failed, both
      // mean the task did NOT complete, even if most subtasks passed.
      //
      // 'replaced' is the one exception, and it is not a loophole: it means the
      // re-planner swapped that subtask for a different decomposition, and
      // those replacements are themselves in this list and must each end
      // 'done'. Counting the replaced original as incomplete would make a
      // SUCCESSFUL re-plan report failure.
      const incomplete = this.snapshot.subtasks.filter((s) => s.status !== 'done' && s.status !== 'replaced');
      const summary = await this.aggregate();
      this.snapshot.summary = summary;

      if (incomplete.length === 0) {
        this.snapshot.status = 'done';
        this.checkpoint();
        this.emit({ type: 'task_finished', summary });
      } else {
        // Emitting task_failed (not task_finished) here matters as much as
        // the status field: it is what makes ChatPanel render an error
        // bubble instead of a plain assistant reply, and what makes the
        // dashboard's live trace and the resumable-task list show 'failed'
        // instead of a misleading green 'done'.
        this.snapshot.status = 'failed';
        const detail = incomplete
          .map((s) => `${s.title} (${s.status}${s.lastError ? `: ${s.lastError}` : ''})`)
          .join('; ');
        this.checkpoint();
        this.emit({
          type: 'task_failed',
          reason: `${incomplete.length}/${this.snapshot.subtasks.length} subtask(s) did not complete - ${detail}\n\n${summary}`,
        });
      }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private cancelledOut(): void {
    this.snapshot.status = 'cancelled';
    this.checkpoint();
    this.emit({ type: 'task_cancelled' });
  }

  private fail(reason: string): void {
    this.snapshot.status = 'failed';
    this.checkpoint();
    this.emit({ type: 'task_failed', reason });
  }

  private async plan(): Promise<agents.Plan | null> {
    const overview = await this.repoOverview();
    const messages = agents.plannerMessages(this.prompt, overview, this.snapshot.agentsMd);
    const signals: RoutingSignals = {
      category: 'analysis',
      estimatedContextTokens: estimateMessageTokens(messages),
      budgetRemaining: this.budget.costRemaining,
      timeRemaining: this.budget.timeRemaining,
      attemptNumber: 1,
      cooldownProviders: this.rateLimits.cooldownList(),
    };
    const res = await this.dispatch({
      role: 'planner',
      subtaskId: null,
      parentId: null,
      messages,
      tools: [],
      signals,
      contextItems: [{ path: '(repository overview)', tokens: estimateTokens(overview), source: 'plan' }],
    });
    if (!res) return null;
    // The root of the call hierarchy: everything else in the task exists
    // because this call decided it should.
    this.planNodeId = res.nodeId;
    const plan = agents.parsePlan(res.text, this.prompt);
    if (plan.subtasks.length === 1 && plan.subtasks[0].detail === this.prompt) {
      this.emit({
        type: 'intervention',
        subtaskId: null,
        cause: 'disagreement',
        detail: 'Planner output was not parseable JSON.',
        action: 'Fell back to a single-subtask plan so the request still runs.',
      });
    }
    return plan;
  }

  private async repoOverview(): Promise<string> {
    const lines: string[] = [];
    try {
      const entries = await fs.readdir(this.config.rootPath, { withFileTypes: true });
      lines.push(
        entries
          .filter((e) => !['node_modules', '.git', '.next', '__pycache__', '.venv', 'dist', 'build'].includes(e.name))
          .slice(0, 60)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join('  ')
      );
    } catch {
      lines.push('(could not read project root)');
    }
    for (const f of ['README.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']) {
      try {
        const content = await fs.readFile(path.join(this.config.rootPath, f), 'utf8');
        lines.push(`\n--- ${f} (first 1200 chars) ---\n${content.slice(0, 1200)}`);
        break;
      } catch {
        /* try next */
      }
    }
    return lines.join('\n');
  }

  /**
   * Start tracking edits for a subtask, discarding any previous subtask's
   * point. Called once per subtask, NOT once per attempt: a retry should
   * return the tree to how it looked before the subtask started, not to how
   * the previous failed attempt left it.
   */
  private beginBacktrackPoint(subtaskId: string): void {
    this.backtrack.set(subtaskId, new Map());
    this.activeFileChanges.set(subtaskId, []);
  }

  /** Commit this subtask's work: drop its undo point so nothing can revert it later. */
  private dropBacktrackPoint(subtaskId: string): void {
    this.backtrack.delete(subtaskId);
    this.activeFileChanges.delete(subtaskId);
  }

  /** Stash a file's current content the first time this subtask writes to it. */
  private async captureBacktrackPoint(subtaskId: string, rel: string, full: string): Promise<void> {
    const own = this.backtrack.get(subtaskId);
    if (!own) return;
    if (own.has(rel)) return; // already have the pre-subtask state
    const wasTracked = this.changedFiles.has(rel);
    try {
      own.set(rel, { content: await fs.readFile(full, 'utf8'), wasTracked });
    } catch {
      // Unreadable means it does not exist yet: undoing a create is a delete.
      own.set(rel, { content: null, wasTracked });
    }
  }

  /**
   * Undo every edit the current subtask made, returning the workspace to its
   * pre-subtask state. Returns the number of files restored.
   *
   * This is the actual backtracking step. Without it a failed verification
   * retries ON TOP of the edits that just failed verification, so attempt 2
   * starts from a tree the verifier already rejected and attempt 3 compounds
   * it - and if all attempts fail, the union of every broken attempt is left
   * on disk with the subtask marked `failed` and nobody cleaning up.
   */
  private async restoreBacktrackPoint(subtask: Subtask, why: string): Promise<number> {
    const own = this.backtrack.get(subtask.id);
    if (!own || !own.size) return 0;
    const changeLog = this.activeFileChanges.get(subtask.id) ?? [];

    const restored: string[] = [];
    const failures: string[] = [];
    // Some of these edits may have been approved by the user by hand. Undoing
    // a human's approved change is never allowed to be silent, which is why
    // this reports through `intervention` and names every file.
    const approvedByHand = [...own.keys()];

    for (const [rel, prior] of own) {
      const full = path.resolve(this.config.rootPath, rel);
      try {
        if (prior.content === null) {
          await fs.rm(full, { force: true });
        } else {
          await fs.mkdir(path.dirname(full), { recursive: true });
          await fs.writeFile(full, prior.content, 'utf8');
        }
        restored.push(rel);
        // A file this subtask created is no longer a changed file. One it
        // merely edited may still be changed by an EARLIER subtask, and its
        // stashed content already includes that earlier change - so leave it.
        if (!prior.wasTracked) this.changedFiles.delete(rel);
        this.changedBySubtask.get(subtask.id)?.delete(rel);
      } catch (err) {
        failures.push(`${rel} (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    // Mark only this subtask's writes as automatically reverted. Earlier
    // successful changes remain eligible for an explicit user revert.
    for (const change of changeLog) {
      if (restored.includes(change.path)) {
        this.emit({
          type: 'workspace_reverted',
          changeId: change.changeId,
          path: change.path,
          automatic: true,
        });
      }
    }
    this.activeFileChanges.set(subtask.id, changeLog.filter((change) => !restored.includes(change.path)));

    this.emit({
      type: 'intervention',
      subtaskId: subtask.id,
      cause: 'workspace_restored',
      detail:
        `${why} Reverted ${restored.length} file(s) to their state before "${subtask.title}" ran: ` +
        `${approvedByHand.join(', ')}.` +
        (failures.length ? ` Could NOT revert: ${failures.join('; ')}.` : ''),
      action: failures.length
        ? 'The workspace is only partially rolled back - the files listed as un-revertable still hold the failed edit.'
        : 'The next attempt starts from a clean tree instead of building on a rejected one.',
    });

    // Re-arm THIS subtask only. Replacing the whole map - as this did when
    // backtracking was global, before it was keyed by subtask - had two
    // effects, both silent. It disarmed every OTHER subtask running in
    // parallel, so a sibling that failed later could no longer roll back at
    // all. And because captureBacktrackPoint bails when a subtask has no map,
    // this subtask stopped recording too: attempt 2 captured nothing, so
    // attempt 3 built on the tree attempt 2 had already been rejected for, and
    // the debris of the final attempt was left on disk.
    this.backtrack.set(subtask.id, new Map());
    return restored.length;
  }

  /** One subtask, with escalating retries, verification, and tie-break. */
  private async runSubtask(subtask: Subtask): Promise<void> {
    // One backtrack point per subtask, taken before the first attempt.
    //
    // On a RESUME this is necessarily empty: the pre-edit contents lived in
    // memory and that process is gone. So a rollback after a resume can only
    // undo edits made since the resume, and the intervention it emits names
    // exactly which files it did revert - it never claims a clean tree it
    // cannot deliver.
    this.beginBacktrackPoint(subtask.id);

    // Attempt 1 hangs off the planner. Every later attempt hangs off whatever
    // rejected the previous one, which is re-read from the anchor map below.
    let attemptParent: string | null = this.planNodeId;

    for (let attempt = subtask.attempts + 1; attempt <= MAX_RETRIES_PER_SUBTASK; attempt++) {
      if (this.cancelled || this.ceilingBreached()) return;

      subtask.attempts = attempt;
      subtask.status = 'running';
      this.emit({ type: 'subtask_started', subtaskId: subtask.id, title: subtask.title, attempt });

      const outcome = await this.executeSubtask(subtask, attempt, attemptParent);
      if (!outcome) {
        await this.restoreBacktrackPoint(subtask, 'No model was available to finish this subtask.');
        subtask.status = 'failed';
        subtask.lastError = 'no model could execute this subtask';
        this.emit({ type: 'subtask_finished', subtaskId: subtask.id, status: 'failed', note: subtask.lastError });
        this.blockDependents(subtask.id);
        return;
      }

      if (outcome.blocked) {
        subtask.lastError = outcome.claim;
        if (attempt < MAX_RETRIES_PER_SUBTASK) {
          this.emit({
            type: 'intervention',
            subtaskId: subtask.id,
            cause: 'retry_cap',
            detail: `Agent reported BLOCKED: ${outcome.claim}`,
            action: `Retrying (attempt ${attempt + 1}/${MAX_RETRIES_PER_SUBTASK}) with a more capable model.`,
          });
          // The agent blocked itself, so the next attempt hangs off its own
          // last call rather than off a verifier that never ran.
          attemptParent = this.lastNodeBySubtask.get(subtask.id) ?? attemptParent;
          continue;
        }
        await this.restoreBacktrackPoint(subtask, 'The agent reported it was blocked and retries are exhausted.');
        // Roll back FIRST, then re-plan: the replacements must start from the
        // same tree the original subtask started from, and the re-planner is
        // told that is the case.
        if (await this.tryReplan(subtask, `Agent reported BLOCKED: ${outcome.claim}`)) return;
        subtask.status = 'failed';
        this.emit({ type: 'subtask_finished', subtaskId: subtask.id, status: 'failed', note: outcome.claim });
        this.blockDependents(subtask.id);
        return;
      }

      // Read-only analysis with no edits does not need an independent verifier
      // call - there is no repository state to check, and the call would cost
      // real money to confirm that nothing happened.
      const worthVerifying = subtask.category !== 'analysis' || this.changedFiles.size > 0;
      if (!worthVerifying) {
        this.dropBacktrackPoint(subtask.id);
        subtask.status = 'done';
        this.notes.push(`${subtask.title}: ${outcome.claim}`);
        this.emit({ type: 'subtask_finished', subtaskId: subtask.id, status: 'done', note: 'analysis-only, no verification needed' });
        return;
      }

      subtask.status = 'verifying';
      // The verifier is judging the implementer's final claim, so it hangs off
      // the implementer call that made it.
      const implementerLast = this.lastNodeBySubtask.get(subtask.id) ?? attemptParent;
      const verdict = await this.verify(subtask, outcome.claim, implementerLast);

      if (verdict.verdict === 'pass') {
        // Verified work is committed: drop the undo point so no later failure
        // can reach back and revert a subtask that passed.
        this.dropBacktrackPoint(subtask.id);
        subtask.status = 'done';
        this.notes.push(`${subtask.title}: ${outcome.claim}`);
        this.emit({ type: 'subtask_finished', subtaskId: subtask.id, status: 'done', note: verdict.reason });
        return;
      }

      // Disagreement: implementer claimed done, verifier says fail.
      // Explicit annotation: control flow has already narrowed verdict.verdict
      // to 'fail' here, but the tie-break below can widen it back to 'pass'.
      let finalVerdict: 'pass' | 'fail' = verdict.verdict;
      if (verdict.confidence < 0.6) {
        this.emit({
          type: 'intervention',
          subtaskId: subtask.id,
          cause: 'disagreement',
          detail: `Implementer claims done; verifier says fail at confidence ${verdict.confidence.toFixed(2)}.`,
          action: 'Neither side wins by default - spending one call on a third model to break the tie.',
        });
        const verifierLast = this.lastNodeBySubtask.get(subtask.id) ?? implementerLast;
        const tie = await this.tiebreak(subtask, outcome.claim, verdict, verifierLast);
        if (tie) {
          finalVerdict = tie.verdict;
          this.notes.push(`Tie-break on "${subtask.title}": ${tie.verdict} - ${tie.reason}`);
        }
      }

      if (finalVerdict === 'pass') {
        // The tie-break overrode the verifier's fail - so this work stands and
        // must not be rolled back either.
        this.dropBacktrackPoint(subtask.id);
        subtask.status = 'done';
        this.emit({ type: 'subtask_finished', subtaskId: subtask.id, status: 'done', note: 'passed on tie-break' });
        return;
      }

      subtask.lastError = verdict.reason;
      if (attempt < MAX_RETRIES_PER_SUBTASK) {
        this.emit({
          type: 'intervention',
          subtaskId: subtask.id,
          cause: 'retry_cap',
          detail: `Verification failed: ${verdict.reason}`,
          action: `Retrying (attempt ${attempt + 1}/${MAX_RETRIES_PER_SUBTASK}) with the failure fed back in, on a stronger model.`,
        });
        // BACKTRACK, then retry. The rejected edits come off disk first, so the
        // next attempt re-solves the original problem rather than trying to
        // patch a tree the verifier already refused.
        // Whatever spoke last on this subtask - the verifier, or the tie-break
        // that upheld it - is what forced the retry, so the next attempt hangs
        // off it.
        attemptParent = this.lastNodeBySubtask.get(subtask.id) ?? implementerLast;
        const reverted = await this.restoreBacktrackPoint(
          subtask,
          `Verification failed on attempt ${attempt}.`
        );
        // Feed the failure into the next attempt so it is a different attempt,
        // not the same one again - and tell it the tree was rolled back, or it
        // will assume its earlier edits are still there and write half a fix.
        const convo = this.snapshot.conversations[subtask.id] ?? [];
        convo.push({
          role: 'user',
          content:
            `Your previous attempt was rejected by an independent verifier: ${verdict.reason}\n` +
            `Evidence: ${verdict.evidence}\n` +
            (reverted
              ? `Your edits from that attempt have been REVERTED - the ${reverted} file(s) you changed are back to their original contents. Start from the original code, not from your previous edit.\n`
              : '') +
            `Fix this specifically. Do not repeat the same approach.`,
        });
        this.snapshot.conversations[subtask.id] = convo;
        this.checkpoint();
        continue;
      }

      // Retries exhausted. Roll the workspace back rather than leaving the
      // debris of every failed attempt behind: this subtask is about to be
      // marked failed and its dependents blocked, so nothing downstream will
      // ever clean up after it.
      await this.restoreBacktrackPoint(
        subtask,
        `All ${MAX_RETRIES_PER_SUBTASK} attempts failed verification.`
      );

      // Last resort before declaring failure: the retry ladder has already
      // re-run this on a stronger model with the verifier's complaint fed in.
      // If that failed three times the subtask itself is the problem, so ask
      // the re-planner whether a different decomposition would work. Bounded -
      // see tryReplan.
      if (await this.tryReplan(subtask, `Verification failed ${subtask.attempts}x. Last reason: ${verdict.reason}`)) {
        return;
      }

      subtask.status = 'failed';
      this.emit({
        type: 'intervention',
        subtaskId: subtask.id,
        cause: 'retry_cap',
        detail: `${MAX_RETRIES_PER_SUBTASK} attempts exhausted.`,
        action: 'Marking the subtask failed and skipping anything that depends on it.',
      });
      this.emit({ type: 'subtask_finished', subtaskId: subtask.id, status: 'failed', note: verdict.reason });
      this.blockDependents(subtask.id);
      return;
    }
  }

  /**
   * BOUNDED MID-TASK RE-PLANNING.
   *
   * Called once, when a subtask has spent every retry it was allowed and is
   * about to be marked `failed`. Returns true if the subtask was replaced with
   * a different decomposition (the caller must then NOT mark it failed and must
   * NOT block its dependents), false if the original failure stands.
   *
   * The bounds are all checked BEFORE the planner call, so a re-plan that is
   * not allowed costs nothing. Every refusal is emitted as a `replan_declined`
   * intervention naming which bound stopped it - a silent "we could have
   * re-planned but didn't" is exactly the kind of invisible decision this
   * system is built to avoid.
   */
  private async tryReplan(subtask: Subtask, failureReason: string): Promise<boolean> {
    const decline = (detail: string, action: string): false => {
      this.emit({ type: 'intervention', subtaskId: subtask.id, cause: 'replan_declined', detail, action });
      return false;
    };

    // ---- bounds, cheapest first ------------------------------------------
    if (this.cancelled || this.ceilingBreached()) return false;

    if ((subtask.replanDepth ?? 0) >= MAX_REPLAN_DEPTH) {
      return decline(
        `"${subtask.title}" is itself the product of a re-plan, and re-plans do not nest.`,
        'Accepting the failure instead of re-planning a re-plan.'
      );
    }
    if (this.replansUsed >= MAX_REPLANS_PER_TASK) {
      return decline(
        `Both re-plans for this task are already spent (limit ${MAX_REPLANS_PER_TASK}).`,
        'Accepting the failure - further re-planning is capped to stop a task rewriting its own plan indefinitely.'
      );
    }

    const frac = this.budget.fractionRemaining;
    if (frac.cost < REPLAN_MIN_COST_FRACTION || frac.time < REPLAN_MIN_TIME_FRACTION) {
      return decline(
        `Only ${(frac.cost * 100).toFixed(0)}% of the cost ceiling and ${(frac.time * 100).toFixed(0)}% of the time ceiling remain.`,
        `Re-planning needs at least ${REPLAN_MIN_COST_FRACTION * 100}% / ${REPLAN_MIN_TIME_FRACTION * 100}% in hand - a breach scores zero, which is worse than one failed subtask.`
      );
    }

    // ---- ask ---------------------------------------------------------------
    const completed = this.snapshot.subtasks.filter((s) => s.status === 'done');
    const messages = agents.replannerMessages(
      this.snapshot.pinnedFacts[0] ?? this.prompt,
      subtask,
      failureReason,
      completed,
      [...this.changedFiles],
      MAX_REPLACEMENTS_PER_REPLAN
    );

    const res = await this.dispatch({
      role: 'planner',
      subtaskId: subtask.id,
      // Hangs off the call that produced the failure being re-planned around,
      // so the tree reads "this verifier rejected it, so we re-planned".
      parentId: this.lastNodeBySubtask.get(subtask.id) ?? this.planNodeId,
      messages,
      tools: [],
      signals: {
        category: 'analysis',
        estimatedContextTokens: estimateMessageTokens(messages),
        budgetRemaining: this.budget.costRemaining,
        timeRemaining: this.budget.timeRemaining,
        // Force escalation, same reasoning as the tie-break: deciding that a
        // plan is wrong is a harder judgement than executing it, and the cheap
        // model that just failed three times is not the one to make it.
        attemptNumber: 2,
        cooldownProviders: this.rateLimits.cooldownList(),
      },
    });
    if (!res) return decline('No model was available to re-plan.', 'Accepting the original failure.');

    const plan = agents.parseReplan(res.text, MAX_REPLACEMENTS_PER_REPLAN);
    this.replansUsed++; // the call is spent either way - count it, or a stream
                        // of abandons could bypass MAX_REPLANS_PER_TASK.

    if (plan.abandon) {
      return decline(
        `Re-planner diagnosis: ${plan.diagnosis} - ${plan.reason}`,
        'It judged no decomposition would help, so the subtask stays failed rather than burning budget on a reworded retry.'
      );
    }

    // ---- splice the new subtasks into the DAG -----------------------------
    const replacements: Subtask[] = plan.subtasks.map((s, i) => ({
      id: `${subtask.id}r${i + 1}`,
      title: s.title,
      detail: s.detail,
      category: s.category,
      // The first replacement inherits the failed subtask's prerequisites (all
      // already `done`, which is why it ran at all); the rest chain after their
      // predecessor. Chaining forward-only keeps the DAG acyclic by
      // construction rather than by validation.
      dependsOn: i === 0 ? [...subtask.dependsOn] : [`${subtask.id}r${i}`],
      status: 'pending',
      attempts: 0,
      costSpent: 0,
      tokensSpent: 0,
      replanDepth: (subtask.replanDepth ?? 0) + 1,
      replacedSubtaskId: subtask.id,
    }));
    const lastId = replacements[replacements.length - 1].id;

    // Anything that depended on the failed subtask now depends on the LAST
    // replacement. Without this rewire the dependents stay waiting on an id
    // that can never be `done`, and the deadlock detector would skip them -
    // turning a successful re-plan into a task that still fails.
    for (const s of this.snapshot.subtasks) {
      if (s.dependsOn.includes(subtask.id)) {
        s.dependsOn = s.dependsOn.map((d) => (d === subtask.id ? lastId : d));
      }
    }

    // `replaced`, not `failed`: the work is still being attempted under new
    // ids, so this must not count against task completion. It stays in the
    // list, with its trace, so the dashboard shows what was tried and dropped.
    subtask.status = 'replaced';
    subtask.lastError = failureReason;

    const at = this.snapshot.subtasks.findIndex((s) => s.id === subtask.id);
    this.snapshot.subtasks.splice(at + 1, 0, ...replacements);

    this.emit({
      type: 'intervention',
      subtaskId: subtask.id,
      cause: 'replan',
      detail: `"${subtask.title}" failed ${subtask.attempts} attempts. Diagnosis: ${plan.diagnosis}`,
      action: `Replaced it with ${replacements.length} subtask(s): ${replacements.map((r) => r.title).join('; ')}.`,
    });
    this.emit({ type: 'subtask_finished', subtaskId: subtask.id, status: 'replaced', note: plan.diagnosis });
    this.emit({
      type: 'replan',
      failedSubtaskId: subtask.id,
      diagnosis: plan.diagnosis,
      replacements,
      replansRemaining: MAX_REPLANS_PER_TASK - this.replansUsed,
    });
    this.checkpoint();
    return true;
  }

  /**
   * A resumed snapshot can hold subtasks that were mid-flight when the IDE
   * died: `running` (implementer loop) or `verifying` (verifier call). The
   * scheduler only ever starts `pending` / `blocked` work, so these would be
   * stranded and the task would "complete" with a hole. Roll them back to
   * `pending` - their checkpointed conversation is reused, and `attempts` is
   * untouched, so the retry ladder is not reset. Returns how many were rolled
   * back. */
  private reconcileResumedState(): number {
    let rolledBack = 0;
    for (const s of this.snapshot.subtasks) {
      if (s.status === 'running' || s.status === 'verifying') {
        this.emit({
          type: 'intervention',
          subtaskId: s.id,
          cause: 'resume_rollback',
          detail: `Subtask "${s.title}" was "${s.status}" when the previous session ended.`,
          action: 'Rolled back to pending so it re-runs from the last checkpoint.',
        });
        s.status = 'pending';
        rolledBack++;
      }
    }
    if (rolledBack) this.checkpoint();
    return rolledBack;
  }

  /**
   * Called when the scheduler can find no runnable subtask but non-terminal
   * subtasks remain. Every such subtask is genuinely unreachable - the
   * scheduler has already exhausted everything whose dependencies are `done` -
   * so mark them `skipped` with a diagnosis of why. */
  private resolveDeadlockedSubtasks(): void {
    const terminal = new Set(['done', 'failed', 'skipped', 'replaced']);
    const stranded = this.snapshot.subtasks.filter((s) => !terminal.has(s.status));
    if (!stranded.length) return;

    for (const s of stranded) {
      const badDeps = s.dependsOn.filter((d) => {
        const dep = this.snapshot.subtasks.find((x) => x.id === d);
        return !dep || dep.status !== 'done';
      });
      const detail = badDeps.length
        ? `Subtask "${s.title}" depends on [${badDeps.join(', ')}], which never completed.`
        : `Subtask "${s.title}" is stuck in "${s.status}" with no path to run (possible dependency cycle).`;
      this.emit({
        type: 'intervention',
        subtaskId: s.id,
        cause: 'dependency_deadlock',
        detail,
        action: 'Skipping it - its dependencies cannot be satisfied.',
      });
      s.status = 'skipped';
      this.emit({ type: 'subtask_finished', subtaskId: s.id, status: 'skipped', note: 'dependency deadlock' });
    }
    this.checkpoint();
  }

  private blockDependents(failedId: string): void {
    for (const s of this.snapshot.subtasks) {
      if (s.dependsOn.includes(failedId) && (s.status === 'pending' || s.status === 'blocked')) {
        s.status = 'blocked';
      }
    }
  }

  /** The implementer's tool-calling loop for one subtask. */
  private async executeSubtask(
    subtask: Subtask,
    attempt: number,
    /** What caused this attempt: the planner, or the verifier that rejected the last one. */
    parentId: string | null
  ): Promise<{ claim: string; blocked: boolean } | null> {
    const system = agents.implementerSystemPrompt(
      this.snapshot.pinnedFacts[0] ?? this.prompt,
      subtask,
      this.snapshot.pinnedFacts
    );

    let messages: ChatMessage[] = this.snapshot.conversations[subtask.id] ?? [
      { role: 'system', content: system },
      ...(this.snapshot.agentsMd ? [{ role: 'system' as const, content: this.snapshot.agentsMd }] : []),
      { role: 'user', content: `${subtask.title}\n\n${subtask.detail}` },
    ];

    let subtaskTokens = subtask.tokensSpent;
    let lastSignature = '';
    let repeats = 0;
    let contextItems: { path: string; lines?: string; tokens: number; source: 'retrieval' | 'manual' | 'agents_md' | 'plan' | 'history' }[] = [];

    for (let step = 0; step < MAX_STEPS_PER_SUBTASK; step++) {
      if (this.cancelled) return null;
      if (this.ceilingBreached()) return null;

      if (subtaskTokens > MAX_TOKENS_PER_SUBTASK) {
        this.emit({
          type: 'intervention',
          subtaskId: subtask.id,
          cause: 'token_cap',
          detail: `${subtaskTokens} tokens spent on this subtask (cap ${MAX_TOKENS_PER_SUBTASK}).`,
          action: 'Halting the subtask - this is the "many cheap steps" runaway, which a step cap alone misses.',
        });
        return { claim: 'Token cap reached before completion.', blocked: true };
      }

      const signals: RoutingSignals = {
        category: subtask.category,
        estimatedContextTokens: estimateMessageTokens(messages),
        budgetRemaining: this.budget.costRemaining,
        timeRemaining: this.budget.timeRemaining,
        attemptNumber: attempt,
        cooldownProviders: this.rateLimits.cooldownList(),
      };

      // Compaction is checked against the model the router WOULD pick, since
      // the window that matters is the one we are about to use.
      const probable = this.router.route(signals);
      if (probable) {
        const need = shouldCompact(messages, probable.model);
        if (need.compact) {
          const summariser = this.cheapestModel() ?? probable.model;
          const outcome = await compact(messages, probable.model, summariser, this.snapshot.pinnedFacts, this.config.env);
          this.budget.record(outcome.promptTokens, outcome.completionTokens, outcome.costUsd);
          messages = outcome.messages;
          this.emit({
            type: 'compaction',
            // Attributed to the last call on this subtask - that is the context
            // that grew too large, so that is where the compaction belongs in
            // the tree rather than floating free at task level.
            nodeId: this.lastNodeBySubtask.get(subtask.id) ?? null,
            beforeTokens: outcome.beforeTokens,
            afterTokens: outcome.afterTokens,
            summarized: outcome.summarizedCount,
            preserved: outcome.preserved,
          });
          this.emitBudget();
        }
      }

      const res = await this.dispatch({
        role: 'implementer',
        subtaskId: subtask.id,
        parentId,
        messages,
        tools: TOOL_SCHEMAS,
        signals,
        contextItems: contextItems.length ? contextItems : undefined,
      });
      if (!res) return null;

      subtaskTokens += estimateTokens(res.text) + signals.estimatedContextTokens / 4;
      subtask.tokensSpent = subtaskTokens;
      this.snapshot.conversations[subtask.id] = messages;

      if (res.toolCalls.length === 0) {
        const text = res.text.trim();
        this.snapshot.conversations[subtask.id] = [...messages, { role: 'assistant', content: text }];
        if (/^BLOCKED/i.test(text)) return { claim: text.replace(/^BLOCKED:?\s*/i, ''), blocked: true };
        return { claim: text.replace(/^DONE:?\s*/i, ''), blocked: false };
      }

      messages = [...messages, { role: 'assistant', content: res.text || null, toolCalls: res.toolCalls }];

      for (const call of res.toolCalls) {
        const signature = `${call.name}:${JSON.stringify(call.arguments)}`;
        repeats = signature === lastSignature ? repeats + 1 : 1;
        lastSignature = signature;

        if (repeats >= MAX_IDENTICAL_REPEATS) {
          this.emit({
            type: 'intervention',
            subtaskId: subtask.id,
            cause: 'identical_repeat',
            detail: `${call.name} called with identical arguments ${MAX_IDENTICAL_REPEATS}x in a row.`,
            action: 'Halting the subtask - the agent is looping, not progressing.',
          });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: 'Loop guard: identical call refused.' });
          return { claim: 'Stopped: the agent repeated the same tool call without progressing.', blocked: true };
        }

        const tool = findTool(call.name);
        this.emit({
          type: 'tool_call',
          nodeId: res.nodeId,
          callId: call.id,
          name: call.name,
          args: call.arguments,
          sideEffecting: tool?.sideEffecting ?? false,
        });

        if (!tool) {
          const content = `Unknown tool "${call.name}". Available: ${TOOL_SCHEMAS.map((t) => t.name).join(', ')}.`;
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
          this.emit({ type: 'tool_result', nodeId: res.nodeId, callId: call.id, result: content, outcome: 'error', ms: 0 });
          continue;
        }

        // run_command is gated here (propose_edit gates itself inside the tool,
        // because it needs the diff to show).
        if (tool.schema.name === 'run_command') {
          const cmd = String(call.arguments.command ?? '');
          const approved = await this.requestCommandApproval(subtask.id, cmd);
          if (!approved) {
            const content = `The user REJECTED running: ${cmd}. It did not run. Find another way to verify, or proceed without it.`;
            messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
            this.emit({ type: 'tool_result', nodeId: res.nodeId, callId: call.id, result: content, outcome: 'rejected', ms: 0 });
            continue;
          }
        }

        const started = Date.now();
        try {
          const result = await tool.run(call.arguments, this.toolContext(subtask.id, res.nodeId));
          // Tools are pure functions of (args, ctx) and cannot emit; anything
          // one needs surfaced travels back on the result. See ToolResult.
          if (result.intervention) {
            this.emit({ type: 'intervention', subtaskId: subtask.id, ...result.intervention });
          }
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result.content });
          if (result.contextItems) {
            contextItems = result.contextItems.map((c) => ({ ...c, source: 'retrieval' as const }));
          }
          this.emit({
            type: 'tool_result',
            nodeId: res.nodeId,
            callId: call.id,
            result: result.content.slice(0, 8000),
            outcome: 'done',
            ms: Date.now() - started,
          });
        } catch (err) {
          const content = `Error: ${err instanceof Error ? err.message : String(err)}`;
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
          this.emit({ type: 'tool_result', nodeId: res.nodeId, callId: call.id, result: content, outcome: 'error', ms: Date.now() - started });
        }
      }

      this.snapshot.conversations[subtask.id] = messages;
      this.checkpoint();
    }

    this.emit({
      type: 'intervention',
      subtaskId: subtask.id,
      cause: 'step_cap',
      detail: `${MAX_STEPS_PER_SUBTASK} tool-calling steps without a final answer.`,
      action: 'Halting the subtask so it cannot spin forever.',
    });
    return { claim: 'Step cap reached before the agent finished.', blocked: true };
  }

  private cheapestModel(): ModelEntry | null {
    const enabled = this.config.enabledModelIds
      .map((id) => this.config.customModels?.find((m) => m.id === id) ?? findModel(id))
      .filter((m): m is ModelEntry => !!m && checkEligibility(m).eligible);
    if (!enabled.length) return null;
    return enabled.reduce((a, b) => (a.pricing.inputPerM + a.pricing.outputPerM <= b.pricing.inputPerM + b.pricing.outputPerM ? a : b));
  }

  private async verify(subtask: Subtask, claim: string, parentId: string | null): Promise<agents.Verdict> {
    const messages = agents.verifierMessages(
      this.snapshot.pinnedFacts[0] ?? this.prompt,
      subtask,
      claim,
      // Only this subtask's files. Under parallelism the global set contains
      // another subtask's work, and a verifier shown files its subtask never
      // touched will fail work it was not asked to judge.
      [...(this.changedBySubtask.get(subtask.id) ?? [])]
    );
    const signals: RoutingSignals = {
      category: 'verification',
      estimatedContextTokens: estimateMessageTokens(messages),
      budgetRemaining: this.budget.costRemaining,
      timeRemaining: this.budget.timeRemaining,
      attemptNumber: 1,
      cooldownProviders: this.rateLimits.cooldownList(),
    };

    let convo = [...messages];
    // The verifier gets a tool budget to look at the repo before giving a verdict.
    const maxVerifierSteps = 6;
    for (let step = 0; step < maxVerifierSteps; step++) {
      const isLastStep = step === maxVerifierSteps - 1;
      const res = await this.dispatch({
        role: 'verifier',
        subtaskId: subtask.id,
        parentId,
        messages: convo,
        tools: isLastStep ? [] : VERIFIER_TOOL_SCHEMAS,
        signals,
      });
      if (!res) {
        return { verdict: 'fail', confidence: 0.3, reason: 'Verifier could not run (no model available).', evidence: '' };
      }
      if (res.toolCalls.length === 0 || isLastStep) {
        const verdict = agents.parseVerdict(res.text);
        this.router.recordVerification(res.model.id, verdict.verdict === 'pass');
        return verdict;
      }

      convo = [...convo, { role: 'assistant', content: res.text || null, toolCalls: res.toolCalls }];
      for (const call of res.toolCalls) {
        const tool = findTool(call.name);
        this.emit({ type: 'tool_call', nodeId: res.nodeId, callId: call.id, name: call.name, args: call.arguments, sideEffecting: tool?.sideEffecting ?? false });
        if (!tool) {
          convo.push({ role: 'tool', toolCallId: call.id, name: call.name, content: 'Unknown tool.' });
          continue;
        }
        if (tool.schema.name === 'run_command') {
          const approved = await this.requestCommandApproval(subtask.id, String(call.arguments.command ?? ''));
          if (!approved) {
            convo.push({ role: 'tool', toolCallId: call.id, name: call.name, content: 'User rejected running this command.' });
            this.emit({ type: 'tool_result', nodeId: res.nodeId, callId: call.id, result: 'rejected', outcome: 'rejected', ms: 0 });
            continue;
          }
        }
        try {
          const result = await tool.run(call.arguments, this.toolContext(subtask.id, res.nodeId));
          // Tools are pure functions of (args, ctx) and cannot emit; anything
          // one needs surfaced travels back on the result. See ToolResult.
          if (result.intervention) {
            this.emit({ type: 'intervention', subtaskId: subtask.id, ...result.intervention });
          }
          convo.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result.content });
          this.emit({ type: 'tool_result', nodeId: res.nodeId, callId: call.id, result: result.content.slice(0, 6000), outcome: 'done', ms: 0 });
        } catch (err) {
          const content = `Error: ${err instanceof Error ? err.message : String(err)}`;
          convo.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
          this.emit({ type: 'tool_result', nodeId: res.nodeId, callId: call.id, result: content, outcome: 'error', ms: 0 });
        }
      }
    }
    return { verdict: 'fail', confidence: 0.35, reason: 'Verifier used its tool budget without reaching a verdict.', evidence: '' };
  }

  private async tiebreak(subtask: Subtask, claim: string, verdict: agents.Verdict, parentId: string | null) {
    const messages = agents.tiebreakMessages(subtask, claim, verdict);
    const res = await this.dispatch({
      role: 'tiebreak',
      subtaskId: subtask.id,
      parentId,
      messages,
      tools: [],
      signals: {
        category: 'analysis',
        estimatedContextTokens: estimateMessageTokens(messages),
        budgetRemaining: this.budget.costRemaining,
        timeRemaining: this.budget.timeRemaining,
        // Force escalation: a tie-break on the same small model that already
        // disagreed with itself adds nothing.
        attemptNumber: 2,
        cooldownProviders: this.rateLimits.cooldownList(),
      },
    });
    return res ? agents.parseTiebreak(res.text) : null;
  }

  private async aggregate(): Promise<string> {
    if (this.budget.inReserve()) {
      const done = this.snapshot.subtasks.filter((s) => s.status === 'done').length;
      return `Completed ${done}/${this.snapshot.subtasks.length} subtasks. Budget reserve reached, so this summary is generated locally. Files changed: ${[...this.changedFiles].join(', ') || 'none'}.`;
    }

    const messages = agents.summariserMessages(this.snapshot.pinnedFacts[0] ?? this.prompt, this.snapshot.subtasks, this.notes);
    const res = await this.dispatch({
      role: 'implementer', // the router will pick the compactor/cheapest model based on category
      subtaskId: null,
      parentId: this.planNodeId,
      messages,
      tools: [],
      signals: {
        category: 'simple_edit',
        estimatedContextTokens: estimateMessageTokens(messages),
        budgetRemaining: this.budget.costRemaining,
        timeRemaining: this.budget.timeRemaining,
        attemptNumber: 1,
        cooldownProviders: this.rateLimits.cooldownList(),
      },
    });

    const done = this.snapshot.subtasks.filter((s) => s.status === 'done').length;
    const fallback = `Completed ${done}/${this.snapshot.subtasks.length} subtasks.`;

    if (!res?.text) return fallback;

    // Parse the JSON. extractJson() automatically searches the string for valid JSON blocks
    // and ignores the scratchpad text surrounding it.
    const parsed = extractJson(res.text);
    if (parsed && typeof parsed.summary === 'string' && parsed.summary.trim()) {
      return parsed.summary.trim();
    }

    // Extreme fallback: If it still output plain text and failed the JSON, 
    // grab the very last paragraph of the output.
    const parts = res.text.trim().split('\n\n');
    const lastParagraph = parts[parts.length - 1].replace(/^[*\s-]+/, '').trim();
    return lastParagraph || fallback;
  }
}
