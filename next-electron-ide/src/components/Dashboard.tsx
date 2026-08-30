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

import { useEffect, useMemo, useState } from 'react';
import {
  TraceView,
  TraceNode,
  groupNodesBySubtask,
  formatUsd,
  formatMs,
  buildTrace,
  TraceEvent,
} from '../lib/trace';

type DashboardProps = {
  live: TraceView;
  onClose: () => void;
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

function NodeCard({ node }: { node: TraceNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'io' | 'context' | 'routing' | 'tools'>('io');
  const running = !node.finishedAt;

  return (
    <div className={`dash-node${running ? ' dash-node-running' : ''}${node.error ? ' dash-node-error' : ''}`}>
      <button type="button" className="dash-node-head" onClick={() => setOpen((o) => !o)}>
        <span className="dash-node-caret">{open ? '▾' : '▸'}</span>
        <span className={`dash-role dash-role-${node.role}`}>{ROLE_LABEL[node.role] ?? node.role}</span>
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

export default function Dashboard({ live, onClose }: DashboardProps) {
  const [mode, setMode] = useState<'live' | 'history'>('live');
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [historyTrace, setHistoryTrace] = useState<TraceView | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

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
    const events: TraceEvent[] = (await window.electronAPI?.orchestratorReadTaskEvents(taskId)) ?? [];
    setHistoryTrace(buildTrace(events));
    setLoadingHistory(false);
  };

  const view = mode === 'live' ? live : historyTrace;
  const groups = useMemo(() => (view ? groupNodesBySubtask(view) : []), [view]);

  const totals = useMemo(() => {
    if (!view) return { calls: 0, tokens: 0, cost: 0 };
    return {
      calls: view.nodes.length,
      tokens: view.nodes.reduce((a, n) => a + n.promptTokens + n.completionTokens, 0),
      cost: view.nodes.reduce((a, n) => a + n.costUsd, 0),
    };
  }, [view]);

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

            {/* ---- call hierarchy ---- */}
            <section className="dash-section">
              <h3>Call hierarchy</h3>
              {groups.map((g, i) => (
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
                      g.nodes.map((n) => <NodeCard key={n.nodeId} node={n} />)
                    )}
                  </div>
                </div>
              ))}
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
