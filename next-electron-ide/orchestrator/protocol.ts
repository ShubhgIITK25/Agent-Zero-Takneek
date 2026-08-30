/**
 * ============================================================================
 *  WIRE PROTOCOL — Electron main  <->  orchestrator child process
 * ============================================================================
 * Newline-delimited JSON over stdio. One JSON object per line, no framing
 * header, no length prefix.
 *
 * Why stdio and not a local HTTP port (as the retrieval service uses):
 *   - No port allocation, no "what if 8731 is taken", no firewall prompt on
 *     Windows. The pipe exists because we spawned the process.
 *   - The channel dies exactly when the process dies, which is what makes the
 *     watchdog in main.ts trivially correct: EOF on stdout == orchestrator
 *     gone. An HTTP client can't tell "crashed" from "slow" without timeouts.
 *   - Ordering is guaranteed by the pipe, so the event log the dashboard
 *     renders is in true causal order for free.
 * The retrieval service uses HTTP instead because it is a *request/response*
 * service with no streaming and it is written in Python; this channel is
 * long-lived and stream-shaped. Different problem, different transport.
 *
 * TWO MESSAGE FAMILIES share the one channel, distinguished by `kind`:
 *   Command  (main -> orchestrator)  imperative, may carry an `id` for reply
 *   Event    (orchestrator -> main)  everything the dashboard renders
 *
 * Every Event carries `taskId` and a monotonic `seq` so the renderer can
 * detect a dropped/out-of-order frame, and `ts` so post-hoc replay shows real
 * timing rather than render timing.
 */

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

export type AgentRole = 'planner' | 'implementer' | 'verifier' | 'tiebreak' | 'compactor' | 'isolated';

/**
 * `replaced` is distinct from `failed` on purpose. It means the re-planner
 * decided this subtask was badly scoped and swapped it for a different
 * decomposition — the work it represented is still being attempted, just under
 * new ids. So it is terminal for the scheduler but must NOT make the task fail,
 * which is the one thing `failed` and `skipped` both do.
 */
export type SubtaskStatus =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'replaced';

export type Subtask = {
  id: string;
  title: string;
  detail: string;
  /** ids of subtasks that must be `done` before this one may start. */
  dependsOn: string[];
  /** Drives routing: cheap models can handle 'simple', not 'codegen'. */
  category: 'analysis' | 'codegen' | 'simple_edit' | 'verification';
  status: SubtaskStatus;
  attempts: number;
  costSpent: number;
  tokensSpent: number;
  lastError?: string;
  /**
   * 0 for subtasks the original planner produced; 1 for subtasks a re-plan
   * produced. This is the bound that stops re-planning from recursing: only
   * depth-0 subtasks may be re-planned, so a replacement that also fails is
   * simply failed, never re-planned again.
   */
  replanDepth?: number;
  /** Set on a replacement: which subtask it was created to replace. */
  replacedSubtaskId?: string;
};

export type RoutingSignals = {
  category: Subtask['category'];
  estimatedContextTokens: number;
  budgetRemaining: number;
  timeRemaining: number;
  attemptNumber: number;
  /** provider ids currently in rate-limit backoff at decision time */
  cooldownProviders: string[];
  /** set when this route is a fallback after a failure */
  escalated?: boolean;
};

export type PendingApproval = {
  requestId: string;
  taskId: string;
  /** `diff` carries file edits for block-level review; `command` is a shell exec. */
  kind: 'diff' | 'command';
  subtaskId: string;
  summary: string;
  command?: string;
  diff?: FileDiff[];
};

export type DiffBlock = {
  id: string;
  /** unified-diff hunk header, e.g. "@@ -14,7 +14,9 @@" */
  header: string;
  lines: { type: 'context' | 'add' | 'del'; text: string }[];
  /** Git emitted an EOF marker for this hunk; used to preserve newline state. */
  newlineChanged?: boolean;
};

export type FileDiff = {
  path: string;
  /** absent for a newly created file */
  oldContent: string | null;
  newContent: string;
  blocks: DiffBlock[];
};

/** What the user accepted, block by block. Empty `acceptedBlockIds` == reject all. */
export type ApprovalDecision = {
  requestId: string;
  approved: boolean;
  acceptedBlockIds?: string[];
};

// ---------------------------------------------------------------------------
// Commands: main -> orchestrator
// ---------------------------------------------------------------------------

export type TaskConfig = {
  rootPath: string;
  codebaseId: string;
  /** base URL of the Python retrieval service, or null if it failed to start */
  retrievalUrl: string | null;
  /** API keys + provider config, read from the settings screen */
  env: Record<string, string>;
  /** model ids (from models.ts) the user enabled, in preference order */
  enabledModelIds: string[];
  /**
   * Last known health per model id, from the Settings screen's probe (see
   * electron/model-health.ts). Optional: a task started before any check ever
   * ran, or resumed from an older snapshot, simply has none — and "not
   * checked" must never be read as "broken".
   */
  modelHealth?: Record<string, { state: string; detail: string; checkedAt: number }>;
  /**
   * How many independent subtasks may run at once. 1 reproduces the strictly
   * sequential behaviour exactly, and is the escape hatch if parallelism ever
   * misbehaves in front of a judge. Clamped to [1, 6] by the scheduler.
   */
  maxParallelSubtasks?: number;
  /** hard ceilings from the PS; exceeding either fails the task outright */
  maxCostUsd: number;
  maxSeconds: number;
};

export type Command =
  | { kind: 'command'; type: 'start_task'; id: string; taskId: string; prompt: string; config: TaskConfig }
  | { kind: 'command'; type: 'resume_task'; id: string; taskId: string; config: TaskConfig }
  | { kind: 'command'; type: 'revert_latest'; id: string; taskId: string; codebaseId: string }
  | { kind: 'command'; type: 'cancel_task'; id: string; taskId: string }
  | { kind: 'command'; type: 'approval_response'; id: string; decision: ApprovalDecision }
  | { kind: 'command'; type: 'isolated_query'; id: string; question: string; config: TaskConfig }
  | { kind: 'command'; type: 'ping'; id: string };

/** Reply to a command that carried an `id`. Not an Event — never rendered. */
export type CommandReply = {
  kind: 'reply';
  id: string;
  ok: boolean;
  error?: string;
  data?: unknown;
};

// ---------------------------------------------------------------------------
// Events: orchestrator -> main -> renderer
// ---------------------------------------------------------------------------

export type EventBody =
  | { type: 'ready' }
  | { type: 'task_started'; prompt: string; resumed: boolean }
  | { type: 'task_finished'; summary: string }
  | { type: 'task_failed'; reason: string }
  | { type: 'task_cancelled' }
  | { type: 'plan_created'; subtasks: Subtask[]; shortCircuited: boolean }
  /** A subtask exhausted its retries and was replaced by a different decomposition. */
  | { type: 'replan'; failedSubtaskId: string; diagnosis: string; replacements: Subtask[]; replansRemaining: number }
  | { type: 'subtask_started'; subtaskId: string; title: string; attempt: number }
  | { type: 'subtask_finished'; subtaskId: string; status: SubtaskStatus; note?: string }
  /** Emitted the instant the router decides — never reconstructed after the fact. */
  | { type: 'routing_decision'; subtaskId: string; nodeId: string; modelId: string; provider: string; reason: string; signals: RoutingSignals; rejected: { modelId: string; why: string }[] }
  | { type: 'agent_call_start'; nodeId: string; parentId: string | null; role: AgentRole; subtaskId: string | null; modelId: string; provider: string; prompt: string }
  | { type: 'agent_call_end'; nodeId: string; promptTokens: number; completionTokens: number; costUsd: number; latencyMs: number; output: string; error?: string }
  | { type: 'thought'; nodeId: string; text: string }
  | { type: 'tool_call'; nodeId: string; callId: string; name: string; args: Record<string, unknown>; sideEffecting: boolean }
  | { type: 'tool_result'; nodeId: string; callId: string; result: string; outcome: 'done' | 'rejected' | 'error'; ms: number }
  /** Exactly which files/chunks were in this agent's context at this step. */
  | { type: 'context_snapshot'; nodeId: string; subtaskId: string | null; items: { path: string; lines?: string; tokens: number; source: 'retrieval' | 'manual' | 'agents_md' | 'plan' | 'history' }[]; totalTokens: number }
  | { type: 'approval_request'; request: PendingApproval }
  | { type: 'approval_resolved'; requestId: string; approved: boolean; acceptedBlockIds: string[] }
  /** A controlled file write, with hashes for safe post-run revert. */
  | { type: 'file_change'; changeId: string; nodeId: string; subtaskId: string; path: string; beforeExists: boolean; afterExists: boolean; beforeHash: string | null; afterHash: string }
  | { type: 'workspace_reverted'; changeId: string; path: string; automatic?: boolean }
  | { type: 'compaction'; nodeId: string | null; beforeTokens: number; afterTokens: number; summarized: number; preserved: string[] }
  | { type: 'budget_update'; costUsd: number; elapsedSeconds: number; maxCostUsd: number; maxSeconds: number; promptTokens: number; completionTokens: number }
  /** A cap fired or two agents disagreed. Always surfaced, never silent. */
  | { type: 'intervention'; subtaskId: string | null; cause: 'retry_cap' | 'step_cap' | 'token_cap' | 'cost_ceiling' | 'time_ceiling' | 'identical_repeat' | 'disagreement' | 'provider_failover' | 'resume_rollback' | 'dependency_deadlock' | 'workspace_restored' | 'replan' | 'replan_declined' | 'retrieval_weak' | 'model_unhealthy' | 'stale_proposal'; detail: string; action: string }
  /**
   * Which subtasks are executing right now. Emitted only when the set changes,
   * so the dashboard can draw real overlap rather than inferring it from
   * interleaved timestamps.
   */
  | { type: 'concurrency'; running: { subtaskId: string; title: string }[]; maxParallel: number }
  | { type: 'checkpoint'; step: number; subtaskStates: { id: string; status: SubtaskStatus }[] }
  | { type: 'resumed'; fromStep: number; note: string }
  | { type: 'isolated_answer'; requestId: string; answer: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type OrchestratorEvent = {
  kind: 'event';
  taskId: string;
  seq: number;
  ts: number;
} & EventBody;

export type Outbound = OrchestratorEvent | CommandReply;

/** Parse one stdio line; returns null for blank lines and unparseable junk. */
export function parseLine<T>(line: string): T | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}
