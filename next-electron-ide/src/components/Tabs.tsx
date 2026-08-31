'use client';

import { X } from 'lucide-react';

export type OpenFile = {
  path: string;
  name: string;
  dirty: boolean;
};

type TabsProps = {
  files: OpenFile[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
};

export default function Tabs({ files, activePath, onSelect, onClose }: TabsProps) {
  if (files.length === 0) return null;
  return (
    <div className="tabs">
      {files.map((f) => (
        <div
          key={f.path}
          className={`tab${activePath === f.path ? ' active' : ''}`}
          onClick={() => onSelect(f.path)}
          title={f.path}
        >
          <span className="tab-name">
            {f.name}
            {f.dirty ? ' •' : ''}
          </span>
          <span
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(f.path);
            }}
          >
            <X size={12} />
          </span>
        </div>
      ))}
    </div>
  );
}
