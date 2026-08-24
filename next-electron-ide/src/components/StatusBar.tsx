'use client';

import { languageFromPath } from '../lib/language';

type StatusBarProps = {
  filePath: string | null;
  dirty: boolean;
};

export default function StatusBar({ filePath, dirty }: StatusBarProps) {
  return (
    <div className="status-bar">
      <span className="status-item">{filePath ? filePath : 'No file selected'}</span>
      <div className="status-right">
        {filePath && <span className="status-item">{languageFromPath(filePath)}</span>}
        {dirty && <span className="status-item">● Unsaved</span>}
        <span className="status-item">UTF-8</span>
      </div>
    </div>
  );
}
