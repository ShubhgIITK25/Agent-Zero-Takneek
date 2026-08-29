'use client';

/**
 * AGENT PANEL — drives the orchestrator and renders its stream.
 *
 * Three things live here beyond plain chat:
 *
 * MANUAL CONTEXT CONTROL. Files and line ranges the user pins are read at
 * send time and injected into the prompt as an explicit, labelled block. They
 * are listed as removable chips, so "what the agent can see" is always visible
 * and always editable. `@path` and `@path:12-40` typed in the input box are
 * parsed into the same chips.
 *
 * CLICKABLE TAGGING BOTH WAYS. The input box turns `@path:lines` into a pin;
 * the output chat turns any `path:line` or `path:line-line` the agent mentions
 * into a link that opens that file at that line. Both directions, which is
 * what the requirement actually asks for.
 *
 * APPROVALS. A side-effecting tool call suspends the orchestrator until it is
 * answered. Commands are approved here inline. File edits are NOT: they open
 * in the editor pane as a real Monaco diff with per-hunk Keep/Deny, and this
 * panel shows a pointer card that resolves itself off `approval_resolved`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileDiffView } from './DiffReview';
import { TraceView, TraceEvent, applyEvent, emptyTrace, formatUsd } from '../lib/trace';

type ChatPanelProps = {
  rootPath: string | null;
  activeFilePath: string | null;
  activeFileContent: string | null;
  trace: TraceView;
  onTraceEvent: (e: TraceEvent) => void;
  onClearTrace?: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenDashboard: () => void;
  onRunCommand: (command: string) => void;
  onFileChanged: (path: string) => void;
  onOpenFileAt: (path: string, line?: number) => void;
};

type PinnedItem = { path: string; lineStart?: number; lineEnd?: number };

type Bubble =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'agent'; text: string }
  | { id: string; kind: 'system'; text: string }
  | { id: string; kind: 'error'; text: string }
  /** `count` collapses N consecutive identical routing decisions into one row. */
  | { id: string; kind: 'routing'; text: string; model: string; count: number }
  | { id: string; kind: 'approval'; requestId: string; approvalKind: 'diff' | 'command'; summary: string; command?: string; diffs?: FileDiffView[]; resolved?: string };

let bubbleSeq = 0;
const nextId = () => `b${++bubbleSeq}`;

/**
 * The router's `reason` already opens with "<label> (<provider>): ", and the
 * event carries modelId and provider separately — printing all three put the
 * same words on screen three times and turned every routing line into a
 * three-line paragraph. Keep the short model name and the actual justification.
 */
function compactRouting(e: TraceEvent): { model: string; text: string } {
  const model = String(e.modelId ?? '').split(':').pop() || String(e.modelId ?? '');
  const reason = String(e.reason ?? '');
  const colon = reason.indexOf('): ');
  return { model, text: colon >= 0 ? reason.slice(colon + 3) : reason };
}

/** Matches `src/foo.ts:120` and `src/foo.ts:120-140` inside agent prose. */
const FILE_REF = /([\w./\\-]+\.[A-Za-z0-9]{1,8}):(\d+)(?:-(\d+))?/g;

function LinkedText({ text, onOpenFileAt }: { text: string; onOpenFileAt: (p: string, l?: number) => void }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  FILE_REF.lastIndex = 0;
  while ((m = FILE_REF.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const [full, path, line] = m;
    parts.push(
      <button
        key={`${m.index}-${full}`}
        type="button"
        className="chat-file-link"
        onClick={() => onOpenFileAt(path, Number(line))}
        title={`Open ${path} at line ${line}`}
      >
        {full}
      </button>
    );
    last = m.index + full.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export default function ChatPanel({
  rootPath,
  activeFilePath,
  trace,
  onTraceEvent,
  onClose,
  onOpenSettings,
  onOpenDashboard,
  onRunCommand,
  onFileChanged,
  onOpenFileAt,
  onClearTrace,
}: ChatPanelProps) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [pinned, setPinned] = useState<PinnedItem[]>([]);
  const [running, setRunning] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [resumable, setResumable] = useState<{ taskId: string; prompt: string; step: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const push = (b: Bubble) => setBubbles((prev) => [...prev, b]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyTasks, setHistoryTasks] = useState<any[]>([]);

  const processEventIntoBubbles = (e: TraceEvent, currentBubbles: Bubble[]) => {
    let nextBubbles = [...currentBubbles];
    const pushLocal = (b: Bubble) => { nextBubbles.push(b); };

    switch (e.type) {
      case 'task_started':
        if (e.prompt) pushLocal({ id: nextId(), kind: 'user', text: e.prompt });
        break;
      case 'plan_created':
        pushLocal({
          id: nextId(),
          kind: 'system',
          text: e.shortCircuited ? 'Handling this directly — too simple to be worth decomposing.' : `Plan: ${e.subtasks.map((s: any, i: number) => `${i + 1}. ${s.title}`).join('  ')}`,
        });
        break;
      case 'routing_decision': {
        const { model, text } = compactRouting(e);
        const last = nextBubbles[nextBubbles.length - 1];
        if (last?.kind === 'routing' && last.model === model && last.text === text) {
          last.count += 1;
        } else {
          pushLocal({ id: nextId(), kind: 'routing', model, text, count: 1 });
        }
        break;
      }
      case 'subtask_started':
        pushLocal({ id: nextId(), kind: 'system', text: `▸ ${e.title}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}` });
        break;
      case 'compaction':
        pushLocal({ id: nextId(), kind: 'system', text: `Compacted context ${e.beforeTokens}→${e.afterTokens} tokens.` });
        break;
      case 'intervention':
        pushLocal({ id: nextId(), kind: e.cause === 'provider_failover' ? 'error' : 'system', text: `${e.cause.replace(/_/g, ' ')} — ${e.detail}\n${e.action}` });
        break;
      case 'approval_request':
        pushLocal({ id: nextId(), kind: 'approval', requestId: e.request.requestId, approvalKind: e.request.kind, summary: e.request.summary, command: e.request.command, diffs: e.request.diff });
        break;
      case 'approval_resolved':
        nextBubbles = nextBubbles.map((b) =>
          b.kind === 'approval' && b.requestId === e.requestId && !b.resolved
            ? {
                ...b,
                resolved: e.approved
                  ? e.acceptedBlockIds?.length
                    ? `kept ${e.acceptedBlockIds.length} change(s)`
                    : 'approved'
                  : 'denied',
              }
            : b
        );
        break;
      case 'task_finished':
        pushLocal({ id: nextId(), kind: 'agent', text: e.summary });
        break;
      case 'task_failed':
        pushLocal({ id: nextId(), kind: 'error', text: e.reason });
        break;
      case 'task_cancelled':
        pushLocal({ id: nextId(), kind: 'system', text: 'Task cancelled.' });
        break;
      case 'resumed':
        pushLocal({ id: nextId(), kind: 'system', text: e.note });
        break;
    }
    return nextBubbles;
  };

  useEffect(() => {
    (async () => {
      const tasks = await window.electronAPI?.orchestratorListTasks();
      const interrupted = (tasks ?? []).find((t: any) => t.status === 'running' || t.status === 'paused');
      if (interrupted) {
        setResumable({ taskId: interrupted.taskId, prompt: interrupted.prompt, step: interrupted.step });
      }
    })();
  }, [rootPath]);

  // Turn the orchestrator's stream into chat bubbles. The dashboard consumes
  // the same events through the shared reducer; this view is the human-facing
  // digest of them, not a second source of truth.
  useEffect(() => {
    const off = window.electronAPI?.onOrchestratorEvent((e: TraceEvent) => {
      onTraceEvent(e);
      setBubbles((prev) => processEventIntoBubbles(e, prev));
      
      if (['task_finished', 'task_failed', 'task_cancelled'].includes(e.type)) {
        setRunning(false);
        setTaskId(null);
        if (e.type === 'task_finished') onFileChanged('');
      }
    });
    const offStatus = window.electronAPI?.onOrchestratorStatus((s) => {
      if (s.state !== 'ready') push({ id: nextId(), kind: 'error', text: s.message ?? s.state });
    });
    return () => { off?.(); offStatus?.(); };
  }, [onTraceEvent, onFileChanged]);

  // Follow the tail only when the user is already at it. Unconditionally
  // scrolling to the bottom on every event yanked the view away mid-review of
  // a pending diff — and that diff is the one thing the whole task is blocked
  // on, so it is the last thing that should scroll off screen.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [bubbles]);

  // A newly-raised approval is what the orchestrator is now blocked on, so it
  // always gets scrolled to regardless of where the user was reading.
  const pendingApproval = bubbles.find((b) => b.kind === 'approval' && !b.resolved);
  useEffect(() => {
    if (!pendingApproval) return;
    document
      .getElementById(`approval-${pendingApproval.id}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [pendingApproval?.id]);

  const pinActiveFile = useCallback(() => {
    if (!activeFilePath) return;
    const rel = rootPath && activeFilePath.startsWith(rootPath) ? activeFilePath.slice(rootPath.length + 1) : activeFilePath;
    setPinned((prev) => (prev.some((p) => p.path === rel) ? prev : [...prev, { path: rel }]));
  }, [activeFilePath, rootPath]);

  /** Reads pinned files at send time so the agent sees current disk content. */
  const buildContextBlock = useCallback(async (): Promise<string> => {
    if (!pinned.length || !rootPath) return '';
    const chunks: string[] = [];
    for (const p of pinned) {
      try {
        const full = `${rootPath}/${p.path}`.replace(/\\/g, '/');
        const text = await window.electronAPI!.readFile(full);
        const lines = text.split('\n');
        const start = p.lineStart ?? 1;
        const end = p.lineEnd ?? lines.length;
        chunks.push(`--- ${p.path}:${start}-${end} ---\n${lines.slice(start - 1, end).join('\n')}`);
      } catch {
        chunks.push(`--- ${p.path} --- (could not be read)`);
      }
    }
    return `\n\nThe user has explicitly pinned this context. Treat it as directly relevant:\n\n${chunks.join('\n\n')}`;
  }, [pinned, rootPath]);

  const loadPastTask = async (id: string) => {
    try {
      if (onClearTrace) onClearTrace();
      const events: TraceEvent[] = await window.electronAPI!.orchestratorReadTaskEvents(id);
      
      let replayedBubbles: Bubble[] = [];
      for (const e of events) {
        onTraceEvent(e);
        replayedBubbles = processEventIntoBubbles(e, replayedBubbles);
      }
      
      setBubbles(replayedBubbles);
      setTaskId(id);
      setRunning(false);
      setShowHistory(false);
    } catch (err) {
      push({ id: nextId(), kind: 'error', text: 'Failed to load history: ' + err });
    }
  };

  const toggleHistory = async () => {
    if (!showHistory) {
      const tasks = await window.electronAPI?.orchestratorListTasks();
      setHistoryTasks(tasks || []);
    }
    setShowHistory(!showHistory);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || running) return;
    setInput('');

    // `@path` / `@path:12-40` become pins rather than prose.
    const pinMatches = [...text.matchAll(/@([\w./\\-]+?)(?::(\d+)(?:-(\d+))?)?(?=\s|$)/g)];
    if (pinMatches.length) {
      setPinned((prev) => {
        const next = [...prev];
        for (const m of pinMatches) {
          const item: PinnedItem = {
            path: m[1],
            lineStart: m[2] ? Number(m[2]) : undefined,
            lineEnd: m[3] ? Number(m[3]) : m[2] ? Number(m[2]) : undefined,
          };
          if (!next.some((p) => p.path === item.path && p.lineStart === item.lineStart)) next.push(item);
        }
        return next;
      });
    }

    // `/run` — manual bypass straight to the visible terminal, no agent.
    if (text.startsWith('/run ')) {
      const command = text.slice(5).trim();
      if (command) {
        onRunCommand(command);
        push({ id: nextId(), kind: 'system', text: `Sent straight to the terminal (agent bypassed): ${command}` });
      }
      return;
    }

    // `/bytheway` — isolated, zero-context. Runs as its own command in the
    // orchestrator and never touches a running task's history.
    if (text.startsWith('/bytheway') || text.startsWith('/btw')) {
      const question = text.replace(/^\/(bytheway|btw)\s*/, '');
      if (!question) {
        push({ id: nextId(), kind: 'error', text: 'Usage: /bytheway <question>' });
        return;
      }
      push({ id: nextId(), kind: 'user', text });
      try {
        const res = await window.electronAPI!.orchestratorIsolatedQuery(question);
        push({ id: nextId(), kind: 'system', text: `isolated · ${res.modelId} · ${formatUsd(res.costUsd)} — no project context, no tools, not added to the task` });
        push({ id: nextId(), kind: 'agent', text: res.answer });
      } catch (err) {
        push({ id: nextId(), kind: 'error', text: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    const contextBlock = await buildContextBlock();
    const id = `task_${Date.now()}`;
    setTaskId(id);
    setRunning(true);
    try {
      await window.electronAPI!.orchestratorStartTask(id, text + contextBlock);
    } catch (err) {
      push({ id: nextId(), kind: 'error', text: err instanceof Error ? err.message : String(err) });
      setRunning(false);
      setTaskId(null);
    }
  };

  /** Returns false when the decision could not be delivered, so the widget can
   *  re-enable itself and let the user retry rather than dead-ending. */
  const decide = async (requestId: string, approved: boolean, acceptedBlockIds: string[]): Promise<boolean> => {
    // Send FIRST, then collapse the widget. Marking it resolved optimistically
    // and then failing to deliver left the orchestrator blocked on an approval
    // the user could no longer answer — the task just hung with the UI
    // claiming it had been handled.
    try {
      await window.electronAPI?.orchestratorApprove({ requestId, approved, acceptedBlockIds });
    } catch (err) {
      push({
        id: nextId(),
        kind: 'error',
        text: `Could not deliver that decision: ${err instanceof Error ? err.message : String(err)}. The task is still waiting — try again.`,
      });
      return false;
    }
    setBubbles((prev) =>
      prev.map((b) =>
        b.kind === 'approval' && b.requestId === requestId
          ? { ...b, resolved: approved ? (acceptedBlockIds.length ? `applied ${acceptedBlockIds.length} block(s)` : 'approved') : 'rejected' }
          : b
      )
    );
    return true;
  };

  const resume = async () => {
    if (!resumable) return;
    setRunning(true);
    setTaskId(resumable.taskId);
    push({ id: nextId(), kind: 'user', text: resumable.prompt });
    try {
      await window.electronAPI!.orchestratorResumeTask(resumable.taskId);
      setResumable(null);
    } catch (err) {
      push({ id: nextId(), kind: 'error', text: err instanceof Error ? err.message : String(err) });
      setRunning(false);
    }
  };

  const budgetPct = trace.budget.maxCostUsd > 0 ? (trace.budget.costUsd / trace.budget.maxCostUsd) * 100 : 0;

  return (
    <aside className="chat-sidebar">
      <div className="chat-header">
        <span>AI AGENT</span>
        <div className="chat-header-actions">
          <button className="chat-icon-btn" onClick={toggleHistory} title="Task History">
            🕒
          </button>
          <button className="chat-icon-btn" onClick={onOpenDashboard} title="Observability dashboard (Ctrl+Shift+D)">
            ▤
          </button>
          <button className="chat-icon-btn" onClick={onOpenSettings} title="Agent Settings (Ctrl+,)">
            ⚙
          </button>
          <button className="terminal-close-btn" onClick={onClose} title="Close chat">
            ×
          </button>
        </div>
      </div>

      {showHistory && (
        <div className="chat-history-menu" style={{ padding: '12px', backgroundColor: '#252526', borderBottom: '1px solid #333' }}>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '12px', color: '#ccc' }}>Previous Tasks</h4>
          {historyTasks.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#888' }}>No history found for this project.</div>
          ) : (
            <div style={{ maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {historyTasks.map(task => (
                <button 
                  key={task.taskId} 
                  onClick={() => loadPastTask(task.taskId)}
                  style={{ textAlign: 'left', padding: '6px', background: '#333', border: 'none', color: '#ddd', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <strong>{new Date(task.createdAt).toLocaleDateString()}</strong>
                    <span style={{ color: task.status === 'done' ? '#4caf50' : task.status === 'failed' ? '#f44336' : '#ff9800' }}>
                      {task.status}
                    </span>
                  </div>
                  <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.prompt}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {running && (
        <div className="chat-budget">
          <div className="chat-budget-bar">
            <div
              className={`chat-budget-fill${budgetPct > 85 ? ' danger' : budgetPct > 60 ? ' warn' : ''}`}
              style={{ width: `${Math.min(100, budgetPct)}%` }}
            />
          </div>
          <span className="chat-budget-text">
            {formatUsd(trace.budget.costUsd)} / ${trace.budget.maxCostUsd} · {Math.round(trace.budget.elapsedSeconds)}s
            / {trace.budget.maxSeconds}s
          </span>
          <button type="button" className="chat-cancel-btn" onClick={() => taskId && window.electronAPI?.orchestratorCancelTask(taskId)}>
            Stop
          </button>
        </div>
      )}

      {resumable && !running && (
        <div className="chat-resume">
          <span>Interrupted task from a previous session (step {resumable.step}).</span>
          <div>
            <button type="button" onClick={resume}>
              Resume
            </button>
            <button type="button" className="chat-resume-dismiss" onClick={() => setResumable(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="chat-messages" ref={scrollRef}>
        {bubbles.length === 0 ? (
          <div className="chat-empty">
            <p>Multi-agent orchestration: the request is decomposed, each subtask is routed to a model chosen live, and results are independently verified before anything is called done.</p>
            <p className="chat-empty-hint">
              <code>@path/to/file.ts:10-40</code> pins context · <code>/bytheway</code> asks in isolation ·{' '}
              <code>/run</code> bypasses the agent
            </p>
            <p className="chat-empty-hint">Enable at least one model in <code>Agent → Settings</code> first.</p>
          </div>
        ) : (
          bubbles.map((b) => {
            if (b.kind === 'approval') {
              if (b.resolved) {
                return (
                  <div key={b.id} className="chat-approval-resolved">
                    {b.summary} — <strong>{b.resolved}</strong>
                  </div>
                );
              }
              // The diff itself is reviewed in the editor pane (see
              // DiffReviewPane) where there is room to read code in context
              // and a real Monaco buffer to read it in. Duplicating the whole
              // review inside a 360px sidebar would give the user two places
              // to answer the same blocking approval — and two chances to
              // answer it differently.
              if (b.approvalKind === 'diff' && b.diffs) {
                const files = b.diffs;
                const hunks = files.reduce((n, d) => n + d.blocks.length, 0);
                return (
                  <div key={b.id} id={`approval-${b.id}`} className="chat-diff-pointer">
                    <div className="chat-diff-pointer-head">
                      {hunks} change{hunks === 1 ? '' : 's'} waiting for review
                    </div>
                    <div className="chat-diff-pointer-body">{b.summary}</div>
                    <div className="chat-diff-pointer-files">
                      {files.map((d) => (
                        <code key={d.path} title={d.path}>
                          {d.path}
                        </code>
                      ))}
                    </div>
                    <div className="chat-diff-pointer-hint">
                      Keep or deny each change in the editor, then apply.
                    </div>
                  </div>
                );
              }
              return (
                <div key={b.id} id={`approval-${b.id}`} className="chat-command-approval">
                  <div className="chat-command-head">Approve this command?</div>
                  <pre className="chat-command-body">{b.command}</pre>
                  <div className="chat-approval-actions">
                    <button type="button" className="chat-approve-btn" onClick={() => decide(b.requestId, true, [])}>
                      Approve
                    </button>
                    <button type="button" className="chat-reject-btn" onClick={() => decide(b.requestId, false, [])}>
                      Reject
                    </button>
                  </div>
                </div>
              );
            }
            if (b.kind === 'routing') {
              return (
                <div key={b.id} className="chat-routing" title={b.text}>
                  <span className="chat-routing-icon">⇄</span>
                  <span className="chat-routing-model">{b.model}</span>
                  <span className="chat-routing-why">{b.text}</span>
                  {b.count > 1 && <span className="chat-routing-count">×{b.count}</span>}
                </div>
              );
            }
            if (b.kind === 'system') {
              return (
                <div key={b.id} className="chat-system">
                  {b.text}
                </div>
              );
            }
            if (b.kind === 'error') {
              return (
                <div key={b.id} className="chat-message chat-message-error">
                  <div className="chat-message-role">Error</div>
                  <div className="chat-message-text">{b.text}</div>
                </div>
              );
            }
            return (
              <div key={b.id} className={`chat-message ${b.kind === 'user' ? 'user' : 'assistant'}`}>
                <div className="chat-message-role">{b.kind === 'user' ? 'You' : 'Agent'}</div>
                <div className="chat-message-text">
                  <LinkedText text={b.text} onOpenFileAt={onOpenFileAt} />
                </div>
              </div>
            );
          })
        )}
        {running && <div className="chat-thinking">Working…</div>}
      </div>

      <div className="chat-context-row">
        <div className="chat-pins">
          {pinned.map((p, i) => (
            <span key={`${p.path}-${i}`} className="chat-pin">
              <button
                type="button"
                className="chat-pin-open"
                onClick={() => onOpenFileAt(p.path, p.lineStart)}
                title="Open this file"
              >
                {p.path}
                {p.lineStart ? `:${p.lineStart}${p.lineEnd && p.lineEnd !== p.lineStart ? `-${p.lineEnd}` : ''}` : ''}
              </button>
              <button
                type="button"
                className="chat-pin-remove"
                onClick={() => setPinned((prev) => prev.filter((_, j) => j !== i))}
                aria-label={`Remove ${p.path} from context`}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" className="chat-pin-add" onClick={pinActiveFile} disabled={!activeFilePath}>
            + current file
          </button>
        </div>
      </div>

      <div className="chat-input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Describe a task, @pin a file, /bytheway…"
          rows={3}
          disabled={running}
        />
        <button type="button" onClick={send} disabled={running || !input.trim()}>
          Send
        </button>
      </div>
    </aside>
  );
}
