'use client';

import { useRef, useState } from 'react';
import { AgentSession, AgentEvent, runIsolatedQuery } from '../lib/agent';
import type { LLMToolCall } from '../lib/llm';

type ChatPanelProps = {
  rootPath: string | null;
  activeFilePath: string | null;
  activeFileContent: string | null;
  onClose: () => void;
  onOpenSettings: () => void;
  onRunCommand: (command: string) => void;
  onFileChanged: (path: string) => void;
};

type UIMessage =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'error'; text: string }
  | {
      id: string;
      kind: 'tool';
      callId: string;
      name: string;
      args: Record<string, unknown>;
      sideEffecting: boolean;
      status: 'awaiting-approval' | 'running' | 'done' | 'rejected' | 'error';
      result?: string;
    };

let nextId = 0;
function makeId(): string {
  nextId += 1;
  return `msg-${nextId}`;
}

export default function ChatPanel({
  rootPath,
  activeFilePath,
  activeFileContent,
  onClose,
  onOpenSettings,
  onRunCommand,
  onFileChanged,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState('');
  const [includeActiveFile, setIncludeActiveFile] = useState(true);
  const [sending, setSending] = useState(false);
  const [session] = useState(() => new AgentSession());
  const approvalResolverRef = useRef<((approved: boolean) => void) | null>(null);

  const handleEvent = (event: AgentEvent) => {
    if (event.type === 'assistant-text') {
      setMessages((prev) => [...prev, { id: makeId(), kind: 'assistant', text: event.text }]);
    } else if (event.type === 'error') {
      setMessages((prev) => [...prev, { id: makeId(), kind: 'error', text: event.message }]);
    } else if (event.type === 'tool-start') {
      setMessages((prev) => [
        ...prev,
        {
          id: event.call.id,
          kind: 'tool',
          callId: event.call.id,
          name: event.call.name,
          args: event.call.arguments,
          sideEffecting: event.sideEffecting,
          status: event.sideEffecting ? 'awaiting-approval' : 'running',
        },
      ]);
    } else if (event.type === 'tool-result') {
      setMessages((prev) =>
        prev.map((m) => (m.kind === 'tool' && m.callId === event.call.id ? { ...m, status: event.outcome, result: event.result } : m))
      );
    }
  };

  const resolveApproval = (call: LLMToolCall, approved: boolean) => {
    // Optimistic UI update so the buttons disappear immediately, before the
    // tool-result event comes back from the (possibly slow) tool execution.
    setMessages((prev) =>
      prev.map((m) => (m.kind === 'tool' && m.callId === call.id ? { ...m, status: approved ? 'running' : 'rejected' } : m))
    );
    approvalResolverRef.current?.(approved);
    approvalResolverRef.current = null;
  };

  const requestApproval = (call: LLMToolCall): Promise<boolean> =>
    new Promise((resolve) => {
      approvalResolverRef.current = resolve;
    });

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setMessages((prev) => [...prev, { id: makeId(), kind: 'user', text }]);
    setSending(true);

    try {
      // Manual escape hatch: run a command directly without going through
      // the (currently unimplemented) LLM. Useful for testing the terminal
      // wiring on its own.
      if (text.startsWith('/run ')) {
        const command = text.slice('/run '.length).trim();
        if (command) {
          onRunCommand(command);
          setMessages((prev) => [
            ...prev,
            { id: makeId(), kind: 'assistant', text: `Sent directly to the terminal (bypassed the agent): \`${command}\`` },
          ]);
        }
        return;
      }

      // `/bytheway` — isolated, zero-context, doesn't touch the session.
      if (text.startsWith('/bytheway') || text.startsWith('/btw')) {
        const question = text.replace(/^\/(bytheway|btw)\s*/, '');
        if (!question) {
          setMessages((prev) => [...prev, { id: makeId(), kind: 'error', text: 'Usage: /bytheway <question>' }]);
          return;
        }
        try {
          const answer = await runIsolatedQuery(question);
          setMessages((prev) => [...prev, { id: makeId(), kind: 'assistant', text: answer }]);
        } catch (err) {
          setMessages((prev) => [
            ...prev,
            { id: makeId(), kind: 'error', text: err instanceof Error ? err.message : String(err) },
          ]);
        }
        return;
      }

      await session.sendMessage(
        text,
        {
          rootPath,
          activeFilePath: includeActiveFile ? activeFilePath : null,
          activeFileContent: includeActiveFile ? activeFileContent : null,
        },
        { onEvent: handleEvent, requestApproval, runInTerminal: onRunCommand, notifyFileChanged: onFileChanged }
      );
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <aside className="chat-sidebar">
      <div className="chat-header">
        <span>AI AGENT</span>
        <div className="chat-header-actions">
          <button className="chat-icon-btn" onClick={onOpenSettings} title="Agent Settings (Ctrl+,)">
            ⚙
          </button>
          <button className="terminal-close-btn" onClick={onClose} title="Close chat">
            ×
          </button>
        </div>
      </div>

      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <p>The agent loop, tool execution, and approval gate are real — only the model call is a stub.</p>
            <p className="chat-empty-hint">
              Set <code>LLM_ENDPOINT</code> and implement <code>callLLM()</code> in{' '}
              <code>src/lib/llm.ts</code> to go live. Add API keys in <code>Agent → Settings</code> first.
            </p>
            <p className="chat-empty-hint">
              <code>/run &lt;command&gt;</code> bypasses the agent and runs directly in the
              terminal. <code>/bytheway &lt;question&gt;</code> is an isolated, zero-context aside.
            </p>
          </div>
        ) : (
          messages.map((m) => {
            if (m.kind === 'user' || m.kind === 'assistant') {
              return (
                <div key={m.id} className={`chat-message ${m.kind}`}>
                  <div className="chat-message-role">{m.kind === 'user' ? 'You' : 'Agent'}</div>
                  <div className="chat-message-text">{m.text}</div>
                </div>
              );
            }
            if (m.kind === 'error') {
              return (
                <div key={m.id} className="chat-message chat-message-error">
                  <div className="chat-message-role">Error</div>
                  <div className="chat-message-text">{m.text}</div>
                </div>
              );
            }
            // tool
            return (
              <div key={m.id} className={`chat-tool-call chat-tool-${m.status}`}>
                <div className="chat-tool-header">
                  <span className="chat-tool-name">{m.name}</span>
                  <span className={`chat-tool-status chat-tool-status-${m.status}`}>{m.status.replace('-', ' ')}</span>
                </div>
                <pre className="chat-tool-args">{JSON.stringify(m.args, null, 2)}</pre>
                {m.status === 'awaiting-approval' && (
                  <div className="chat-approval-actions">
                    <button
                      type="button"
                      className="chat-approve-btn"
                      onClick={() => resolveApproval({ id: m.callId, name: m.name, arguments: m.args }, true)}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="chat-reject-btn"
                      onClick={() => resolveApproval({ id: m.callId, name: m.name, arguments: m.args }, false)}
                    >
                      Reject
                    </button>
                  </div>
                )}
                {m.result && <div className="chat-tool-result">{m.result}</div>}
              </div>
            );
          })
        )}
        {sending && <div className="chat-message assistant chat-thinking">Agent is working…</div>}
      </div>

      <div className="chat-context-row">
        <label>
          <input
            type="checkbox"
            checked={includeActiveFile}
            onChange={(e) => setIncludeActiveFile(e.target.checked)}
            disabled={!activeFilePath}
          />
          {activeFilePath ? (
            <span>
              Include current file: <span className="chat-context-file">{activeFilePath.split(/[\\/]/).pop()}</span>
            </span>
          ) : (
            <span>No file open</span>
          )}
        </label>
      </div>

      <div className="chat-input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask the agent, /run a command, or /bytheway…"
          rows={3}
        />
        <button type="button" onClick={handleSend} disabled={sending || !input.trim()}>
          Send
        </button>
      </div>
    </aside>
  );
}
