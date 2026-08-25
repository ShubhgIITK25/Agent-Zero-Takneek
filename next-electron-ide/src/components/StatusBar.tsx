'use client';

import { languageFromPath } from '../lib/language';

type StatusBarProps = {
  filePath: string | null;
  dirty: boolean;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  chatOpen?: boolean;
  onToggleChat?: () => void;
  onOpenSettings?: () => void;
};

export default function StatusBar({
  filePath,
  dirty,
  terminalOpen,
  onToggleTerminal,
  chatOpen,
  onToggleChat,
  onOpenSettings,
}: StatusBarProps) {
  return (
    <div className="status-bar">
      <span className="status-item">{filePath ? filePath : 'No file selected'}</span>
      <div className="status-right">
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
