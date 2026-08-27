'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { FileNode } from '../lib/electron-api';

type TreeNodeProps = {
  node: FileNode;
  depth: number;
  activePath: string | null;
  selectedDirectoryPath: string | null;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  onSelectDirectory: (path: string) => void;
  onSelectPath: (path: string) => void;
  refreshToken: number;
};

function TreeNode({ node, depth, activePath, selectedDirectoryPath, selectedPath, onOpenFile, onSelectDirectory, onSelectPath, refreshToken }: TreeNodeProps) {
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
      onSelectPath(node.path);
      onOpenFile(node.path);
      return;
    }
    onSelectPath(node.path);
    onSelectDirectory(node.path);
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

  const isSelected = selectedPath === node.path;

  return (
    <div>
      <div
        className={`tree-row${isSelected ? ' selected-item' : ''}`}
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
              selectedDirectoryPath={selectedDirectoryPath}
              selectedPath={selectedPath}
              onOpenFile={onOpenFile}
              onSelectDirectory={onSelectDirectory}
              onSelectPath={onSelectPath}
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
  selectedDirectoryPath: string | null;
  selectedPath: string | null;
  refreshToken: number;
  onOpenFile: (path: string) => void;
  onSelectDirectory: (path: string) => void;
  onSelectPath: (path: string) => void;
  onOpenFolder: () => void;
  onRefresh: () => void;
  onCreateFile: (name: string) => void;
  onCreateFolder: (name: string) => void;
  onDeletePath: (path: string) => void;
};

export default function FileTree({
  rootPath,
  rootEntries,
  activePath,
  selectedDirectoryPath,
  selectedPath,
  refreshToken,
  onOpenFile,
  onSelectDirectory,
  onSelectPath,
  onOpenFolder,
  onRefresh,
  onCreateFile,
  onCreateFolder,
  onDeletePath,
}: FileTreeProps) {
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null);
  const [newName, setNewName] = useState('');
  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) {
      createInputRef.current?.focus();
      createInputRef.current?.select();
    }
  }, [creating]);

  const beginCreate = (kind: 'file' | 'folder') => {
    setCreating(kind);
    setNewName('');
  };

  const finishCreate = () => {
    const name = newName.trim();
    if (!creating || !name) return;
    if (creating === 'file') onCreateFile(name);
    else onCreateFolder(name);
    setCreating(null);
    setNewName('');
  };

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span>EXPLORER</span>
        {rootPath && (
          <div className="file-tree-actions">
            <button className="file-tree-action-btn" onClick={() => beginCreate('file')} title="New File">
              +
            </button>
            <button className="file-tree-action-btn" onClick={() => beginCreate('folder')} title="New Folder">
              📁+
            </button>
            <button
              className="file-tree-action-btn"
              onClick={() => selectedPath && selectedPath !== rootPath && onDeletePath(selectedPath)}
              title="Delete Selected"
              disabled={!selectedPath || selectedPath === rootPath}
            >
              🗑
            </button>
            <button className="file-tree-refresh-btn" onClick={onRefresh} title="Refresh Files (Ctrl+R)">
              ⟳
            </button>
          </div>
        )}
      </div>
      {!rootPath ? (
        <div className="file-tree-empty">
          <p>No folder open</p>
          <button onClick={onOpenFolder}>Open Folder</button>
        </div>
      ) : (
        <>
          <div
            className={`file-tree-root${selectedDirectoryPath === rootPath ? ' selected-directory' : ''}`}
            onClick={() => {
              onSelectPath(rootPath);
              onSelectDirectory(rootPath);
            }}
            title="Select workspace folder"
          >
            {rootPath.split('/').pop() || rootPath}
          </div>
          {creating && (
            <form
              className="file-tree-create-form"
              onSubmit={(event) => {
                event.preventDefault();
                finishCreate();
              }}
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <input
                ref={createInputRef}
                className="file-tree-create-input"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onBlur={() => setCreating(null)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Escape') setCreating(null);
                }}
                placeholder={creating === 'file' ? 'New file name' : 'New folder name'}
                autoFocus
              />
            </form>
          )}
          <div className="file-tree-body">
            {rootEntries.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                activePath={activePath}
                selectedDirectoryPath={selectedDirectoryPath}
                selectedPath={selectedPath}
                onOpenFile={onOpenFile}
                onSelectDirectory={onSelectDirectory}
                onSelectPath={onSelectPath}
                refreshToken={refreshToken}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
