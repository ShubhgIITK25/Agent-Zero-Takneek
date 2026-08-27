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
      if (files == null || chunks == null) return 'Index ready';
      return `Index ready (${files} files, ${chunks} chunks)`;
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
  retrievalStatus,
}: StatusBarProps) {
  const retrievalText = retrievalLabel(retrievalStatus);

  return (
    <div className="status-bar">
      <span className="status-item">{filePath ? filePath : 'No file selected'}</span>
      <div className="status-right">
        {retrievalText && (
          <span
            className={`status-item status-retrieval status-retrieval-${retrievalStatus?.state}`}
            title="Code retrieval index status"
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
