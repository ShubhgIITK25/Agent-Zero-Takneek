'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { FileNode } from '../lib/electron-api';

type TreeNodeProps = {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  refreshToken: number;
};

function TreeNode({ node, depth, activePath, onOpenFile, refreshToken }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadChildren = useCallback(async () => {
    setLoading(true);
    const entries = await window.electronAPI!.readDir(node.path);
    setChildren(entries);
    setLoading(false);
  }, [node.path]);

  const toggle = useCallback(async () => {
    if (!node.isDirectory) {
      onOpenFile(node.path);
      return;
    }
    if (!expanded && children === null) {
      await loadChildren();
    }
    setExpanded((v) => !v);
  }, [expanded, children, node, onOpenFile, loadChildren]);

  // Cascade a refresh into already-expanded folders (re-fetch their
  // children) without collapsing them or touching folders that were never
  // opened — those pick up fresh content naturally whenever they first
  // expand. Skips the very first render so mounting doesn't double-fetch.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (children !== null) {
      loadChildren();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

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
              refreshToken={refreshToken}
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
  refreshToken: number;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
  onRefresh: () => void;
};

export default function FileTree({
  rootPath,
  rootEntries,
  activePath,
  refreshToken,
  onOpenFile,
  onOpenFolder,
  onRefresh,
}: FileTreeProps) {
  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span>EXPLORER</span>
        {rootPath && (
          <button className="file-tree-refresh-btn" onClick={onRefresh} title="Refresh Files (Ctrl+R)">
            ⟳
          </button>
        )}
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
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                activePath={activePath}
                onOpenFile={onOpenFile}
                refreshToken={refreshToken}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
