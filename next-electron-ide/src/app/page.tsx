'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import FileTree from '../components/FileTree';
import Tabs, { OpenFile } from '../components/Tabs';
import StatusBar from '../components/StatusBar';
import type { FileNode } from '../lib/electron-api';

// Monaco touches `self`/`window` at module load time, so it must never be
// evaluated during SSR/static export — load it only on the client.
const EditorPane = dynamic(() => import('../components/EditorPane'), { ssr: false });

export default function Home() {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [rootEntries, setRootEntries] = useState<FileNode[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const contents = useRef<Map<string, string>>(new Map());
  const savedContents = useRef<Map<string, string>>(new Map());
  const [electronReady, setElectronReady] = useState(false);

  useEffect(() => {
    setElectronReady(typeof window !== 'undefined' && !!window.electronAPI);
    const off = window.electronAPI?.onFolderOpened(async (folderPath) => {
      setRootPath(folderPath);
      const entries = await window.electronAPI!.readDir(folderPath);
      setRootEntries(entries);
    });
    return off;
  }, []);

  const openFolder = useCallback(async () => {
    if (!window.electronAPI) return;
    const folderPath = await window.electronAPI.openFolder();
    if (!folderPath) return;
    setRootPath(folderPath);
    const entries = await window.electronAPI.readDir(folderPath);
    setRootEntries(entries);
  }, []);

  const openFile = useCallback(async (path: string) => {
    if (!window.electronAPI) return;
    if (!contents.current.has(path)) {
      const text = await window.electronAPI.readFile(path);
      contents.current.set(path, text);
      savedContents.current.set(path, text);
    }
    setOpenFiles((prev) => {
      if (prev.some((f) => f.path === path)) return prev;
      const name = path.split('/').pop() || path;
      return [...prev, { path, name, dirty: false }];
    });
    setActivePath(path);
  }, []);

  const closeFile = useCallback(
    (path: string) => {
      setOpenFiles((prev) => {
        const next = prev.filter((f) => f.path !== path);
        if (activePath === path) {
          setActivePath(next.length ? next[next.length - 1].path : null);
        }
        return next;
      });
      contents.current.delete(path);
      savedContents.current.delete(path);
    },
    [activePath]
  );

  const updateContent = useCallback(
    (path: string, value: string) => {
      contents.current.set(path, value);
      const isDirty = savedContents.current.get(path) !== value;
      setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, dirty: isDirty } : f)));
    },
    []
  );

  const saveActiveFile = useCallback(async () => {
    if (!activePath || !window.electronAPI) return;
    const value = contents.current.get(activePath) ?? '';
    await window.electronAPI.writeFile(activePath, value);
    savedContents.current.set(activePath, value);
    setOpenFiles((prev) => prev.map((f) => (f.path === activePath ? { ...f, dirty: false } : f)));
  }, [activePath]);

  const activeFile = openFiles.find((f) => f.path === activePath) || null;

  return (
    <div className="ide-shell">
      <aside className="sidebar">
        <FileTree
          rootPath={rootPath}
          rootEntries={rootEntries}
          activePath={activePath}
          onOpenFile={openFile}
          onOpenFolder={openFolder}
        />
      </aside>
      <main className="main-panel">
        <Tabs files={openFiles} activePath={activePath} onSelect={setActivePath} onClose={closeFile} />
        <div className="editor-container">
          {electronReady ? (
            <EditorPane
              filePath={activePath}
              content={activePath ? contents.current.get(activePath) ?? '' : ''}
              onChange={(value) => activePath && updateContent(activePath, value)}
              onSave={saveActiveFile}
            />
          ) : (
            <div className="editor-empty">
              <div>
                <h2>Electron bridge not available</h2>
                <p>Run this page inside the Electron shell (npm run dev) to access the filesystem.</p>
              </div>
            </div>
          )}
        </div>
        <StatusBar filePath={activePath} dirty={activeFile?.dirty ?? false} />
      </main>
    </div>
  );
}
