'use client';

import { languageFromPath } from '../lib/language';
import type { RetrievalStatus } from '../lib/electron-api';

type StatusBarProps = {
  filePath: string | null;
  dirty: boolean;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  chatOpen?: boolean;
  onToggleChat?: () => void;
  onOpenSettings?: () => void;
  onOpenDashboard?: () => void;
  /** Live spend on the running task, or null when nothing is running. */
  taskCost?: number | null;
  retrievalStatus?: RetrievalStatus | null;
};

function retrievalLabel(status: RetrievalStatus | null | undefined): string | null {
  if (!status) return null;
  switch (status.state) {
    case 'indexing':
      return 'Indexing…';
    case 'ready': {
      const files = status.files_indexed;
      const chunks = status.chunks_indexed;
      const suffix = status.degraded ? ' · keyword-only' : '';
      if (files == null || chunks == null) return `Index ready${suffix}`;
      return `Index ready (${files} files, ${chunks} chunks)${suffix}`;
    }
    case 'error':
      return `Index error: ${status.message ?? 'unknown'}`;
    case 'unavailable':
      return 'Retrieval unavailable';
    case 'idle':
    default:
      return null;
  }
}

export default function StatusBar({
  filePath,
  dirty,
  terminalOpen,
  onToggleTerminal,
  chatOpen,
  onToggleChat,
  onOpenSettings,
  onOpenDashboard,
  taskCost,
  retrievalStatus,
}: StatusBarProps) {
  const retrievalText = retrievalLabel(retrievalStatus);

  return (
    <div className="status-bar">
      <span className="status-item">{filePath ? filePath : 'No file selected'}</span>
      <div className="status-right">
        {retrievalText && (
          <span
            className={`status-item status-retrieval status-retrieval-${retrievalStatus?.state}${
              retrievalStatus?.degraded ? ' status-retrieval-degraded' : ''
            }`}
            title={
              retrievalStatus?.degraded
                ? 'Retrieval is running keyword-only: the Python service is missing tree-sitter / fastembed / sqlite-vec. Install retrieval-service/requirements.txt or set NEXIDE_PYTHON (README §2.3).'
                : 'Code retrieval index status'
            }
          >
            {retrievalText}
          </span>
        )}
        {filePath && <span className="status-item">{languageFromPath(filePath)}</span>}
        {dirty && <span className="status-item">● Unsaved</span>}
        <span className="status-item">UTF-8</span>
        {onToggleTerminal && (
          <button
            type="button"
            className={`status-toggle-btn${terminalOpen ? ' active' : ''}`}
            onClick={onToggleTerminal}
            title="Toggle Terminal (Ctrl+`)"
          >
            {terminalOpen ? '▾' : '▸'} Terminal
          </button>
        )}
        {onToggleChat && (
          <button
            type="button"
            className={`status-toggle-btn${chatOpen ? ' active' : ''}`}
            onClick={onToggleChat}
            title="Toggle AI Chat (Ctrl+L)"
          >
            {chatOpen ? '▾' : '▸'} AI Chat
          </button>
        )}
        {taskCost != null && (
          <span className="status-item status-cost" title="Spend on the running task">
            ${taskCost.toFixed(4)}
          </span>
        )}
        {onOpenDashboard && (
          <button
            type="button"
            className="status-toggle-btn"
            onClick={onOpenDashboard}
            title="Observability dashboard (Ctrl+Shift+D)"
          >
            ▤ Dashboard
          </button>
        )}
        {onOpenSettings && (
          <button
            type="button"
            className="status-toggle-btn"
            onClick={onOpenSettings}
            title="Agent Settings (Ctrl+,)"
          >
            ⚙ Settings
          </button>
        )}
      </div>
    </div>
  );
}
