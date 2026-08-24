'use client';

import { useState, useCallback } from 'react';
import type { FileNode } from '../lib/electron-api';

type TreeNodeProps = {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onOpenFile: (path: string) => void;
};

function TreeNode({ node, depth, activePath, onOpenFile }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    if (!node.isDirectory) {
      onOpenFile(node.path);
      return;
    }
    if (!expanded && children === null) {
      setLoading(true);
      const entries = await window.electronAPI!.readDir(node.path);
      setChildren(entries);
      setLoading(false);
    }
    setExpanded((v) => !v);
  }, [expanded, children, node, onOpenFile]);

  const isActive = activePath === node.path;

  return (
    <div>
      <div
        className={`tree-row${isActive ? ' active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={toggle}
        title={node.path}
      >
        {node.isDirectory ? (
          <span className={`chevron${expanded ? ' open' : ''}`}>▸</span>
        ) : (
          <span className="chevron-spacer" />
        )}
        <span className="node-icon">{node.isDirectory ? '📁' : fileIcon(node.name)}</span>
        <span className="node-name">{node.name}</span>
        {loading && <span className="node-loading">…</span>}
      </div>
      {node.isDirectory && expanded && children && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onOpenFile={onOpenFile}
            />
          ))}
          {children.length === 0 && (
            <div className="tree-empty" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              (empty)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return '🔷';
    case 'js':
    case 'jsx':
      return '🟨';
    case 'json':
      return '🧾';
    case 'md':
      return '📝';
    case 'css':
    case 'scss':
      return '🎨';
    default:
      return '📄';
  }
}

type FileTreeProps = {
  rootPath: string | null;
  rootEntries: FileNode[];
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
};

export default function FileTree({ rootPath, rootEntries, activePath, onOpenFile, onOpenFolder }: FileTreeProps) {
  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span>EXPLORER</span>
      </div>
      {!rootPath ? (
        <div className="file-tree-empty">
          <p>No folder open</p>
          <button onClick={onOpenFolder}>Open Folder</button>
        </div>
      ) : (
        <>
          <div className="file-tree-root" onClick={onOpenFolder} title="Click to open a different folder">
            {rootPath.split('/').pop() || rootPath}
          </div>
          <div className="file-tree-body">
            {rootEntries.map((node) => (
              <TreeNode key={node.path} node={node} depth={0} activePath={activePath} onOpenFile={onOpenFile} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
