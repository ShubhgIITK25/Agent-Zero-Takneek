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
import type { ReviewDiff } from '../lib/review-buffer';
import { TraceView, TraceEvent, applyEvent, emptyTrace } from '../lib/trace';

// Monaco touches `self`/`window` at module load time, so it must never be
// evaluated during SSR/static export - load it only on the client.
const EditorPane = dynamic(() => import('../components/EditorPane'), { ssr: false });
// xterm.js has the same constraint (touches `window`/`navigator` at import time).
const TerminalPanel = dynamic(() => import('../components/TerminalPanel'), { ssr: false });
// The inline diff review renders its own Monaco instance, so it is bound by
// exactly the same rule as EditorPane above.
const DiffReviewPane = dynamic(() => import('../components/DiffReviewPane'), { ssr: false });

const TERMINAL_ID = 'main-terminal';

export default function Home() {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [rootEntries, setRootEntries] = useState<FileNode[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const contents = useRef<Map<string, string>>(new Map());
  const savedContents = useRef<Map<string, string>>(new Map());
  const autoSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [electronReady, setElectronReady] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [pendingLine, setPendingLine] = useState<{ path: string; line: number } | null>(null);
  const [retrievalStatus, setRetrievalStatus] = useState<RetrievalStatus | null>(null);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  // The live trace lives here, not in ChatPanel, so the dashboard keeps
  // rendering a running task even when the chat panel is closed.
  const [trace, setTrace] = useState<TraceView>(emptyTrace);
  // A pending diff approval is IDE-level state, not chat state: the review
  // surface is the editor, and the orchestrator stays blocked until it is
  // answered, so it must survive the chat panel being closed.
  const [pendingDiff, setPendingDiff] = useState<{
    requestId: string;
    summary: string;
    diffs: ReviewDiff[];
  } | null>(null);

  const retryRetrieval = useCallback(async () => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.retrievalReindex();
    if (result.error) {
      setRetrievalStatus({ state: 'error', message: result.error });
    }
  }, []);

  const cancelRetrieval = useCallback(async () => {
    if (!window.electronAPI) return;
    setRetrievalStatus((previous) =>
      previous ? { ...previous, state: 'cancelling' } : previous,
    );
    const result = await window.electronAPI.retrievalCancelIndex();
    if (result.error) {
      setRetrievalStatus((previous) =>
        previous ? { ...previous, state: 'error', message: result.error } : previous,
      );
    }
  }, []);

  const handleTraceEvent = useCallback((e: TraceEvent) => {
    setTrace((prev) => applyEvent(e.type === 'task_started' ? emptyTrace() : prev, e));

    if (e.type === 'approval_request' && e.request?.kind === 'diff' && e.request.diff?.length) {
      setPendingDiff({
        requestId: e.request.requestId,
        summary: e.request.summary,
        diffs: e.request.diff,
      });
    }
    // Clear on the orchestrator's own resolution too, not just ours - an
    // approval answered from anywhere must not leave a dead pane holding the
    // editor hostage.
    if (e.type === 'approval_resolved') {
      setPendingDiff((prev) => (prev && prev.requestId === e.requestId ? null : prev));
    }
    if (e.type === 'task_finished' || e.type === 'task_failed' || e.type === 'task_cancelled') {
      setPendingDiff(null);
    }
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
    
    if (typeof window !== 'undefined') {
      const savedChat = localStorage.getItem('codenawabs-chat-open') ?? localStorage.getItem('nexide-chat-open');
      if (savedChat !== null) setChatOpen(savedChat === 'true');
      const savedTerminal = localStorage.getItem('codenawabs-terminal-open') ?? localStorage.getItem('nexide-terminal-open');
      if (savedTerminal !== null) setTerminalOpen(savedTerminal === 'true');
    }

    // Main may have restored a folder before this window finished loading, so
    // its 'folder:opened' push landed with nobody listening - ask directly.
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
    // Recover the current state if main emitted it before this renderer
    // finished mounting (common after reopening during an index).
    void window.electronAPI?.retrievalGetStatus().then((status) => {
      if (status) setRetrievalStatus(status);
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
      const name = path.split(/[\\/]/).pop() || path;
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
      const timer = autoSaveTimers.current.get(path);
      if (timer) clearTimeout(timer);
      autoSaveTimers.current.delete(path);
      contents.current.delete(path);
      savedContents.current.delete(path);
    },
    [activePath]
  );

  const saveFile = useCallback(async (path: string) => {
    if (!window.electronAPI) return;
    const value = contents.current.get(path);
    if (value === undefined || savedContents.current.get(path) === value) return;
    try {
      await window.electronAPI.writeFile(path, value);
      // A later edit may have arrived while the write was in flight. In that
      // case leave the tab dirty; its own debounce timer will save it next.
      if (contents.current.get(path) !== value) return;
      savedContents.current.set(path, value);
      setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, dirty: false } : f)));
    } catch (error) {
      console.error(`Could not save ${path}:`, error);
    }
  }, []);

  const updateContent = useCallback(
    (path: string, value: string) => {
      contents.current.set(path, value);
      const isDirty = savedContents.current.get(path) !== value;
      setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, dirty: isDirty } : f)));

      const existingTimer = autoSaveTimers.current.get(path);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        autoSaveTimers.current.delete(path);
        void saveFile(path);
      }, 700);
      autoSaveTimers.current.set(path, timer);
    },
    [saveFile]
  );

  const saveActiveFile = useCallback(async () => {
    if (activePath) await saveFile(activePath);
  }, [activePath, saveFile]);

  // Re-reads the file tree from disk, and reloads any open, non-dirty
  // file's content from disk (never clobbers unsaved edits). Pass a
  // specific path to only reload that one file - used when the agent's
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
          // File may have been deleted/moved outside the app - leave the
          // tab showing whatever it last had rather than crashing.
        }
      }
      setRefreshToken((t) => t + 1);
    },
    [rootPath, openFiles]
  );

  const saveActiveFileAs = useCallback(async () => {
    if (!window.electronAPI || !activePath) return;
    const currentValue = contents.current.get(activePath);
    if (currentValue === undefined) return;

    const newPath = await window.electronAPI.saveFileAs(activePath);
    if (!newPath) return;
    if (newPath === activePath) {
      await saveActiveFile();
      return;
    }

    await window.electronAPI.writeFile(newPath, currentValue);
    contents.current.set(newPath, currentValue);
    savedContents.current.set(newPath, currentValue);
    setOpenFiles((prev) => {
      const existing = prev.find((f) => f.path === newPath);
      if (existing) {
        return prev.map((f) => (f.path === newPath ? { ...f, dirty: false } : f));
      }
      return [
        ...prev,
        {
          path: newPath,
          name: newPath.split(/[\\/]/).pop() || newPath,
          dirty: false,
        },
      ];
    });
    setActivePath(newPath);
    void refreshWorkspace(newPath);
  }, [activePath, refreshWorkspace, saveActiveFile]);

  useEffect(() => {
    if (!window.electronAPI) {
      return () => {
        for (const timer of autoSaveTimers.current.values()) clearTimeout(timer);
      };
    }

    const offSave = window.electronAPI.onFileSave(() => {
      void saveActiveFile();
    });
    const offSaveAs = window.electronAPI.onFileSaveAs(() => {
      void saveActiveFileAs();
    });

    return () => {
      offSave();
      offSaveAs();
      for (const timer of autoSaveTimers.current.values()) clearTimeout(timer);
    };
  }, [saveActiveFile, saveActiveFileAs]);

  // The files:refresh IPC listener is set up once (empty-deps effect,
  // above) but refreshWorkspace's identity changes whenever rootPath/
  // openFiles change - this ref lets that listener always call the latest
  // version instead of one closed over stale state.
  const refreshWorkspaceRef = useRef(refreshWorkspace);
  useEffect(() => {
    refreshWorkspaceRef.current = refreshWorkspace;
  }, [refreshWorkspace]);

  // The chat panel is deliberately mountable/unmountable, but the task stream
  // is not. Keep consuming events here so closing chat cannot stop the trace,
  // lose a pending approval, or make the editor miss an agent-written file.
  useEffect(() => {
    const off = window.electronAPI?.onOrchestratorEvent((e: TraceEvent) => {
      handleTraceEvent(e);

      if (e.type === 'approval_request' && e.request && typeof window !== 'undefined' && (localStorage.getItem('codenawabs-auto-approve') ?? localStorage.getItem('nexide-auto-approve')) !== 'false') {
        const acceptedBlockIds = Array.isArray(e.request.diff)
          ? e.request.diff.flatMap((d: { blocks?: { id: string }[] }) => (d.blocks ?? []).map((b) => b.id))
          : [];
        void window.electronAPI?.orchestratorApprove({
          requestId: e.request.requestId,
          approved: true,
          acceptedBlockIds,
        });
      }

      if (e.type === 'task_finished') {
        void refreshWorkspaceRef.current();
      }
    });
    return () => off?.();
  }, [handleTraceEvent]);

  // Answers the approval the orchestrator is blocked on. Returns false when
  // the decision could not be delivered so the pane can re-enable its buttons
  // and let the user retry, rather than the task hanging with a dead UI.
  const decidePendingDiff = useCallback(
    async (approved: boolean, acceptedBlockIds: string[]): Promise<boolean> => {
      if (!pendingDiff) return false;
      try {
        await window.electronAPI?.orchestratorApprove({
          requestId: pendingDiff.requestId,
          approved,
          acceptedBlockIds,
        });
      } catch (error) {
        console.error('Could not deliver the approval decision:', error);
        return false;
      }
      setPendingDiff(null);
      // Accepted hunks are written by the orchestrator right after this
      // returns, so re-read the files it touched to show what actually landed.
      if (approved) {
        for (const d of pendingDiff.diffs) {
          const full = `${rootPath ?? ''}/${d.path}`.replace(/\\/g, '/');
          void refreshWorkspaceRef.current(full);
        }
      }
      return true;
    },
    [pendingDiff, rootPath]
  );

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
        // Path the agent mentioned does not exist locally - ignore rather
        // than throwing inside a click handler.
      }
    },
    [rootPath, openFile]
  );

  const toggleTerminal = useCallback(() => {
    setTerminalOpen((open) => {
      const next = !open;
      if (typeof window !== 'undefined') localStorage.setItem('codenawabs-terminal-open', String(next));
      return next;
    });
  }, []);

  const toggleChat = useCallback(() => {
    setChatOpen((open) => {
      const next = !open;
      if (typeof window !== 'undefined') localStorage.setItem('codenawabs-chat-open', String(next));
      return next;
    });
  }, []);

  // Runs a command in the integrated terminal on the agent's behalf. If the
  // terminal panel isn't open yet, this opens it first - the short delay
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
          {pendingDiff ? (
            <DiffReviewPane
              key={pendingDiff.requestId}
              summary={pendingDiff.summary}
              diffs={pendingDiff.diffs}
              onDecide={decidePendingDiff}
            />
          ) : electronReady ? (
            <EditorPane
              filePath={activePath}
              content={activePath ? contents.current.get(activePath) ?? '' : ''}
              revealLine={pendingLine && pendingLine.path === activePath ? pendingLine.line : undefined}
              onChange={(value) => activePath && updateContent(activePath, value)}
              onSave={saveActiveFile}
              onSaveAs={saveActiveFileAs}
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
          onRetryRetrieval={electronReady ? retryRetrieval : undefined}
          onCancelRetrieval={electronReady ? cancelRetrieval : undefined}
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
          onOpenFileAt={openFileAt}
        />
      )}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {dashboardOpen && (
        <Dashboard
          live={trace}
          onClose={() => setDashboardOpen(false)}
          onWorkspaceChanged={() => { void refreshWorkspace(); }}
        />
      )}
    </div>
  );
}
