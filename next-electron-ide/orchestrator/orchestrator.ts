/**
 * ============================================================================
 *  ORCHESTRATOR — the pipeline
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
 * Whichever fires first halts the subtask and EMITS AN INTERVENTION — never a
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
import { Router, RateLimitTracker } from './router';
import { ModelEntry, findModel, eligibleModels } from './models';
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

export type Emit = (body: EventBody) => void;

let nodeCounter = 0;
const newNodeId = () => `n${++nodeCounter}`;

export class TaskRunner {
  private budget: Budget;
  private router: Router;
  private rateLimits = new RateLimitTracker();
  private cancelled = false;
  private pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
  private snapshot: TaskSnapshot;
  private step = 0;
  private notes: string[] = [];
  private changedFiles = new Set<string>();
  /**
   * BACKTRACK POINT — the workspace as it stood before the subtask now running
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
  private backtrack = new Map<string, { content: string | null; wasTracked: boolean }>();
  /** Which subtask `backtrack` currently belongs to. */
  private backtrackOwner: string | null = null;
  /** .nexideignore / .ignore — loaded once per task, not re-read on every tool call. */
  private ignore: ReturnType<typeof loadIgnoreMatcher>;

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
    this.router = new Router(config.enabledModelIds, this.rateLimits);

    const agentsMd = loadAgentsMd(config.rootPath);
    this.ignore = loadIgnoreMatcher(config.rootPath);
    if (this.ignore.sourceFile) {
      emit({
        type: 'log',
        level: 'info',
        message: `Context ignore: ${this.ignore.patternCount} pattern(s) loaded from ${this.ignore.sourceFile} — matching paths are excluded from retrieve_context, read_file and list_dir.`,
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
    this.cancelled = true;
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
  private async requestDiffApproval(
    subtaskId: string,
    nodeId: string,
    diffs: FileDiff[],
    summary: string
  ): Promise<{ approved: boolean; written: string[]; fullyApplied: boolean; rejectedBlocks: number }> {
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

    if (!decision.approved) return { approved: false, written: [], fullyApplied: false, rejectedBlocks: 0 };

    // An explicit list means block-level review; its absence means a plain
    // accept-all. `null`, not a pre-expanded list, so the per-file fallback
    // below can tell "user reviewed and picked none here" from "no list sent".
    const explicit = Array.isArray(decision.acceptedBlockIds) ? decision.acceptedBlockIds : null;
    const written: string[] = [];
    let fullyApplied = true;
    let rejectedBlocks = 0;

    for (const d of diffs) {
      const blockIds = d.blocks.map((b) => b.id);
      if (blockIds.length === 0) continue;

      let acceptedHere = explicit ? blockIds.filter((id) => explicit.includes(id)) : blockIds;

      // Approved, but nothing here matched — an id/serialisation mismatch, not
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
      const full = path.resolve(this.config.rootPath, d.path);
      // Stash what is there now, BEFORE overwriting it, so a failed
      // verification can put it back. Must happen on the write path — this is
      // the only point at which the pre-edit content still exists.
      await this.captureBacktrackPoint(subtaskId, d.path, full);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, finalContent, 'utf8');
      written.push(d.path);
      this.changedFiles.add(d.path);

      if (acceptedHere.length < blockIds.length) {
        fullyApplied = false;
        rejectedBlocks += blockIds.length - acceptedHere.length;
        this.notes.push(
          `Partial approval on ${d.path}: ${acceptedHere.length}/${blockIds.length} blocks applied.`
        );
      }
    }
    return { approved: true, written, fullyApplied, rejectedBlocks };
  }

  private async requestCommandApproval(subtaskId: string, command: string): Promise<boolean> {
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

    for (let attempt = 0; attempt < 3; attempt++) {
      const route = attempt === 0 ? this.router.route(opts.signals) : this.router.routeFallback(opts.signals, tried);
      if (!route) {
        this.emit({
          type: 'intervention',
          subtaskId: opts.subtaskId,
          cause: 'provider_failover',
          detail: `No eligible model available (tried: ${tried.join(', ') || 'none'})`,
          action: 'Aborting this step — every enabled model is excluded, over budget, or rate-limited.',
        });
        return null;
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

      try {
        const result = await callModel(route.model, opts.messages, opts.tools, this.config.env);
        this.rateLimits.clear(route.model.provider);
        this.budget.record(result.promptTokens, result.completionTokens, result.costUsd);

        this.emit({
          type: 'agent_call_end',
          nodeId,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
          output: result.text.slice(0, 20000),
        });
        if (result.text.trim()) this.emit({ type: 'thought', nodeId, text: result.text.slice(0, 4000) });
        this.emitBudget();

        return { nodeId, text: result.text, toolCalls: result.toolCalls, model: route.model };
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError(String(err), { retryable: true, rateLimited: false });
        this.emit({ type: 'agent_call_end', nodeId, promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0, output: '', error: pe.message });

        tried.push(route.model.id);
        if (!pe.retryable) {
          this.emit({
            type: 'intervention',
            subtaskId: opts.subtaskId,
            cause: 'provider_failover',
            detail: pe.message,
            action: 'Not retryable (bad request or bad key) — failing this step rather than burning budget.',
          });
          return null;
        }

        this.rateLimits.penalise(route.model.provider, pe.rateLimited);
        this.emit({
          type: 'intervention',
          subtaskId: opts.subtaskId,
          cause: 'provider_failover',
          detail: `${route.model.label} (${route.model.provider}) failed: ${pe.message}`,
          action: 'Re-routing the same context to another model — no work is lost.',
        });
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
      if (this.snapshot.subtasks.length === 0) {
        const plan = await this.plan();
        if (!plan) return this.fail('Planning failed — no eligible model could produce a plan.');
        this.snapshot.subtasks = plan.subtasks;
        this.snapshot.pinnedFacts = [
          `Overall goal: ${plan.restatedGoal}`,
          ...this.snapshot.pinnedFacts,
        ];
        this.emit({ type: 'plan_created', subtasks: plan.subtasks, shortCircuited: plan.trivial });
        this.checkpoint();
      }

      // Schedule: run any subtask whose dependencies are all done.
      for (;;) {
        if (this.cancelled) return this.cancelledOut();
        if (this.ceilingBreached()) return this.fail('Hard ceiling reached.');

        const next = this.snapshot.subtasks.find(
          (s) =>
            (s.status === 'pending' || s.status === 'blocked') &&
            s.dependsOn.every((d) => this.snapshot.subtasks.find((x) => x.id === d)?.status === 'done')
        );
        if (!next) {
          // The scheduler has run dry but some subtasks never reached a
          // terminal state. That is a dependency deadlock — a cycle, a
          // dependency that failed/skipped without its dependents being
          // marked, or a stale in-flight state from a crash. Surface it and
          // skip the stranded work rather than "finishing" with silent holes.
          this.resolveDeadlockedSubtasks();
          break;
        }

        // A dependency failed permanently — this subtask can never run.
        if (next.status === 'blocked') {
          next.status = 'skipped';
          this.emit({ type: 'subtask_finished', subtaskId: next.id, status: 'skipped', note: 'dependency failed' });
          continue;
        }

        await this.runSubtask(next);
        this.checkpoint();
      }

      // Terminal by construction: the scheduling loop above only exits once
      // every subtask is 'done', 'failed', or 'skipped' (a 'blocked' subtask
      // is converted to 'skipped' as soon as it is selected). So "did the
      // task actually succeed" is exactly "did every subtask end 'done'" —
      // a failed subtask, or one skipped because its dependency failed, both
      // mean the task did NOT complete, even if most subtasks passed.
      const incomplete = this.snapshot.subtasks.filter((s) => s.status !== 'done');
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
          reason: `${incomplete.length}/${this.snapshot.subtasks.length} subtask(s) did not complete — ${detail}\n\n${summary}`,
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
    this.backtrack = new Map();
    this.backtrackOwner = subtaskId;
  }

  /** Stash a file's current content the first time this subtask writes to it. */
  private async captureBacktrackPoint(subtaskId: string, rel: string, full: string): Promise<void> {
    if (this.backtrackOwner !== subtaskId) return;
    if (this.backtrack.has(rel)) return; // already have the pre-subtask state
    const wasTracked = this.changedFiles.has(rel);
    try {
      this.backtrack.set(rel, { content: await fs.readFile(full, 'utf8'), wasTracked });
    } catch {
      // Unreadable means it does not exist yet: undoing a create is a delete.
      this.backtrack.set(rel, { content: null, wasTracked });
    }
  }

  /**
   * Undo every edit the current subtask made, returning the workspace to its
   * pre-subtask state. Returns the number of files restored.
   *
   * This is the actual backtracking step. Without it a failed verification
   * retries ON TOP of the edits that just failed verification, so attempt 2
   * starts from a tree the verifier already rejected and attempt 3 compounds
   * it — and if all attempts fail, the union of every broken attempt is left
   * on disk with the subtask marked `failed` and nobody cleaning up.
   */
  private async restoreBacktrackPoint(subtask: Subtask, why: string): Promise<number> {
    if (!this.backtrack.size) return 0;

    const restored: string[] = [];
    const failures: string[] = [];
    // Some of these edits may have been approved by the user by hand. Undoing
    // a human's approved change is never allowed to be silent, which is why
    // this reports through `intervention` and names every file.
    const approvedByHand = [...this.backtrack.keys()];

    for (const [rel, prior] of this.backtrack) {
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
        // stashed content already includes that earlier change — so leave it.
        if (!prior.wasTracked) this.changedFiles.delete(rel);
      } catch (err) {
        failures.push(`${rel} (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    this.emit({
      type: 'intervention',
      subtaskId: subtask.id,
      cause: 'workspace_restored',
      detail:
        `${why} Reverted ${restored.length} file(s) to their state before "${subtask.title}" ran: ` +
        `${approvedByHand.join(', ')}.` +
        (failures.length ? ` Could NOT revert: ${failures.join('; ')}.` : ''),
      action: failures.length
        ? 'The workspace is only partially rolled back — the files listed as un-revertable still hold the failed edit.'
        : 'The next attempt starts from a clean tree instead of building on a rejected one.',
    });

    this.backtrack = new Map();
    return restored.length;
  }

  /** One subtask, with escalating retries, verification, and tie-break. */
  private async runSubtask(subtask: Subtask): Promise<void> {
    // One backtrack point per subtask, taken before the first attempt.
    //
    // On a RESUME this is necessarily empty: the pre-edit contents lived in
    // memory and that process is gone. So a rollback after a resume can only
    // undo edits made since the resume, and the intervention it emits names
    // exactly which files it did revert — it never claims a clean tree it
    // cannot deliver.
    this.beginBacktrackPoint(subtask.id);

    for (let attempt = subtask.attempts + 1; attempt <= MAX_RETRIES_PER_SUBTASK; attempt++) {
      if (this.cancelled || this.ceilingBreached()) return;

      subtask.attempts = attempt;
      subtask.status = 'running';
      this.emit({ type: 'subtask_started', subtaskId: subtask.id, title: subtask.title, attempt });

      const outcome = await this.executeSubtask(subtask, attempt);
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
          continue;
        }
        await this.restoreBacktrackPoint(subtask, 'The agent reported it was blocked and retries are exhausted.');
        subtask.status = 'failed';
        this.emit({ type: 'subtask_finished', subtaskId: subtask.id, status: 'failed', note: outcome.claim });
        this.blockDependents(subtask.id);
        return;
      }

      // Read-only analysis with no edits does not need an independent verifier
      // call — there is no repository state to check, and the call would cost
      // real money to confirm that nothing happened.
      const worthVerifying = subtask.category !== 'analysis' || this.changedFiles.size > 0;
      if (!worthVerifying) {
        this.backtrack = new Map();
        subtask.status = 'done';
        this.notes.push(`${subtask.title}: ${outcome.claim}`);
        this.emit({ type: 'subtask_finished', subtaskId: subtask.id, status: 'done', note: 'analysis-only, no verification needed' });
        return;
      }

      subtask.status = 'verifying';
      const verdict = await this.verify(subtask, outcome.claim);

      if (verdict.verdict === 'pass') {
        // Verified work is committed: drop the undo point so no later failure
        // can reach back and revert a subtask that passed.
        this.backtrack = new Map();
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
          action: 'Neither side wins by default — spending one call on a third model to break the tie.',
        });
        const tie = await this.tiebreak(subtask, outcome.claim, verdict);
        if (tie) {
          finalVerdict = tie.verdict;
          this.notes.push(`Tie-break on "${subtask.title}": ${tie.verdict} — ${tie.reason}`);
        }
      }

      if (finalVerdict === 'pass') {
        // The tie-break overrode the verifier's fail — so this work stands and
        // must not be rolled back either.
        this.backtrack = new Map();
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
        const reverted = await this.restoreBacktrackPoint(
          subtask,
          `Verification failed on attempt ${attempt}.`
        );
        // Feed the failure into the next attempt so it is a different attempt,
        // not the same one again — and tell it the tree was rolled back, or it
        // will assume its earlier edits are still there and write half a fix.
        const convo = this.snapshot.conversations[subtask.id] ?? [];
        convo.push({
          role: 'user',
          content:
            `Your previous attempt was rejected by an independent verifier: ${verdict.reason}\n` +
            `Evidence: ${verdict.evidence}\n` +
            (reverted
              ? `Your edits from that attempt have been REVERTED — the ${reverted} file(s) you changed are back to their original contents. Start from the original code, not from your previous edit.\n`
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
   * A resumed snapshot can hold subtasks that were mid-flight when the IDE
   * died: `running` (implementer loop) or `verifying` (verifier call). The
   * scheduler only ever starts `pending` / `blocked` work, so these would be
   * stranded and the task would "complete" with a hole. Roll them back to
   * `pending` — their checkpointed conversation is reused, and `attempts` is
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
   * subtasks remain. Every such subtask is genuinely unreachable — the
   * scheduler has already exhausted everything whose dependencies are `done` —
   * so mark them `skipped` with a diagnosis of why. */
  private resolveDeadlockedSubtasks(): void {
    const terminal = new Set(['done', 'failed', 'skipped']);
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
        action: 'Skipping it — its dependencies cannot be satisfied.',
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
    attempt: number
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
          action: 'Halting the subtask — this is the "many cheap steps" runaway, which a step cap alone misses.',
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
            nodeId: null,
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
        parentId: null,
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
            action: 'Halting the subtask — the agent is looping, not progressing.',
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
      .map((id) => findModel(id))
      .filter((m): m is ModelEntry => !!m && eligibleModels().some((e) => e.id === m.id));
    if (!enabled.length) return null;
    return enabled.reduce((a, b) => (a.pricing.inputPerM + a.pricing.outputPerM <= b.pricing.inputPerM + b.pricing.outputPerM ? a : b));
  }

  private async verify(subtask: Subtask, claim: string): Promise<agents.Verdict> {
    const messages = agents.verifierMessages(
      this.snapshot.pinnedFacts[0] ?? this.prompt,
      subtask,
      claim,
      [...this.changedFiles]
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
    // The verifier gets a short tool budget of its own — enough to actually
    // look at the repo, not enough to turn into a second implementer.
    for (let step = 0; step < 4; step++) {
      const res = await this.dispatch({
        role: 'verifier',
        subtaskId: subtask.id,
        parentId: null,
        messages: convo,
        tools: VERIFIER_TOOL_SCHEMAS,
        signals,
      });
      if (!res) {
        return { verdict: 'fail', confidence: 0.3, reason: 'Verifier could not run (no model available).', evidence: '' };
      }
      if (res.toolCalls.length === 0) return agents.parseVerdict(res.text);

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

  private async tiebreak(subtask: Subtask, claim: string, verdict: agents.Verdict) {
    const messages = agents.tiebreakMessages(subtask, claim, verdict);
    const res = await this.dispatch({
      role: 'tiebreak',
      subtaskId: subtask.id,
      parentId: null,
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
      parentId: null,
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
