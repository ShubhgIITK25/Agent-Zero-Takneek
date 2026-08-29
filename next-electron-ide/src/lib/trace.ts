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

export type SubtaskView = {
  id: string;
  title: string;
  detail: string;
  category: string;
  dependsOn: string[];
  status: string;
  attempts: number;
  note?: string;
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
  nodes: TraceNode[];
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
    nodes: [],
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
  };
}

/** Applies one event. Pure — returns a new view, never mutates the input. */
export function applyEvent(view: TraceView, e: TraceEvent): TraceView {
  const v: TraceView = {
    ...view,
    subtasks: [...view.subtasks],
    nodes: [...view.nodes],
    interventions: [...view.interventions],
    compactions: [...view.compactions],
    approvals: [...view.approvals],
    logs: [...view.logs],
  };
  if (e.taskId) v.taskId = e.taskId;

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

    case "subtask_started": {
      const s = v.subtasks.find((x) => x.id === e.subtaskId);
      if (s) {
        const i = v.subtasks.indexOf(s);
        v.subtasks[i] = { ...s, status: "running", attempts: e.attempt };
      }
      break;
    }

    case "subtask_finished": {
      const s = v.subtasks.find((x) => x.id === e.subtaskId);
      if (s) {
        const i = v.subtasks.indexOf(s);
        v.subtasks[i] = { ...s, status: e.status, note: e.note };
      }
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
