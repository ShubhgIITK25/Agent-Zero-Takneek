'use client';

/**
 * OBSERVABILITY DASHBOARD
 *
 * Renders the orchestrator's trace. Live and post-hoc are the SAME component
 * over the SAME reducer (src/lib/trace.ts) — live mode folds events as they
 * arrive over IPC, history mode folds events read back from events.jsonl.
 * There is no second rendering path, which is why there are no gaps between
 * the two modes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  TraceView,
  TraceNode,
  CallTreeNode,
  groupNodesBySubtask,
  buildCallTree,
  subtreeTotals,
  treeDepth,
  formatUsd,
  formatMs,
  buildTrace,
  TraceEvent,
  ExecutionGraphNode,
  FileChangeView,
} from '../lib/trace';

type DashboardProps = {
  live: TraceView;
  onClose: () => void;
  onWorkspaceChanged?: () => void;
};

type TaskSummary = { taskId: string; prompt: string; status: string; updatedAt: number; step: number };

const ROLE_LABEL: Record<string, string> = {
  planner: 'Planner',
  implementer: 'Implementer',
  verifier: 'Verifier',
  tiebreak: 'Tie-break',
  compactor: 'Compactor',
  pending: 'Routing…',
};

function Meter({ label, value, max, unit }: { label: string; value: number; max: number; unit: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const level = pct > 85 ? 'danger' : pct > 60 ? 'warn' : 'ok';
  return (
    <div className="dash-meter">
      <div className="dash-meter-head">
        <span>{label}</span>
        <span className="dash-meter-value">
          {unit === '$' ? formatUsd(value) : `${Math.round(value)}s`} / {unit === '$' ? `$${max}` : `${max}s`}
        </span>
      </div>
      <div className="dash-meter-track">
        <div className={`dash-meter-fill dash-meter-${level}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function NodeCard({ node, subtaskTitle }: { node: TraceNode; subtaskTitle?: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'io' | 'context' | 'routing' | 'tools'>('io');
  const running = !node.finishedAt;

  return (
    <div className={`dash-node${running ? ' dash-node-running' : ''}${node.error ? ' dash-node-error' : ''}`}>
      <button type="button" className="dash-node-head" onClick={() => setOpen((o) => !o)}>
        <span className="dash-node-caret">{open ? '▾' : '▸'}</span>
        <span className={`dash-role dash-role-${node.role}`}>{ROLE_LABEL[node.role] ?? node.role}</span>
        {/* In the full tree a call's subtask is no longer implied by the group
            it sits in, so it has to be stated on the row itself. */}
        {subtaskTitle && (
          <span className="dash-node-subtask" title={subtaskTitle}>
            {subtaskTitle}
          </span>
        )}
        <span className="dash-node-model" title={`${node.provider} / ${node.modelId}`}>
          {node.modelId}
        </span>
        <span className="dash-node-metrics">
          {running ? (
            <span className="dash-live-dot">running</span>
          ) : (
            <>
              <span title="prompt + completion tokens">
                {node.promptTokens}→{node.completionTokens} tok
              </span>
              <span title="cost of this call">{formatUsd(node.costUsd)}</span>
              <span title="latency">{formatMs(node.latencyMs)}</span>
            </>
          )}
        </span>
      </button>

      {node.error && <div className="dash-node-errmsg">{node.error}</div>}

      {open && (
        <div className="dash-node-body">
          <div className="dash-tabs">
            {(['io', 'context', 'routing', 'tools'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`dash-tab${tab === t ? ' active' : ''}`}
                onClick={() => setTab(t)}
              >
                {t === 'io' ? 'Input / Output' : t === 'context' ? `Context (${node.contextItems.length})` : t === 'routing' ? 'Routing' : `Tools (${node.toolCalls.length})`}
              </button>
            ))}
          </div>

          {tab === 'io' && (
            <div className="dash-io">
              <div className="dash-io-label">Exact prompt sent</div>
              <pre className="dash-pre">{node.prompt || '(none)'}</pre>
              <div className="dash-io-label">Exact response received</div>
              <pre className="dash-pre">{node.output ?? (running ? '(in flight)' : '(empty)')}</pre>
              {node.thoughts.length > 0 && (
                <>
                  <div className="dash-io-label">Thought stream</div>
                  {node.thoughts.map((t, i) => (
                    <pre key={i} className="dash-pre dash-thought">
                      {t}
                    </pre>
                  ))}
                </>
              )}
            </div>
          )}

          {tab === 'context' && (
            <div className="dash-context">
              {node.contextItems.length === 0 ? (
                <p className="dash-muted">No retrieval items recorded for this call.</p>
              ) : (
                <>
                  <div className="dash-io-label">
                    Files and chunks in this agent&apos;s context — {node.contextTotalTokens} tokens total
                  </div>
                  <table className="dash-table">
                    <thead>
                      <tr>
                        <th>Path</th>
                        <th>Lines</th>
                        <th>Tokens</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {node.contextItems.map((c, i) => (
                        <tr key={i}>
                          <td className="dash-mono">{c.path}</td>
                          <td className="dash-mono">{c.lines ?? '—'}</td>
                          <td className="dash-num">{c.tokens}</td>
                          <td>{c.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}

          {tab === 'routing' && (
            <div className="dash-routing">
              {node.routing ? (
                <>
                  <div className="dash-io-label">Why this model</div>
                  <p className="dash-reason">{node.routing.reason}</p>
                  <div className="dash-io-label">Signals at decision time</div>
                  <table className="dash-table">
                    <tbody>
                      {Object.entries(node.routing.signals).map(([k, val]) => (
                        <tr key={k}>
                          <td className="dash-mono">{k}</td>
                          <td className="dash-mono">{Array.isArray(val) ? val.join(', ') || '(none)' : String(val)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {node.routing.rejected.length > 0 && (
                    <>
                      <div className="dash-io-label">Rejected candidates</div>
                      <table className="dash-table">
                        <tbody>
                          {node.routing.rejected.map((r, i) => (
                            <tr key={i}>
                              <td className="dash-mono">{r.modelId}</td>
                              <td className="dash-muted">{r.why}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </>
              ) : (
                <p className="dash-muted">No routing record for this node.</p>
              )}
            </div>
          )}

          {tab === 'tools' && (
            <div className="dash-tools">
              {node.toolCalls.length === 0 ? (
                <p className="dash-muted">No tool calls in this step.</p>
              ) : (
                node.toolCalls.map((t) => (
                  <div key={t.callId} className={`dash-tool dash-tool-${t.outcome ?? 'running'}`}>
                    <div className="dash-tool-head">
                      <span className="dash-mono">{t.name}</span>
                      {t.sideEffecting && <span className="dash-badge dash-badge-gate">approval-gated</span>}
                      <span className="dash-tool-outcome">{t.outcome ?? 'running'}</span>
                      {t.ms != null && <span className="dash-muted">{formatMs(t.ms)}</span>}
                    </div>
                    <pre className="dash-pre dash-pre-sm">{JSON.stringify(t.args, null, 2)}</pre>
                    {t.result && <pre className="dash-pre dash-pre-sm dash-tool-result">{t.result}</pre>}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExecutionGraph({
  nodes,
  fileChanges,
  onRevertLatest,
  reverting,
  revertMessage,
}: {
  nodes: ExecutionGraphNode[];
  fileChanges: FileChangeView[];
  onRevertLatest: () => void;
  reverting: boolean;
  revertMessage: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => nodes[nodes.length - 1]?.id ?? null);
  const visible = nodes.slice(-180);
  const selected = nodes.find((node) => node.id === selectedId) ?? nodes[nodes.length - 1] ?? null;
  const latestChange = [...fileChanges].reverse().find((change) => !change.revertedAt);

  useEffect(() => {
    if (nodes.length === 0) {
      setSelectedId(null);
      return;
    }

    if (!selectedId) {
      setSelectedId(nodes[nodes.length - 1].id);
    }
  }, [nodes, selectedId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || nodes.length === 0) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      el.scrollLeft = el.scrollWidth;
    });

    return () => cancelAnimationFrame(frame);
  }, [nodes.length, visible.length]);

  return (
    <section className="dash-section">
      <div className="dash-graph-heading">
        <div>
          <h3>Execution graph ({nodes.length} events)</h3>
          <p className="dash-muted dash-section-note">
            Every thought, model call, tool call, approval, checkpoint, and controlled file change is kept in causal order.
          </p>
        </div>
        {latestChange && (
          <button type="button" className="dash-revert" onClick={onRevertLatest} disabled={reverting}>
            {reverting ? 'Reverting…' : `Revert latest · ${latestChange.path}`}
          </button>
        )}
      </div>
      {revertMessage && <p className="dash-graph-message" role="status">{revertMessage}</p>}
      {nodes.length === 0 ? (
        <p className="dash-muted">No execution events yet.</p>
      ) : (
        <>
          <div ref={scrollRef} className="dash-graph-scroll">
            <div className="dash-graph-track">
              {visible.map((node, index) => (
                <div className="dash-graph-entry" key={node.id}>
                  <button
                    type="button"
                    className={`dash-graph-node dash-graph-node-${node.kind}${selectedId === node.id ? ' active' : ''}`}
                    onClick={() => setSelectedId((current) => current === node.id ? null : node.id)}
                    title={node.detail}
                  >
                    <span className="dash-graph-seq">#{node.seq}</span>
                    <strong>{node.label}</strong>
                    <span className="dash-graph-time">{new Date(node.ts).toLocaleTimeString()}</span>
                  </button>
                  {index < visible.length - 1 && <span className="dash-graph-edge" aria-hidden="true">→</span>}
                </div>
              ))}
            </div>
          </div>
          {visible.length < nodes.length && (
            <p className="dash-muted dash-graph-truncated">Showing the latest {visible.length} events; the full trace remains available in Past tasks.</p>
          )}
          {selected && (
            <div className="dash-graph-detail">
              <div className="dash-io-label">Event #{selected.seq} · {selected.type}</div>
              <pre className="dash-pre dash-pre-sm">{selected.detail || '(no detail)'}</pre>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * One node and everything it caused. Children nest inside a bordered rail
 * rather than being indented by a computed depth*N padding: the rail draws
 * itself, and a deep chain (three attempts, each with a verifier and a
 * tie-break, is ~9 levels) stays readable instead of marching off the right
 * edge. Collapsing a branch reports the calls and cost it is hiding, so a
 * folded subtree can never quietly account for most of the bill.
 */
/**
 * SWIMLANES — one bar per subtask on a shared time axis.
 *
 * A list of subtasks with statuses cannot answer "did these actually run at
 * the same time"; only a shared axis can, because overlap is a geometric fact
 * rather than a claim. Bars that start at the same x and run side by side ARE
 * the evidence of parallelism, which is why this is drawn from recorded
 * start/finish timestamps rather than from the concurrency counter alone.
 *
 * Everything is laid out in percentages of the task's own wall-clock span, so
 * it needs no measurement pass and reflows with the panel.
 */
function ParallelTimeline({ view }: { view: TraceView }) {
  const ran = view.subtasks.filter((s) => s.startedAt != null);
  if (ran.length === 0) return null;

  const starts = ran.map((s) => s.startedAt as number);
  const ends = ran.map((s) => s.finishedAt ?? Date.now());
  const t0 = Math.min(...starts);
  const t1 = Math.max(...ends, t0 + 1);
  const span = Math.max(1, t1 - t0);

  const live = view.concurrency.length
    ? view.concurrency[view.concurrency.length - 1].running.length
    : 0;

  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <h3>Parallel execution</h3>
        <div className="dash-viewtoggle">
          {live > 0 && (
            <span className="dash-par-live">
              {live} agent{live === 1 ? '' : 's'} running now
            </span>
          )}
          <span className="dash-muted">
            peak {view.peakParallel} of {view.maxParallel} slot{view.maxParallel === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {view.peakParallel <= 1 ? (
        <p className="dash-muted dash-pad">
          {view.maxParallel <= 1
            ? 'Running one subtask at a time (parallelism is set to 1 in Settings).'
            : 'No two subtasks were ready at the same time, so nothing overlapped — the plan is a dependency chain.'}
        </p>
      ) : (
        <p className="dash-muted dash-pad">
          {view.peakParallel} subtasks ran at the same time. Bars that overlap horizontally ran concurrently.
        </p>
      )}

      <div className="dash-lanes">
        {ran.map((s) => {
          const start = s.startedAt as number;
          const end = s.finishedAt ?? Date.now();
          const left = ((start - t0) / span) * 100;
          const width = Math.max(1.5, ((end - start) / span) * 100);
          const secs = Math.round((end - start) / 100) / 10;
          return (
            <div key={s.id} className="dash-lane">
              <span className="dash-lane-label" title={s.title}>
                {s.title}
              </span>
              <div className="dash-lane-track">
                <div
                  className={`dash-lane-bar dash-lane-${s.status}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${s.title} — ${s.status}, ${secs}s`}
                >
                  <span className="dash-lane-bar-text">{secs}s</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CallTreeBranch({
  item,
  subtaskTitleById,
}: {
  item: CallTreeNode;
  subtaskTitleById: Map<string, string>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const kids = item.children;
  const totals = kids.length > 0 ? subtreeTotals(item) : null;
  const hiddenCalls = totals ? totals.calls - 1 : 0;
  const hiddenCost = totals ? totals.costUsd - item.node.costUsd : 0;

  return (
    <div className="dash-branch">
      <div className="dash-branch-row">
        <button
          type="button"
          className={`dash-branch-toggle${kids.length === 0 ? ' dash-branch-leaf' : ''}`}
          onClick={() => kids.length > 0 && setCollapsed((c) => !c)}
          disabled={kids.length === 0}
          title={
            kids.length === 0
              ? 'This call caused no further calls'
              : collapsed
                ? `Show ${hiddenCalls} call(s) this one caused`
                : 'Collapse'
          }
          aria-label={kids.length === 0 ? 'Leaf call' : collapsed ? 'Expand branch' : 'Collapse branch'}
        >
          {kids.length === 0 ? '·' : collapsed ? '▸' : '▾'}
        </button>
        <div className="dash-branch-node">
          <NodeCard
            node={item.node}
            subtaskTitle={item.node.subtaskId ? subtaskTitleById.get(item.node.subtaskId) : undefined}
          />
        </div>
      </div>

      {kids.length > 0 &&
        (collapsed ? (
          <div className="dash-branch-children dash-branch-folded">
            <button type="button" className="dash-branch-foldnote" onClick={() => setCollapsed(false)}>
              {hiddenCalls} nested call{hiddenCalls === 1 ? '' : 's'} hidden · {formatUsd(hiddenCost)}
            </button>
          </div>
        ) : (
          <div className="dash-branch-children">
            {kids.map((child) => (
              <CallTreeBranch key={child.node.nodeId} item={child} subtaskTitleById={subtaskTitleById} />
            ))}
          </div>
        ))}
    </div>
  );
}

export default function Dashboard({ live, onClose, onWorkspaceChanged }: DashboardProps) {
  const [mode, setMode] = useState<'live' | 'history'>('live');
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [historyTrace, setHistoryTrace] = useState<TraceView | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertMessage, setRevertMessage] = useState<string | null>(null);
  // 'tree' is the default: it is the only view that shows the whole causal
  // chain, including the planner -> subtask and verifier -> retry edges that
  // cross subtask boundaries and are therefore invisible when grouping.
  const [hierarchyView, setHierarchyView] = useState<'tree' | 'subtask'>('tree');

  useEffect(() => {
    if (mode !== 'history') return;
    (async () => {
      const list = await window.electronAPI?.orchestratorListTasks();
      setTasks(
        (list ?? []).map((t: any) => ({
          taskId: t.taskId,
          prompt: t.prompt,
          status: t.status,
          updatedAt: t.updatedAt,
          step: t.step,
        }))
      );
    })();
  }, [mode]);

  const loadTask = async (taskId: string) => {
    setLoadingHistory(true);
    setRevertMessage(null);
    const events: TraceEvent[] = (await window.electronAPI?.orchestratorReadTaskEvents(taskId)) ?? [];
    setHistoryTrace(buildTrace(events));
    setLoadingHistory(false);
  };

  const view = mode === 'live' ? live : historyTrace;
  const groups = useMemo(() => (view ? groupNodesBySubtask(view) : []), [view]);
  const fullTree = useMemo(() => (view ? buildCallTree(view.nodes) : []), [view]);
  const maxDepth = useMemo(() => treeDepth(fullTree), [fullTree]);
  const subtaskTitleById = useMemo(
    () => new Map((view?.subtasks ?? []).map((s) => [s.id, s.title])),
    [view]
  );

  const totals = useMemo(() => {
    if (!view) return { calls: 0, tokens: 0, cost: 0 };
    return {
      calls: view.nodes.length,
      tokens: view.nodes.reduce((a, n) => a + n.promptTokens + n.completionTokens, 0),
      cost: view.nodes.reduce((a, n) => a + n.costUsd, 0),
    };
  }, [view]);

  const revertLatest = async () => {
    if (!view?.taskId || reverting) return;
    const latest = [...view.fileChanges].reverse().find((change) => !change.revertedAt);
    if (!latest) return;
    if (!window.confirm(`Revert the latest tracked change to ${latest.path}?`)) return;

    setReverting(true);
    setRevertMessage(null);
    try {
      const result = await window.electronAPI?.orchestratorRevertLatest(view.taskId);
      if (!result) throw new Error('The workspace could not be reverted.');
      onWorkspaceChanged?.();
      if (mode === 'history') await loadTask(view.taskId);
      setRevertMessage(`Reverted ${result.path}.`);
    } catch (err) {
      setRevertMessage(err instanceof Error ? err.message : 'The workspace could not be reverted.');
    } finally {
      setReverting(false);
    }
  };

  return (
    <div className="dashboard-overlay" role="dialog" aria-label="Observability dashboard">
      <div className="dashboard">
        <header className="dash-header">
          <div className="dash-header-left">
            <h2>Observability</h2>
            <div className="dash-mode">
              <button
                type="button"
                className={`dash-mode-btn${mode === 'live' ? ' active' : ''}`}
                onClick={() => setMode('live')}
              >
                Live
              </button>
              <button
                type="button"
                className={`dash-mode-btn${mode === 'history' ? ' active' : ''}`}
                onClick={() => setMode('history')}
              >
                Past tasks
              </button>
            </div>
          </div>
          <button type="button" className="dash-close" onClick={onClose} aria-label="Close dashboard">
            ×
          </button>
        </header>

        {mode === 'history' && (
          <div className="dash-history-picker">
            {tasks.length === 0 ? (
              <p className="dash-muted">No completed tasks recorded for this project yet.</p>
            ) : (
              <select
                onChange={(e) => e.target.value && loadTask(e.target.value)}
                defaultValue=""
                aria-label="Select a past task"
              >
                <option value="" disabled>
                  Select a task…
                </option>
                {tasks.map((t) => (
                  <option key={t.taskId} value={t.taskId}>
                    [{t.status}] {new Date(t.updatedAt).toLocaleString()} — {t.prompt.slice(0, 60)}
                  </option>
                ))}
              </select>
            )}
            {loadingHistory && <span className="dash-muted">Loading…</span>}
          </div>
        )}

        {!view || (mode === 'live' && view.status === 'idle') ? (
          <div className="dash-empty">
            <p>No task is running.</p>
            <p className="dash-muted">
              Send a request in the AI Agent panel and the full trace — routing, agent calls, tool use, context,
              tokens and cost — appears here as it happens.
            </p>
          </div>
        ) : (
          <div className="dash-body">
            {/* ---- summary strip ---- */}
            <section className="dash-summary">
              <div className="dash-summary-main">
                <div className="dash-status-row">
                  <span className={`dash-status dash-status-${view.status}`}>{view.status}</span>
                  {view.planShortCircuited && (
                    <span className="dash-badge" title="The planner judged this simple enough to skip full decomposition">
                      short-circuited
                    </span>
                  )}
                  {view.resumeNote && <span className="dash-badge dash-badge-resume">{view.resumeNote}</span>}
                  <span className="dash-muted">checkpoint step {view.lastCheckpointStep}</span>
                </div>
                <p className="dash-prompt">{view.prompt}</p>
                {view.summary && <p className="dash-final-summary">{view.summary}</p>}
                {view.failureReason && <p className="dash-fail">{view.failureReason}</p>}
              </div>
              <div className="dash-summary-meters">
                <Meter label="Cost" value={view.budget.costUsd} max={view.budget.maxCostUsd} unit="$" />
                <Meter label="Wall clock" value={view.budget.elapsedSeconds} max={view.budget.maxSeconds} unit="s" />
                <div className="dash-totals">
                  <span>{totals.calls} calls</span>
                  <span>{totals.tokens.toLocaleString()} tokens</span>
                  <span>{formatUsd(totals.cost)}</span>
                </div>
              </div>
            </section>

            <ExecutionGraph
              nodes={view.executionGraph}
              fileChanges={view.fileChanges}
              onRevertLatest={() => void revertLatest()}
              reverting={reverting}
              revertMessage={revertMessage}
            />

            {/* ---- interventions ---- */}
            {view.interventions.length > 0 && (
              <section className="dash-section">
                <h3>Interventions ({view.interventions.length})</h3>
                <p className="dash-muted dash-section-note">
                  Every cap, failover and disagreement the orchestrator acted on. Nothing here happens silently.
                </p>
                {view.interventions.map((iv, i) => (
                  <div key={i} className={`dash-intervention dash-cause-${iv.cause}`}>
                    <div className="dash-intervention-head">
                      <span className="dash-badge dash-badge-cause">{iv.cause.replace(/_/g, ' ')}</span>
                      {iv.subtaskId && <span className="dash-mono dash-muted">{iv.subtaskId}</span>}
                    </div>
                    <div className="dash-intervention-detail">{iv.detail}</div>
                    <div className="dash-intervention-action">→ {iv.action}</div>
                  </div>
                ))}
              </section>
            )}

            {/* ---- compaction ---- */}
            {view.compactions.length > 0 && (
              <section className="dash-section">
                <h3>Compaction events ({view.compactions.length})</h3>
                {view.compactions.map((c, i) => (
                  <div key={i} className="dash-compaction">
                    <div>
                      <strong>{c.beforeTokens.toLocaleString()}</strong> → <strong>{c.afterTokens.toLocaleString()}</strong> tokens
                      <span className="dash-muted"> ({c.summarized} messages summarised)</span>
                    </div>
                    {c.preserved.length > 0 && (
                      <details className="dash-preserved">
                        <summary>{c.preserved.length} facts preserved verbatim</summary>
                        <ul>
                          {c.preserved.map((p, j) => (
                            <li key={j}>{p}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                ))}
              </section>
            )}

            <ParallelTimeline view={view} />

            {/* ---- call hierarchy ---- */}
            <section className="dash-section">
              <div className="dash-section-head">
                <h3>Call hierarchy</h3>
                <div className="dash-viewtoggle">
                  <span className="dash-muted">
                    {fullTree.length} root{fullTree.length === 1 ? '' : 's'} · {maxDepth} level
                    {maxDepth === 1 ? '' : 's'} deep
                  </span>
                  <button
                    type="button"
                    className={`dash-viewbtn${hierarchyView === 'tree' ? ' active' : ''}`}
                    onClick={() => setHierarchyView('tree')}
                  >
                    Full tree
                  </button>
                  <button
                    type="button"
                    className={`dash-viewbtn${hierarchyView === 'subtask' ? ' active' : ''}`}
                    onClick={() => setHierarchyView('subtask')}
                  >
                    By subtask
                  </button>
                </div>
              </div>

              {hierarchyView === 'tree' ? (
                <div className="dash-tree">
                  {fullTree.length === 0 ? (
                    <p className="dash-muted dash-pad">No model calls yet.</p>
                  ) : (
                    fullTree.map((t) => (
                      <CallTreeBranch key={t.node.nodeId} item={t} subtaskTitleById={subtaskTitleById} />
                    ))
                  )}
                </div>
              ) : (
              groups.map((g, i) => (
                <div key={g.subtask?.id ?? `orphan-${i}`} className="dash-group">
                  <div className="dash-group-head">
                    {g.subtask ? (
                      <>
                        <span className={`dash-substatus dash-substatus-${g.subtask.status}`}>{g.subtask.status}</span>
                        <span className="dash-group-title">{g.subtask.title}</span>
                        <span className="dash-badge dash-badge-cat">{g.subtask.category}</span>
                        {g.subtask.attempts > 1 && (
                          <span className="dash-badge dash-badge-retry">attempt {g.subtask.attempts}</span>
                        )}
                        {g.subtask.replacedSubtaskId && (
                          <span
                            className="dash-badge dash-badge-replan"
                            title={`Created by a re-plan after ${g.subtask.replacedSubtaskId} failed every retry`}
                          >
                            re-plan of {g.subtask.replacedSubtaskId}
                          </span>
                        )}
                        {g.subtask.dependsOn.length > 0 && (
                          <span className="dash-muted">after {g.subtask.dependsOn.join(', ')}</span>
                        )}
                      </>
                    ) : (
                      <span className="dash-group-title">Task-level calls (planning, aggregation)</span>
                    )}
                  </div>
                  {g.subtask?.note && <div className="dash-group-note">{g.subtask.note}</div>}
                  <div className="dash-group-nodes">
                    {g.nodes.length === 0 ? (
                      <p className="dash-muted dash-pad">Not started.</p>
                    ) : (
                      // Within a group the parent of the first call usually
                      // lives in ANOTHER group (the planner), so those nodes
                      // surface as roots here. That is the point of the group
                      // view; the cross-subtask edges are what 'Full tree' is for.
                      buildCallTree(g.nodes).map((t) => (
                        <CallTreeBranch key={t.node.nodeId} item={t} subtaskTitleById={subtaskTitleById} />
                      ))
                    )}
                  </div>
                </div>
              ))
              )}
            </section>

            {/* ---- approvals ---- */}
            {view.approvals.length > 0 && (
              <section className="dash-section">
                <h3>Approval history</h3>
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>Kind</th>
                      <th>Summary</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.approvals.map((a) => (
                      <tr key={a.requestId}>
                        <td>{a.kind}</td>
                        <td>{a.summary}</td>
                        <td>
                          <span className={`dash-badge dash-badge-${a.status}`}>{a.status}</span>
                          {a.status === 'approved' && a.acceptedBlockIds && a.kind === 'diff' && (
                            <span className="dash-muted"> {a.acceptedBlockIds.length} block(s)</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
