/**
 * ============================================================================
 *  TRACE STORE — folds the orchestrator's event stream into a renderable tree
 * ============================================================================
 * The dashboard requirement is that it works identically live and after the
 * fact. That is only cheap if BOTH modes consume the same thing — so this
 * reducer takes an array of events and returns a complete view, and the
 * component does not care whether those events arrived over IPC one at a time
 * or were read back from events.jsonl in one gulp.
 *
 * That single decision is what removes the usual "live view vs history view"
 * divergence: there is one code path, so there are no gaps between the modes.
 */

export type TraceEvent = {
  kind: "event";
  taskId: string;
  seq: number;
  ts: number;
  type: string;
  [key: string]: any;
};

export type ToolCallRecord = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  sideEffecting: boolean;
  result?: string;
  outcome?: "done" | "rejected" | "error";
  ms?: number;
};

export type TraceNode = {
  nodeId: string;
  parentId: string | null;
  role: string;
  subtaskId: string | null;
  modelId: string;
  provider: string;
  prompt: string;
  output?: string;
  error?: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  startedAt: number;
  finishedAt?: number;
  thoughts: string[];
  toolCalls: ToolCallRecord[];
  contextItems: {
    path: string;
    lines?: string;
    tokens: number;
    source: string;
  }[];
  contextTotalTokens: number;
  routing?: {
    reason: string;
    signals: Record<string, any>;
    rejected: { modelId: string; why: string }[];
  };
};

export type ExecutionGraphNode = {
  id: string;
  seq: number;
  ts: number;
  type: string;
  kind: "agent" | "tool" | "change" | "control";
  label: string;
  detail: string;
  parentSeq: number | null;
  nodeId?: string;
  subtaskId?: string | null;
  changeId?: string;
};

export type FileChangeView = {
  changeId: string;
  path: string;
  ts: number;
  revertedAt?: number;
};

export type SubtaskView = {
  id: string;
  title: string;
  detail: string;
  category: string;
  dependsOn: string[];
  status: string;
  attempts: number;
  note?: string;
  /** Set on a subtask a re-plan created: which subtask it replaced. */
  replacedSubtaskId?: string;
  /** Event-stream timestamps. Present only once the subtask has actually run. */
  startedAt?: number;
  finishedAt?: number;
};

export type Intervention = {
  ts: number;
  subtaskId: string | null;
  cause: string;
  detail: string;
  action: string;
};

export type CompactionRecord = {
  ts: number;
  beforeTokens: number;
  afterTokens: number;
  summarized: number;
  preserved: string[];
};

export type ApprovalRecord = {
  requestId: string;
  kind: "diff" | "command";
  subtaskId: string;
  summary: string;
  command?: string;
  diff?: any[];
  status: "pending" | "approved" | "rejected";
  acceptedBlockIds?: string[];
};

export type TraceView = {
  taskId: string | null;
  prompt: string;
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  resumed: boolean;
  resumeNote: string | null;
  summary: string | null;
  failureReason: string | null;
  planShortCircuited: boolean;
  subtasks: SubtaskView[];
  /** One entry per mid-task re-plan: what was dropped and what replaced it. */
  replans: { failedSubtaskId: string; diagnosis: string; replacementIds: string[] }[];
  nodes: TraceNode[];
  /** Ordered, bounded projection of the durable event stream for the graph UI. */
  executionGraph: ExecutionGraphNode[];
  fileChanges: FileChangeView[];
  interventions: Intervention[];
  compactions: CompactionRecord[];
  approvals: ApprovalRecord[];
  budget: {
    costUsd: number;
    elapsedSeconds: number;
    maxCostUsd: number;
    maxSeconds: number;
    promptTokens: number;
    completionTokens: number;
  };
  lastCheckpointStep: number;
  logs: { ts: number; level: string; message: string }[];
  /**
   * How many subtasks were executing at once, over time. Recorded from the
   * orchestrator's `concurrency` events rather than inferred from interleaved
   * start/finish timestamps — inference would quietly turn "these two ran back
   * to back" into "these two ran together" whenever a clock or an event
   * ordering was slightly off, which is exactly the claim a parallelism
   * feature must not fake.
   */
  concurrency: { ts: number; running: { subtaskId: string; title: string }[]; maxParallel: number }[];
  /** Highest simultaneous count actually observed. 1 means it never parallelised. */
  peakParallel: number;
  /** The configured ceiling, as reported by the orchestrator. */
  maxParallel: number;
};

export function emptyTrace(): TraceView {
  return {
    taskId: null,
    prompt: "",
    status: "idle",
    resumed: false,
    resumeNote: null,
    summary: null,
    failureReason: null,
    planShortCircuited: false,
    subtasks: [],
    replans: [],
    nodes: [],
    executionGraph: [],
    fileChanges: [],
    interventions: [],
    compactions: [],
    approvals: [],
    budget: {
      costUsd: 0,
      elapsedSeconds: 0,
      maxCostUsd: 0.5,
      maxSeconds: 2700,
      promptTokens: 0,
      completionTokens: 0,
    },
    lastCheckpointStep: 0,
    logs: [],
    concurrency: [],
    peakParallel: 0,
    maxParallel: 1,
  };
}

function graphKind(type: string): ExecutionGraphNode["kind"] {
  if (type === "thought" || type.startsWith("agent_call") || type === "routing_decision") return "agent";
  if (type.startsWith("tool_") || type.startsWith("approval_")) return "tool";
  if (type === "file_change" || type === "workspace_reverted") return "change";
  return "control";
}

function graphLabel(e: TraceEvent): string {
  switch (e.type) {
    case "agent_call_start": return `${e.role ?? "agent"} → ${e.modelId ?? "model"}`;
    case "agent_call_end": return `Agent returned${e.error ? " (error)" : ""}`;
    case "routing_decision": return `Route → ${e.modelId ?? "model"}`;
    case "tool_call": return `Tool · ${e.name ?? "unknown"}`;
    case "tool_result": return `Tool result · ${e.outcome ?? "unknown"}`;
    case "file_change": return `Change · ${e.path ?? "file"}`;
    case "workspace_reverted": return `Reverted · ${e.path ?? "file"}`;
    case "thought": return "Thought";
    case "checkpoint": return `Checkpoint · step ${e.step ?? "?"}`;
    case "intervention": return `Intervention · ${String(e.cause ?? "unknown").replace(/_/g, " ")}`;
    case "approval_request": return `Approval · ${e.request?.kind ?? "request"}`;
    case "approval_resolved": return `Approval · ${e.approved ? "approved" : "rejected"}`;
    case "subtask_started": return `Subtask · ${e.title ?? e.subtaskId ?? "started"}`;
    case "subtask_finished": return `Subtask · ${e.status ?? "finished"}`;
    default: return String(e.type).replace(/_/g, " ");
  }
}

function graphDetail(e: TraceEvent): string {
  switch (e.type) {
    case "thought": return String(e.text ?? "");
    case "task_started": return String(e.prompt ?? "");
    case "plan_created": return `${(e.subtasks ?? []).length} subtask(s) planned.`;
    case "subtask_started": return `${e.subtaskId ?? "unknown"} · attempt ${e.attempt ?? "?"}`;
    case "subtask_finished": return `${e.subtaskId ?? "unknown"}${e.note ? ` · ${e.note}` : ""}`;
    case "tool_call": return `${e.name ?? "unknown"}${e.sideEffecting ? " · approval-gated" : " · read-only"}`;
    case "tool_result": return `${e.outcome ?? "unknown"}${e.ms != null ? ` · ${e.ms}ms` : ""}`;
    case "agent_call_end": return `${e.promptTokens ?? 0} prompt + ${e.completionTokens ?? 0} completion tokens${e.error ? ` · ${e.error}` : ""}`;
    case "file_change": return `${e.beforeExists ? "updated" : "created"} · ${String(e.beforeHash ?? "none").slice(0, 8)} → ${String(e.afterHash ?? "").slice(0, 8)}`;
    case "workspace_reverted": return `${e.automatic ? "Automatically restored" : "Restored"} the before-state for ${e.changeId ?? "the latest change"}.`;
    case "intervention": return `${e.detail ?? ""}${e.action ? ` · ${e.action}` : ""}`;
    case "log": return String(e.message ?? "");
    default: return `${e.type}${e.ts ? ` · ${new Date(e.ts).toLocaleTimeString()}` : ""}`;
  }
}

function makeGraphNode(e: TraceEvent, parentSeq: number | null): ExecutionGraphNode {
  return {
    id: `event-${e.seq}`,
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    kind: graphKind(e.type),
    label: graphLabel(e),
    detail: graphDetail(e),
    parentSeq,
    ...(e.nodeId === undefined ? {} : { nodeId: e.nodeId }),
    ...(e.subtaskId === undefined ? {} : { subtaskId: e.subtaskId }),
    ...(e.changeId === undefined ? {} : { changeId: e.changeId }),
  };
}

/** Applies one event. Pure — returns a new view, never mutates the input. */
export function applyEvent(view: TraceView, e: TraceEvent): TraceView {
  const v: TraceView = {
    ...view,
    subtasks: [...view.subtasks],
    replans: [...(view.replans ?? [])],
    nodes: [...view.nodes],
    executionGraph: [...(view.executionGraph ?? [])],
    fileChanges: [...(view.fileChanges ?? [])],
    interventions: [...view.interventions],
    compactions: [...view.compactions],
    approvals: [...view.approvals],
    logs: [...view.logs],
  };
  if (e.taskId) v.taskId = e.taskId;
  const previousGraph = v.executionGraph.length ? v.executionGraph[v.executionGraph.length - 1] : null;
  v.executionGraph = [...v.executionGraph, makeGraphNode(e, previousGraph?.seq ?? null)].slice(-500);

  const node = (id: string) => v.nodes.find((n) => n.nodeId === id);

  switch (e.type) {
    case "task_started":
      v.prompt = e.prompt;
      v.status = "running";
      v.resumed = !!e.resumed;
      v.summary = null;
      v.failureReason = null;
      break;

    case "resumed":
      v.resumeNote =
        `Resumed from checkpoint step ${e.fromStep}. ${e.note ?? ""}`.trim();
      break;

    case "plan_created":
      v.subtasks = (e.subtasks ?? []).map((s: any) => ({
        id: s.id,
        title: s.title,
        detail: s.detail,
        category: s.category,
        dependsOn: s.dependsOn ?? [],
        status: s.status ?? "pending",
        attempts: s.attempts ?? 0,
      }));
      v.planShortCircuited = !!e.shortCircuited;
      break;

    /**
     * A re-plan swapped one subtask for a different decomposition. The
     * replacements are INSERTED after the subtask they replace rather than
     * replacing the whole list, so the plan reads in execution order and the
     * subtask that was dropped stays visible with its trace — "what we tried
     * and abandoned" is exactly what a reviewer needs to see.
     */
    case "replan": {
      const at = v.subtasks.findIndex((x) => x.id === e.failedSubtaskId);
      const additions: SubtaskView[] = (e.replacements ?? []).map((s: any) => ({
        id: s.id,
        title: s.title,
        detail: s.detail,
        category: s.category,
        dependsOn: s.dependsOn ?? [],
        status: s.status ?? "pending",
        attempts: s.attempts ?? 0,
        replacedSubtaskId: e.failedSubtaskId,
      }));
      // Re-point dependents at the last replacement, mirroring what the
      // orchestrator did to the real DAG, so the rendered graph is not a
      // second, diverging story about the same run.
      const lastId = additions.length ? additions[additions.length - 1].id : null;
      if (lastId) {
        v.subtasks = v.subtasks.map((s) =>
          s.dependsOn.includes(e.failedSubtaskId)
            ? { ...s, dependsOn: s.dependsOn.map((d) => (d === e.failedSubtaskId ? lastId : d)) }
            : s
        );
      }
      v.subtasks.splice(at < 0 ? v.subtasks.length : at + 1, 0, ...additions);
      v.replans = [
        ...(v.replans ?? []),
        { failedSubtaskId: e.failedSubtaskId, diagnosis: e.diagnosis, replacementIds: additions.map((a) => a.id) },
      ];
      break;
    }

    case "subtask_started": {
      const s = v.subtasks.find((x) => x.id === e.subtaskId);
      if (s) {
        const i = v.subtasks.indexOf(s);
        // Keep the FIRST start: a retry restarts the same subtask, and the bar
        // on the timeline should span the whole time it occupied a slot.
        v.subtasks[i] = {
          ...s,
          status: "running",
          attempts: e.attempt,
          startedAt: s.startedAt ?? e.ts,
          finishedAt: undefined,
        };
      }
      break;
    }

    case "subtask_finished": {
      const s = v.subtasks.find((x) => x.id === e.subtaskId);
      if (s) {
        const i = v.subtasks.indexOf(s);
        v.subtasks[i] = { ...s, status: e.status, note: e.note, finishedAt: e.ts };
      }
      break;
    }

    case "concurrency": {
      const running = Array.isArray(e.running) ? e.running : [];
      v.concurrency = [...v.concurrency, { ts: e.ts, running, maxParallel: e.maxParallel ?? 1 }];
      v.peakParallel = Math.max(v.peakParallel, running.length);
      v.maxParallel = Math.max(v.maxParallel, e.maxParallel ?? 1);
      break;
    }

    case "routing_decision": {
      // The decision arrives BEFORE agent_call_start, so stash it on a
      // placeholder that agent_call_start then fills in. This ordering is
      // deliberate: it is what lets the UI show "routing to X…" while the
      // call is still in flight, rather than only after it returns.
      v.nodes.push({
        nodeId: e.nodeId,
        parentId: null,
        role: "pending",
        subtaskId: e.subtaskId || null,
        modelId: e.modelId,
        provider: e.provider,
        prompt: "",
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        startedAt: e.ts,
        thoughts: [],
        toolCalls: [],
        contextItems: [],
        contextTotalTokens: 0,
        routing: {
          reason: e.reason,
          signals: e.signals ?? {},
          rejected: e.rejected ?? [],
        },
      });
      break;
    }

    case "agent_call_start": {
      const existing = node(e.nodeId);
      if (existing) {
        Object.assign(existing, {
          parentId: e.parentId ?? null,
          role: e.role,
          subtaskId: e.subtaskId ?? null,
          modelId: e.modelId,
          provider: e.provider,
          prompt: e.prompt ?? "",
          startedAt: e.ts,
        });
      }
      break;
    }

    case "agent_call_end": {
      const n = node(e.nodeId);
      if (n) {
        n.promptTokens = e.promptTokens ?? 0;
        n.completionTokens = e.completionTokens ?? 0;
        n.costUsd = e.costUsd ?? 0;
        n.latencyMs = e.latencyMs ?? 0;
        n.output = e.output ?? "";
        n.error = e.error;
        n.finishedAt = e.ts;
      }
      break;
    }

    case "thought": {
      const n = node(e.nodeId);
      if (n) n.thoughts = [...n.thoughts, e.text];
      break;
    }

    case "tool_call": {
      const n = node(e.nodeId);
      if (n) {
        n.toolCalls = [
          ...n.toolCalls,
          {
            callId: e.callId,
            name: e.name,
            args: e.args ?? {},
            sideEffecting: !!e.sideEffecting,
          },
        ];
      }
      break;
    }

    case "tool_result": {
      const n = node(e.nodeId);
      const tc = n?.toolCalls.find((t) => t.callId === e.callId);
      if (n && tc) {
        n.toolCalls = n.toolCalls.map((t) =>
          t.callId === e.callId
            ? { ...t, result: e.result, outcome: e.outcome, ms: e.ms }
            : t,
        );
      }
      break;
    }

    case "context_snapshot": {
      const n = node(e.nodeId);
      if (n) {
        n.contextItems = e.items ?? [];
        n.contextTotalTokens = e.totalTokens ?? 0;
      }
      break;
    }

    case "approval_request":
      v.approvals = [...v.approvals, { ...e.request, status: "pending" }];
      break;

    case "approval_resolved":
      v.approvals = v.approvals.map((a) =>
        a.requestId === e.requestId
          ? {
              ...a,
              status: e.approved ? "approved" : "rejected",
              acceptedBlockIds: e.acceptedBlockIds,
            }
          : a,
      );
      break;

    case "file_change":
      v.fileChanges = [
        ...v.fileChanges,
        { changeId: e.changeId, path: e.path, ts: e.ts },
      ];
      break;

    case "workspace_reverted":
      v.fileChanges = v.fileChanges.map((change) =>
        change.changeId === e.changeId ? { ...change, revertedAt: e.ts } : change,
      );
      break;

    case "compaction":
      v.compactions = [
        ...v.compactions,
        {
          ts: e.ts,
          beforeTokens: e.beforeTokens,
          afterTokens: e.afterTokens,
          summarized: e.summarized,
          preserved: e.preserved ?? [],
        },
      ];
      break;

    case "budget_update":
      v.budget = {
        costUsd: e.costUsd,
        elapsedSeconds: e.elapsedSeconds,
        maxCostUsd: e.maxCostUsd,
        maxSeconds: e.maxSeconds,
        promptTokens: e.promptTokens,
        completionTokens: e.completionTokens,
      };
      break;

    case "intervention":
      v.interventions = [
        ...v.interventions,
        {
          ts: e.ts,
          subtaskId: e.subtaskId ?? null,
          cause: e.cause,
          detail: e.detail,
          action: e.action,
        },
      ];
      break;

    case "checkpoint":
      v.lastCheckpointStep = e.step;
      for (const st of e.subtaskStates ?? []) {
        const s = v.subtasks.find((x) => x.id === st.id);
        if (s && s.status !== st.status) {
          v.subtasks[v.subtasks.indexOf(s)] = { ...s, status: st.status };
        }
      }
      break;

    case "task_finished":
      v.status = "done";
      v.summary = e.summary;
      break;

    case "task_failed":
      v.status = "failed";
      v.failureReason = e.reason;
      break;

    case "task_cancelled":
      v.status = "cancelled";
      break;

    case "log":
      v.logs = [
        ...v.logs,
        { ts: e.ts, level: e.level, message: e.message },
      ].slice(-200);
      break;
  }

  return v;
}

export function buildTrace(events: TraceEvent[]): TraceView {
  return events.reduce(applyEvent, emptyTrace());
}

/** Nodes grouped under their subtask, in call order — the call hierarchy. */
export function groupNodesBySubtask(
  view: TraceView,
): { subtask: SubtaskView | null; nodes: TraceNode[] }[] {
  const groups: { subtask: SubtaskView | null; nodes: TraceNode[] }[] = [];
  const orphans = view.nodes.filter((n) => !n.subtaskId);
  if (orphans.length) groups.push({ subtask: null, nodes: orphans });
  for (const s of view.subtasks) {
    groups.push({
      subtask: s,
      nodes: view.nodes.filter((n) => n.subtaskId === s.id),
    });
  }
  return groups;
}

export function formatUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(3)}`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * ============================================================================
 *  CALL TREE — turning the flat node list into the hierarchy it always was
 * ============================================================================
 * Every node carries a `parentId` naming the call that caused it: the planner
 * is the root, a verifier hangs off the implementer whose claim it judges, a
 * retry hangs off the verifier that rejected the previous attempt. Read
 * top-down that spells out WHY the task did what it did — something a list
 * ordered by timestamp cannot express, because in a flat list "attempt 2" and
 * "the verifier that forced attempt 2" are just two adjacent rows.
 *
 * THE RESULT IS ALWAYS A FOREST, WHATEVER THE INPUT. The renderer recurses
 * over `children`, so a single cycle or dangling parent would hang the UI, and
 * both are reachable in practice rather than theoretical:
 *   - a dangling parent is normal — replaying a truncated events.jsonl, or
 *     rendering one subtask's nodes in isolation, both leave children whose
 *     parent is not in the set;
 *   - a cycle should be impossible, but "should be impossible" is a poor
 *     reason to let the dashboard freeze on the one run that matters.
 * So an unresolvable parent (missing, self-referential, or on a cyclic chain)
 * is treated as no parent, and the node surfaces as a root instead of
 * vanishing. Nothing is ever dropped: every input node appears exactly once.
 */

export type CallTreeNode = {
  node: TraceNode;
  children: CallTreeNode[];
  /** 0 for a root; only used for display. */
  depth: number;
};

export function buildCallTree(nodes: TraceNode[]): CallTreeNode[] {
  const wrapped = new Map<string, CallTreeNode>();
  for (const node of nodes) wrapped.set(node.nodeId, { node, children: [], depth: 0 });

  // Resolve each node's EFFECTIVE parent first, before linking anything, so
  // the link step cannot build a structure the renderer can't walk.
  const parentOf = new Map<string, string | null>();
  for (const node of nodes) {
    let parent: string | null = node.parentId;
    if (parent === node.nodeId) parent = null;
    if (parent != null && !wrapped.has(parent)) parent = null;

    if (parent != null) {
      // Walk the ancestor chain. Revisiting anything means a cycle — including
      // one that does not contain this node — so detach and let it be a root.
      const seen = new Set<string>([node.nodeId]);
      let cursor: string | null = parent;
      while (cursor != null) {
        if (seen.has(cursor)) {
          parent = null;
          break;
        }
        seen.add(cursor);
        const up: string | null = wrapped.get(cursor)!.node.parentId;
        cursor = up != null && wrapped.has(up) ? up : null;
      }
    }
    parentOf.set(node.nodeId, parent);
  }

  const roots: CallTreeNode[] = [];
  for (const node of nodes) {
    const self = wrapped.get(node.nodeId)!;
    const parent = parentOf.get(node.nodeId) ?? null;
    if (parent == null) roots.push(self);
    else wrapped.get(parent)!.children.push(self);
  }

  const assignDepth = (item: CallTreeNode, depth: number): void => {
    item.depth = depth;
    for (const child of item.children) assignDepth(child, depth + 1);
  };
  for (const root of roots) assignDepth(root, 0);

  return roots;
}

/** Rolled-up cost of a node and everything it caused — the number that makes a
 *  collapsed branch honest about what it is hiding. */
export function subtreeTotals(item: CallTreeNode): {
  calls: number;
  costUsd: number;
  tokens: number;
} {
  let calls = 1;
  let costUsd = item.node.costUsd;
  let tokens = item.node.promptTokens + item.node.completionTokens;
  for (const child of item.children) {
    const sub = subtreeTotals(child);
    calls += sub.calls;
    costUsd += sub.costUsd;
    tokens += sub.tokens;
  }
  return { calls, costUsd, tokens };
}

/** Deepest level in a forest, 1-based. Used to label the view ("4 levels deep"). */
export function treeDepth(roots: CallTreeNode[]): number {
  let max = 0;
  const walk = (item: CallTreeNode): void => {
    max = Math.max(max, item.depth + 1);
    for (const child of item.children) walk(child);
  };
  for (const root of roots) walk(root);
  return max;
}
