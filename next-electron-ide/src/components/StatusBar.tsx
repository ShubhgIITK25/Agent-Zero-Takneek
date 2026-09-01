'use client';

import { ChevronDown, ChevronRight, LayoutDashboard, Settings, Terminal as LucideTerminal, MessageSquare, Search, RefreshCw } from 'lucide-react';
import { languageFromPath } from '../lib/language';
import type { RetrievalStatus } from '../lib/electron-api';

const ICON = { size: 13, strokeWidth: 1.75 } as const;

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
  onRetryRetrieval?: () => void;
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
      return 'Index pending';
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
  onRetryRetrieval,
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
                ? 'Retrieval is running keyword-only: the Python service is missing tree-sitter / fastembed / sqlite-vec. Install retrieval-service/requirements.txt or set CODENAWABS_PYTHON (README §2.3).'
                : 'Code retrieval index status'
            }
          >
            <Search size={14} style={{ marginRight: '4px' }} />
            {retrievalText}
          </span>
        )}
        {onRetryRetrieval &&
          (retrievalStatus?.state === 'unavailable' || retrievalStatus?.state === 'error') && (
            <button
              type="button"
              className="status-toggle-btn"
              onClick={onRetryRetrieval}
              title="Restart retrieval service and re-index the current project"
            >
              <RefreshCw size={13} style={{ marginRight: '4px' }} />
              Retry index
            </button>
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
            {terminalOpen ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}
            <LucideTerminal size={14} style={{ marginRight: '4px' }} />
            Terminal
          </button>
        )}
        {onToggleChat && (
          <button
            type="button"
            className={`status-toggle-btn${chatOpen ? ' active' : ''}`}
            onClick={onToggleChat}
            title="Toggle AI Chat (Ctrl+L)"
          >
            {chatOpen ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}
            <MessageSquare size={14} style={{ marginRight: '4px' }} />
            Chat
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
            <LayoutDashboard {...ICON} />
            Dashboard
          </button>
        )}
        {onOpenSettings && (
          <button
            type="button"
            className="status-toggle-btn"
            onClick={onOpenSettings}
            title="Agent Settings (Ctrl+,)"
          >
            <Settings {...ICON} />
            Settings
          </button>
        )}
      </div>
    </div>
  );
}
