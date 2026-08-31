'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  ChevronRight,
  File,
  FileCode,
  FileJson,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
  Palette,
  Globe,
  Image,
  Terminal as LucideTerminal,
  Lock,
  GitBranch,
  X,
  FileSliders,
} from 'lucide-react';
import type { FileNode } from '../lib/electron-api';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

type TreeNodeProps = {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
  refreshToken: number;
};

type EditorMode = 'create-file' | 'create-folder' | 'rename';

function joinPath(parentPath: string, name: string): string {
  const separator = parentPath.includes('\\') ? '\\' : '/';
  return `${parentPath.replace(/[\\/]$/, '')}${separator}${name}`;
}

function parentPath(targetPath: string): string {
  return targetPath.replace(/[\\/][^\\/]+$/, '');
}

function validName(name: string | null): name is string {
  const trimmed = name?.trim();
  return !!trimmed && trimmed !== '.' && trimmed !== '..' && !/[\\/]/.test(trimmed);
}

function NameEntry({
  initialValue = '',
  placeholder,
  onCommit,
  onCancel,
}: {
  initialValue?: string;
  placeholder: string;
  onCommit: (name: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const name = value.trim();
    if (!validName(name)) {
      window.alert('Enter a name without path separators.');
      return;
    }
    setSubmitting(true);
    try {
      await onCommit(name);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <input
      className="tree-name-entry"
      autoFocus
      value={value}
      placeholder={placeholder}
      disabled={submitting}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={onCancel}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') void submit();
        if (event.key === 'Escape') onCancel();
      }}
    />
  );
}

function TreeNode({ node, depth, activePath, onOpenFile, onRefresh, refreshToken }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [editor, setEditor] = useState<EditorMode | null>(null);

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
  // opened - those pick up fresh content naturally whenever they first
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

  const create = async (kind: 'file' | 'folder', name: string) => {
    const targetPath = joinPath(node.path, name);
    try {
      if (kind === 'file') {
        await window.electronAPI!.createFile(targetPath);
        onOpenFile(targetPath);
      } else {
        await window.electronAPI!.createFolder(targetPath);
      }
      onRefresh();
      setEditor(null);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : `Could not create ${kind}.`);
    }
  };

  const rename = async (name: string) => {
    if (name === node.name) {
      setEditor(null);
      return;
    }
    try {
      await window.electronAPI!.rename(node.path, joinPath(parentPath(node.path), name));
      onRefresh();
      setEditor(null);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not rename this item.');
    }
  };

  const remove = async () => {
    const kind = node.isDirectory ? 'folder and everything inside it' : 'file';
    if (!window.confirm(`Delete ${kind} "${node.name}"?`)) return;
    try {
      await window.electronAPI!.deletePath(node.path);
      onRefresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not delete this item.');
    }
  };

  return (
    <div>
      <div
        className={`tree-row${isActive ? ' active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={toggle}
        title={node.path}
      >
        {node.isDirectory ? (
          <span className={`chevron${expanded ? ' open' : ''}`}>
            <ChevronRight {...ICON} />
          </span>
        ) : (
          <span className="chevron-spacer" />
        )}
        <span className="node-icon">{node.isDirectory ? <Folder {...ICON} /> : fileIcon(node.name)}</span>
        {editor === 'rename' ? (
          <NameEntry
            initialValue={node.name}
            placeholder="New name"
            onCommit={rename}
            onCancel={() => setEditor(null)}
          />
        ) : (
          <span className="node-name">{node.name}</span>
        )}
        {loading && <span className="node-loading">…</span>}
        <span className="tree-row-actions" onClick={(event) => event.stopPropagation()}>
          {node.isDirectory && (
            <>
              <button type="button" onClick={() => setEditor('create-file')} title="New File">
                <FilePlus {...ICON} />
              </button>
              <button type="button" onClick={() => setEditor('create-folder')} title="New Folder">
                <FolderPlus {...ICON} />
              </button>
            </>
          )}
          <button type="button" onClick={() => setEditor('rename')} title="Rename">
            <Pencil {...ICON} />
          </button>
          <button type="button" onClick={() => void remove()} title="Delete">
            <Trash2 {...ICON} />
          </button>
        </span>
      </div>
      {editor === 'create-file' && (
        <div className="tree-entry-row" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
          <NameEntry
            placeholder="New file name"
            onCommit={(name) => create('file', name)}
            onCancel={() => setEditor(null)}
          />
        </div>
      )}
      {editor === 'create-folder' && (
        <div className="tree-entry-row" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
          <NameEntry
            placeholder="New folder name"
            onCommit={(name) => create('folder', name)}
            onCancel={() => setEditor(null)}
          />
        </div>
      )}
      {node.isDirectory && expanded && children && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onOpenFile={onOpenFile}
              onRefresh={onRefresh}
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

function fileIcon(name: string) {
  if (name.includes('.env')) return <Lock {...ICON} />;
  if (name.endsWith('.lock')) return <Lock {...ICON} />;
  if (name === '.gitignore' || name === '.gitattributes') return <GitBranch {...ICON} />;

  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'py':
      return <FileCode {...ICON} />;
    case 'json':
      return <FileJson {...ICON} />;
    case 'md':
    case 'txt':
      return <FileText {...ICON} />;
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return <Palette {...ICON} />;
    case 'html':
    case 'htm':
      return <Globe {...ICON} />;
    case 'svg':
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'ico':
    case 'webp':
      return <Image {...ICON} />;
    case 'yml':
    case 'yaml':
    case 'toml':
      return <FileSliders {...ICON} />;
    case 'sh':
    case 'bash':
    case 'bat':
    case 'cmd':
    case 'ps1':
      return <LucideTerminal {...ICON} />;
    default:
      return <File {...ICON} />;
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
  const [rootEditor, setRootEditor] = useState<'file' | 'folder' | null>(null);

  const createInRoot = async (kind: 'file' | 'folder', name: string) => {
    if (!rootPath) return;
    const targetPath = joinPath(rootPath, name);
    try {
      if (kind === 'file') {
        await window.electronAPI!.createFile(targetPath);
        onOpenFile(targetPath);
      } else {
        await window.electronAPI!.createFolder(targetPath);
      }
      onRefresh();
      setRootEditor(null);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : `Could not create ${kind}.`);
    }
  };

  const rootName = rootPath?.split(/[\\/]/).filter(Boolean).pop() || rootPath;

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span>EXPLORER</span>
        {rootPath && <div className="file-tree-header-actions">
          <button className="file-tree-refresh-btn" onClick={() => setRootEditor('file')} title="New File">
            <FilePlus {...ICON} />
          </button>
          <button className="file-tree-refresh-btn" onClick={() => setRootEditor('folder')} title="New Folder">
            <FolderPlus {...ICON} />
          </button>
          <button className="file-tree-refresh-btn" onClick={onRefresh} title="Refresh Files (Ctrl+R)">
            <RefreshCw {...ICON} />
          </button>
        </div>}
      </div>
      {!rootPath ? (
        <div className="file-tree-empty">
          <p>No folder open</p>
          <button onClick={onOpenFolder}>Open Folder</button>
        </div>
      ) : (
        <>
          <div className="file-tree-root" title={rootPath}>
            {rootName}
          </div>
          <div className="file-tree-body">
            {rootEditor && (
              <div className="tree-entry-row">
                <NameEntry
                  placeholder={rootEditor === 'file' ? 'New file name' : 'New folder name'}
                  onCommit={(name) => createInRoot(rootEditor, name)}
                  onCancel={() => setRootEditor(null)}
                />
              </div>
            )}
            {rootEntries.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                activePath={activePath}
                onOpenFile={onOpenFile}
                onRefresh={onRefresh}
                refreshToken={refreshToken}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
