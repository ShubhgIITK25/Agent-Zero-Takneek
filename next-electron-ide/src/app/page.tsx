'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import FileTree from '../components/FileTree';
import Tabs, { OpenFile } from '../components/Tabs';
import StatusBar from '../components/StatusBar';
import ChatPanel from '../components/ChatPanel';
import SettingsPanel from '../components/SettingsPanel';
import Dashboard from '../components/Dashboard';
import type { FileNode, RetrievalStatus } from '../lib/electron-api';
import { TraceView, TraceEvent, applyEvent, emptyTrace } from '../lib/trace';

// Monaco touches `self`/`window` at module load time, so it must never be
// evaluated during SSR/static export — load it only on the client.
const EditorPane = dynamic(() => import('../components/EditorPane'), { ssr: false });
// xterm.js has the same constraint (touches `window`/`navigator` at import time).
const TerminalPanel = dynamic(() => import('../components/TerminalPanel'), { ssr: false });

const TERMINAL_ID = 'main-terminal';

export default function Home() {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [rootEntries, setRootEntries] = useState<FileNode[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const contents = useRef<Map<string, string>>(new Map());
  const savedContents = useRef<Map<string, string>>(new Map());
  const [electronReady, setElectronReady] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [pendingLine, setPendingLine] = useState<{ path: string; line: number } | null>(null);
  const [retrievalStatus, setRetrievalStatus] = useState<RetrievalStatus | null>(null);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  // The live trace lives here, not in ChatPanel, so the dashboard keeps
  // rendering a running task even when the chat panel is closed.
  const [trace, setTrace] = useState<TraceView>(emptyTrace);
  const handleTraceEvent = useCallback((e: TraceEvent) => {
    setTrace((prev) => applyEvent(e.type === 'task_started' ? emptyTrace() : prev, e));
  }, []);

  // One code path for "a folder is now open", whether that came from the
  // dialog, the menu, or main restoring the previous session's folder.
  const adoptFolder = useCallback(async (folderPath: string) => {
    setRootPath(folderPath);
    try {
      setRootEntries(await window.electronAPI!.readDir(folderPath));
    } catch {
      // Restored path vanished between main's stat and this read.
      setRootEntries([]);
    }
    window.electronAPI!.terminalChangeDir(TERMINAL_ID, folderPath);
  }, []);

  useEffect(() => {
    setElectronReady(typeof window !== 'undefined' && !!window.electronAPI);
    // Main may have restored a folder before this window finished loading, so
    // its 'folder:opened' push landed with nobody listening — ask directly.
    window.electronAPI?.getCurrentFolder().then((folderPath) => {
      if (folderPath) adoptFolder(folderPath);
    });
    const offFolder = window.electronAPI?.onFolderOpened((folderPath) => {
      adoptFolder(folderPath);
    });
    const offTerminal = window.electronAPI?.onTerminalToggle(() => {
      setTerminalOpen((open) => !open);
    });
    const offChat = window.electronAPI?.onChatToggle(() => {
      setChatOpen((open) => !open);
    });
    const offSettings = window.electronAPI?.onSettingsToggle(() => {
      setSettingsOpen((open) => !open);
    });
    const offDashboard = window.electronAPI?.onDashboardToggle(() => {
      setDashboardOpen((open) => !open);
    });
    const offFilesRefresh = window.electronAPI?.onFilesRefresh(() => {
      refreshWorkspaceRef.current();
    });
    const offRetrievalStatus = window.electronAPI?.onRetrievalStatus((status) => {
      setRetrievalStatus(status);
    });
    return () => {
      offFolder?.();
      offTerminal?.();
      offChat?.();
      offSettings?.();
      offDashboard?.();
      offFilesRefresh?.();
      offRetrievalStatus?.();
    };
  }, [adoptFolder]);

  const openFolder = useCallback(async () => {
    if (!window.electronAPI) return;
    const folderPath = await window.electronAPI.openFolder();
    if (folderPath) adoptFolder(folderPath);
  }, [adoptFolder]);

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

  // Re-reads the file tree from disk, and reloads any open, non-dirty
  // file's content from disk (never clobbers unsaved edits). Pass a
  // specific path to only reload that one file — used when the agent's
  // write_file/delete_path tools change something; called with no argument
  // for a full manual refresh (the "Refresh Files" menu item / button).
  const refreshWorkspace = useCallback(
    async (changedPath?: string) => {
      if (!window.electronAPI) return;
      if (rootPath) {
        const entries = await window.electronAPI.readDir(rootPath);
        setRootEntries(entries);
      }
      const pathsToReload = changedPath ? [changedPath] : openFiles.map((f) => f.path);
      for (const path of pathsToReload) {
        const file = openFiles.find((f) => f.path === path);
        if (!file || file.dirty) continue;
        try {
          const text = await window.electronAPI.readFile(path);
          contents.current.set(path, text);
          savedContents.current.set(path, text);
        } catch {
          // File may have been deleted/moved outside the app — leave the
          // tab showing whatever it last had rather than crashing.
        }
      }
      setRefreshToken((t) => t + 1);
    },
    [rootPath, openFiles]
  );

  // The files:refresh IPC listener is set up once (empty-deps effect,
  // above) but refreshWorkspace's identity changes whenever rootPath/
  // openFiles change — this ref lets that listener always call the latest
  // version instead of one closed over stale state.
  const refreshWorkspaceRef = useRef(refreshWorkspace);
  useEffect(() => {
    refreshWorkspaceRef.current = refreshWorkspace;
  }, [refreshWorkspace]);

  // Clickable file/line tags in the chat resolve project-relative paths
  // against the open root, so `src/foo.ts:42` in agent prose opens the file.
  const openFileAt = useCallback(
    async (relOrAbs: string, line?: number) => {
      if (!window.electronAPI || !rootPath) return;
      const isAbs = /^([a-zA-Z]:[\\/]|\/)/.test(relOrAbs);
      const full = isAbs ? relOrAbs : `${rootPath}/${relOrAbs}`.replace(/\\/g, '/');
      try {
        await openFile(full);
        if (line) setPendingLine({ path: full, line });
      } catch {
        // Path the agent mentioned does not exist locally — ignore rather
        // than throwing inside a click handler.
      }
    },
    [rootPath, openFile]
  );

  const toggleTerminal = useCallback(() => {
    setTerminalOpen((open) => !open);
  }, []);

  const toggleChat = useCallback(() => {
    setChatOpen((open) => !open);
  }, []);

  // Runs a command in the integrated terminal on the agent's behalf. If the
  // terminal panel isn't open yet, this opens it first — the short delay
  // gives TerminalPanel's mount effect time to spawn the pty (see
  // terminal:create) before we type into it. Good enough for a frontend
  // demo; a sturdier version would wait for an explicit "terminal ready"
  // signal instead of a fixed timeout.
  const runInTerminal = useCallback(
    (command: string) => {
      if (!window.electronAPI) return;
      const delay = terminalOpen ? 0 : 300;
      setTerminalOpen(true);
      setTimeout(() => {
        window.electronAPI!.terminalWrite(TERMINAL_ID, `${command}\r`);
      }, delay);
    },
    [terminalOpen]
  );

  const activeFile = openFiles.find((f) => f.path === activePath) || null;

  return (
    <div className="ide-shell">
      <aside className="sidebar">
        <FileTree
          rootPath={rootPath}
          rootEntries={rootEntries}
          activePath={activePath}
          refreshToken={refreshToken}
          onOpenFile={openFile}
          onOpenFolder={openFolder}
          onRefresh={() => refreshWorkspace()}
        />
      </aside>
      <main className="main-panel">
        <Tabs files={openFiles} activePath={activePath} onSelect={setActivePath} onClose={closeFile} />
        <div className="editor-container">
          {electronReady ? (
            <EditorPane
              filePath={activePath}
              content={activePath ? contents.current.get(activePath) ?? '' : ''}
              revealLine={pendingLine && pendingLine.path === activePath ? pendingLine.line : undefined}
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
        {electronReady && terminalOpen && (
          <TerminalPanel id={TERMINAL_ID} cwd={rootPath} onClose={() => setTerminalOpen(false)} />
        )}
        <StatusBar
          filePath={activePath}
          dirty={activeFile?.dirty ?? false}
          terminalOpen={terminalOpen}
          onToggleTerminal={electronReady ? toggleTerminal : undefined}
          chatOpen={chatOpen}
          onToggleChat={electronReady ? toggleChat : undefined}
          onOpenSettings={electronReady ? () => setSettingsOpen(true) : undefined}
          onOpenDashboard={electronReady ? () => setDashboardOpen(true) : undefined}
          taskCost={trace.status === 'running' ? trace.budget.costUsd : null}
          retrievalStatus={retrievalStatus}
        />
      </main>
      {electronReady && chatOpen && (
        <ChatPanel
          rootPath={rootPath}
          activeFilePath={activePath}
          activeFileContent={activePath ? contents.current.get(activePath) ?? null : null}
          trace={trace}
          onTraceEvent={handleTraceEvent}
          onClose={() => setChatOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenDashboard={() => setDashboardOpen(true)}
          onRunCommand={runInTerminal}
          onFileChanged={refreshWorkspace}
          onOpenFileAt={openFileAt}
        />
      )}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {dashboardOpen && <Dashboard live={trace} onClose={() => setDashboardOpen(false)} />}
    </div>
  );
}
