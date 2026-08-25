'use client';

import { languageFromPath } from '../lib/language';

type StatusBarProps = {
  filePath: string | null;
  dirty: boolean;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
};

export default function StatusBar({ filePath, dirty, terminalOpen, onToggleTerminal }: StatusBarProps) {
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
            className={`status-terminal-toggle${terminalOpen ? ' active' : ''}`}
            onClick={onToggleTerminal}
            title="Toggle Terminal (Ctrl+`)"
          >
            {terminalOpen ? '▾' : '▸'} Terminal
          </button>
        )}
      </div>
    </div>
  );
}
