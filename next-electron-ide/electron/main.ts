import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from "electron";
import * as path from "path";
import * as fs from "fs/promises";
import { Dirent } from "fs";
import * as net from "net";
import * as crypto from "crypto";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as pty from "node-pty";
import {
  OrchestratorBridge,
  orchestratorScriptPath,
} from "./orchestrator-bridge";
import { checkModelHealth, HealthCheckRequest } from "./model-health";
import type { IPty } from "node-pty";

const isDev = process.env.NODE_ENV === "development";

let mainWindow: BrowserWindow | null = null;
let openFolderPath: string | null = null;
let stopFolderWatch: (() => void) | null = null;
let orchestrator: OrchestratorBridge | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#1e1e1e",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:3210");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer-out/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------- Code retrieval service (separate Python process) ----------
//
// Why a separate process instead of inline in the orchestrator: embeddings
// and tree-sitter parsing are easiest in Python; the IDE/orchestrator side
// is Node/TS for Electron IPC. Keeping them separate processes talking
// over localhost HTTP means the index survives independently of any single
// agent task (built once, reused across many orchestrator runs, updated
// incrementally by the folder watcher below) instead of being rebuilt
// every session. It also gives a clean isolation boundary: the Python
// service is the ONLY thing that touches the on-disk per-project indexes,
// and its API requires a codebase_id on every call — see
// retrieval-service/server.py and store.py for the enforcement side of
// that guarantee.
let retrievalProc: ChildProcessWithoutNullStreams | null = null;
let retrievalPort: number | null = null;
let retrievalReady = false;
let currentCodebaseId: string | null = null;

function codebaseIdFor(rootPath: string): string {
  return crypto
    .createHash("sha256")
    .update(rootPath)
    .digest("hex")
    .slice(0, 16);
}

function retrievalServiceDir(): string {
  // Dev: retrieval-service/ sits at the project root, sibling to electron/.
  // Packaged: copied in as an extraResource (see package.json's build.extraResources).
  return isDev
    ? path.join(__dirname, "..", "retrieval-service")
    : path.join(process.resourcesPath, "retrieval-service");
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function pythonExecutable(): string {
  return (
    process.env.NEXIDE_PYTHON ||
    (process.platform === "win32" ? "python" : "python3")
  );
}

async function startRetrievalService() {
  try {
    retrievalPort = await findFreePort();
  } catch (err) {
    console.log(
      "[retrieval] could not find a free port, retrieval disabled:",
      err,
    );
    mainWindow?.webContents.send("retrieval:status", {
      state: "unavailable",
      message: "could not allocate a local port",
    });
    return;
  }

  const serverScript = path.join(retrievalServiceDir(), "server.py");
  const dataDir = path.join(app.getPath("userData"), "retrieval-index");

  const proc = spawn(
    pythonExecutable(),
    [serverScript, "--port", String(retrievalPort), "--data-dir", dataDir],
    {
      cwd: retrievalServiceDir(),
    },
  );
  retrievalProc = proc;

  proc.stdout.on("data", (d) =>
    console.log(`[retrieval-service] ${d.toString().trim()}`),
  );
  proc.stderr.on("data", (d) =>
    console.log(`[retrieval-service] ${d.toString().trim()}`),
  );

  proc.on("error", (err) => {
    // Most common cause: no `python`/`python3` on PATH, or the
    // retrieval-service/requirements.txt deps aren't installed yet.
    console.log("[retrieval] failed to start retrieval service:", err);
    retrievalProc = null;
    mainWindow?.webContents.send("retrieval:status", {
      state: "unavailable",
      message:
        "Python retrieval service failed to start — see retrieval-service/README.md for setup.",
    });
  });

  proc.on("exit", (code) => {
    console.log(`[retrieval] service exited with code ${code}`);
    retrievalProc = null;
    retrievalReady = false;
  });

  // Poll /health instead of assuming the process is ready the instant it's
  // spawned — the Python process still has to import its dependencies
  // (tree-sitter grammars, fastembed) before it can bind the socket.
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 300));
    if (!retrievalProc) return; // died already, error event above already reported it
    try {
      const res = await fetch(`http://127.0.0.1:${retrievalPort}/health`);
      if (res.ok) {
        retrievalReady = true;
        mainWindow?.webContents.send("retrieval:status", { state: "idle" });
        console.log(retrievalPort, "retrievalPort");
        if (openFolderPath) indexCurrentFolder();
        return;
      }
    } catch {
      // not up yet, keep polling
    }
  }
  console.log("[retrieval] service did not become healthy in time");
}

function stopRetrievalService() {
  retrievalReady = false;
  if (retrievalProc) {
    try {
      retrievalProc.kill();
    } catch {
      // already gone
    }
    retrievalProc = null;
  }
}

async function retrievalRequest(pathName: string, body: unknown): Promise<any> {
  if (!retrievalReady || !retrievalPort) {
    return { error: "retrieval service is not available" };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${retrievalPort}${pathName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    return { error: `retrieval request failed: ${(err as Error).message}` };
  }
}

async function indexCurrentFolder() {
  if (!openFolderPath || !retrievalReady) return;
  const codebaseId = codebaseIdFor(openFolderPath);
  currentCodebaseId = codebaseId;
  mainWindow?.webContents.send("retrieval:status", {
    state: "indexing",
    codebaseId,
  });
  const result = await retrievalRequest("/index", {
    root_path: openFolderPath,
    codebase_id: codebaseId,
  });
  if (result?.error) {
    mainWindow?.webContents.send("retrieval:status", {
      state: "error",
      message: result.error,
    });
  } else {
    mainWindow?.webContents.send("retrieval:status", {
      state: "ready",
      codebaseId,
      ...result,
    });
  }
}

// ---------- Folder watching (auto-refresh file tree on terminal-created files) ----------
//
// There's no reliable way to detect "a file was created" by parsing terminal
// output (could be any shell, any command, aliases, scripts...), so instead
// we watch the currently-open folder directly with Node's built-in
// fs.watch({ recursive: true }) and reuse the exact same 'files:refresh' IPC
// channel the manual "Refresh Files" menu item / status-bar button already
// use — no renderer changes needed, and no new dependency (e.g. chokidar)
// pulled in just for this. The same watcher also feeds the retrieval
// service's incremental reindex (/update) with exactly the paths that
// changed, so a file created by a terminal command shows up in both the
// file tree AND becomes searchable without a manual "reindex" step.
//
// Cross-platform note: recursive watching is solid on Windows and macOS.
// On Linux it's version/filesystem-dependent (may silently not be
// recursive, or throw). Wrapped in try/catch so a failure there just means
// terminal-created files need a manual refresh on that platform, rather
// than crashing the app.
function watchFolder(folderPath: string) {
  stopFolderWatch?.();

  const controller = new AbortController();
  let debounceTimer: NodeJS.Timeout | null = null;
  let changedPaths = new Set<string>();

  const scheduleRefresh = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      mainWindow?.webContents.send("files:refresh");
      if (retrievalReady && currentCodebaseId && changedPaths.size > 0) {
        const paths = Array.from(changedPaths);
        changedPaths = new Set();
        retrievalRequest("/update", {
          codebase_id: currentCodebaseId,
          root_path: folderPath,
          changed_paths: paths,
        }).then((result) => {
          if (!result?.error) {
            mainWindow?.webContents.send("retrieval:status", {
              state: "ready",
              codebaseId: currentCodebaseId,
              ...result,
            });
          }
        });
      }
    }, 300);
  };

  (async () => {
    try {
      const watcher = fs.watch(folderPath, {
        recursive: true,
        signal: controller.signal,
      });
      for await (const event of watcher) {
        if (!event.filename) continue;
        const segments = event.filename.split(/[/\\]/);
        if (segments.includes("node_modules") || segments.includes(".git"))
          continue;
        changedPaths.add(event.filename.split(path.sep).join("/"));
        scheduleRefresh();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.name !== "AbortError") {
        console.log(`[watchFolder] stopped watching ${folderPath}:`, err);
      }
    }
  })();

  stopFolderWatch = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    controller.abort();
    stopFolderWatch = null;
  };
}

// ---------- Workspace persistence (last opened folder) ----------
//
// Kept in its own tiny file rather than folded into agent-settings.json:
// that file holds API keys and is what the user edits through the Settings
// screen, whereas this is incidental UI state the app rewrites on its own.
// Mixing them would mean every folder switch rewrites the file holding the
// user's keys, which is a needless way to lose them to a bad write.
type UiState = { lastFolder?: string };

function uiStateFilePath(): string {
  return path.join(app.getPath("userData"), "ui-state.json");
}

async function readUiState(): Promise<UiState> {
  try {
    return JSON.parse(await fs.readFile(uiStateFilePath(), "utf-8"));
  } catch {
    return {};
  }
}

async function writeUiState(patch: UiState): Promise<void> {
  try {
    const next = { ...(await readUiState()), ...patch };
    await fs.writeFile(uiStateFilePath(), JSON.stringify(next, null, 2), "utf-8");
  } catch (err) {
    // Failing to remember the folder must never block opening it.
    console.log("[ui-state] could not persist:", err);
  }
}

/**
 * Reopen the folder from the previous session. Validated before use: a
 * remembered path can have been deleted, renamed, or been on a drive that is
 * no longer mounted, and silently "opening" a folder that is not there would
 * leave the file tree, the watcher and the indexer all pointed at nothing.
 */
async function restoreLastFolder(): Promise<void> {
  const { lastFolder } = await readUiState();
  if (!lastFolder) return;
  try {
    const stat = await fs.stat(lastFolder);
    if (!stat.isDirectory()) return;
  } catch {
    console.log(`[ui-state] last folder is gone, not restoring: ${lastFolder}`);
    return;
  }
  setOpenFolder(lastFolder);
  mainWindow?.webContents.send("folder:opened", lastFolder);
}

function setOpenFolder(folderPath: string) {
  const previousCodebaseId = currentCodebaseId;
  openFolderPath = folderPath;
  void writeUiState({ lastFolder: folderPath });
  watchFolder(folderPath);

  if (retrievalReady) {
    // Evict the previous project's cached DB handle/embedding cache
    // before indexing the new one, so nothing from the old codebase
    // lingers in the service's memory. This is on top of — not instead
    // of — the server enforcing codebase_id on every call; it just keeps
    // the resident memory bounded to the project actually open.
    if (previousCodebaseId)
      retrievalRequest("/evict", { codebase_id: previousCodebaseId });
    indexCurrentFolder();
  }
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder…",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow!, {
              properties: ["openDirectory"],
            });
            if (!result.canceled && result.filePaths[0]) {
              setOpenFolder(result.filePaths[0]);
              mainWindow?.webContents.send("folder:opened", openFolderPath);
            }
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Refresh Files",
          accelerator: "CmdOrCtrl+R",
          // Deliberately NOT { role: 'reload' } — that reloads the whole
          // renderer (losing the open folder, tabs, chat session, terminal).
          // This just tells the renderer to re-read the file tree and any
          // open files from disk in place.
          click: () => mainWindow?.webContents.send("files:refresh"),
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: "Toggle Terminal",
          accelerator: "CmdOrCtrl+`",
          click: () => mainWindow?.webContents.send("terminal:toggle"),
        },
      ],
    },
    {
      label: "Agent",
      submenu: [
        {
          label: "Toggle AI Chat",
          accelerator: "CmdOrCtrl+L",
          click: () => mainWindow?.webContents.send("chat:toggle"),
        },
        {
          label: "Toggle Observability Dashboard",
          accelerator: "CmdOrCtrl+Shift+D",
          click: () => mainWindow?.webContents.send("dashboard:toggle"),
        },
        { type: "separator" },
        {
          label: "Agent Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => mainWindow?.webContents.send("settings:toggle"),
        },
        { type: "separator" },
        {
          label: "Reindex Codebase",
          click: () => {
            if (openFolderPath) indexCurrentFolder();
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC: filesystem ----------

type FileNode = {
  name: string;
  path: string;
  isDirectory: boolean;
};

ipcMain.handle("dialog:openFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  setOpenFolder(result.filePaths[0]);
  return openFolderPath;
});

// The renderer asks for this on mount rather than waiting for a
// 'folder:opened' push, because main may have restored the folder before the
// window finished loading — in which case that event already fired into a
// renderer that had no listener attached yet.
ipcMain.handle("folder:getCurrent", async () => openFolderPath);

ipcMain.handle(
  "fs:readDir",
  async (_evt, dirPath: string): Promise<FileNode[]> => {
    const entries: Dirent[] = await fs.readdir(dirPath, {
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.name !== ".git")
      .map((e) => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDirectory: e.isDirectory(),
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  },
);

ipcMain.handle(
  "fs:readFile",
  async (_evt, filePath: string): Promise<string> => {
    return fs.readFile(filePath, "utf-8");
  },
);

ipcMain.handle(
  "fs:writeFile",
  async (_evt, filePath: string, content: string): Promise<boolean> => {
    await fs.writeFile(filePath, content, "utf-8");
    return true;
  },
);

ipcMain.handle(
  "fs:createFile",
  async (_evt, filePath: string): Promise<boolean> => {
    await fs.writeFile(filePath, "", { flag: "wx" });
    return true;
  },
);

ipcMain.handle(
  "fs:createFolder",
  async (_evt, dirPath: string): Promise<boolean> => {
    await fs.mkdir(dirPath, { recursive: false });
    return true;
  },
);

ipcMain.handle(
  "fs:rename",
  async (_evt, oldPath: string, newPath: string): Promise<boolean> => {
    await fs.rename(oldPath, newPath);
    return true;
  },
);

ipcMain.handle(
  "fs:delete",
  async (_evt, targetPath: string): Promise<boolean> => {
    await fs.rm(targetPath, { recursive: true, force: true });
    return true;
  },
);

ipcMain.handle("shell:showItemInFolder", (_evt, targetPath: string) => {
  shell.showItemInFolder(targetPath);
});

// ---------- IPC: code retrieval ----------
//
// Both handlers are thin proxies into the Python service — see
// retrieval-service/retrieval.py for the actual recall/graph-expand/rerank
// pipeline. Renderer code never talks to the service directly; it always
// goes through here so codebase_id resolution stays centralized (the tool
// layer in src/lib/tools.ts never has to know or guess which project is
// open — main.ts already knows).

ipcMain.handle("retrieval:query", async (_evt, query: string, k?: number) => {
  if (!currentCodebaseId) return { results: [], error: "no folder open" };
  return retrievalRequest("/query", {
    codebase_id: currentCodebaseId,
    query,
    k: k ?? 8,
  });
});

ipcMain.handle(
  "retrieval:openFile",
  async (_evt, filePath: string, lineStart?: number, lineEnd?: number) => {
    if (!openFolderPath) return { error: "no folder open" };
    return retrievalRequest("/file", {
      root_path: openFolderPath,
      path: filePath,
      line_start: lineStart,
      line_end: lineEnd,
    });
  },
);

// ---------- IPC: integrated terminal (node-pty) ----------

type TerminalEntry = {
  proc: IPty;
  shellPath: string;
};

const terminals = new Map<string, TerminalEntry>();

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/bash";
}

ipcMain.handle("terminal:create", (_evt, id: string, cwd?: string): boolean => {
  if (terminals.has(id)) return true;

  const shellPath = defaultShell();
  const ptyProcess = pty.spawn(shellPath, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd:
      cwd ||
      openFolderPath ||
      process.env.HOME ||
      process.env.USERPROFILE ||
      process.cwd(),
    env: process.env as { [key: string]: string },
  });

  terminals.set(id, { proc: ptyProcess, shellPath });
  console.log(
    `[terminal:create] id=${id} shell=${shellPath} cwd=${
      cwd ||
      openFolderPath ||
      process.env.HOME ||
      process.env.USERPROFILE ||
      process.cwd()
    }`,
  );

  ptyProcess.onData((data) => {
    mainWindow?.webContents.send("terminal:data", id, data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    mainWindow?.webContents.send("terminal:exit", id, exitCode);
    terminals.delete(id);
  });

  return true;
});

ipcMain.handle("terminal:write", (_evt, id: string, data: string) => {
  terminals.get(id)?.proc.write(data);
});

ipcMain.handle(
  "terminal:resize",
  (_evt, id: string, cols: number, rows: number) => {
    const cleanCols = Math.max(1, Math.floor(cols) || 80);
    const cleanRows = Math.max(1, Math.floor(rows) || 24);
    terminals.get(id)?.proc.resize(cleanCols, cleanRows);
  },
);

ipcMain.handle("terminal:kill", (_evt, id: string) => {
  terminals.get(id)?.proc.kill();
  terminals.delete(id);
});

// There is no OS-level way to change another process's working directory
// from the outside, so when a folder is opened while a terminal is already
// running, we "type" a cd command into its shell instead — the same thing a
// person would do by hand. No-ops if that terminal id isn't currently
// running (e.g. the terminal panel is closed).
ipcMain.handle("terminal:changeDir", (_evt, id: string, dirPath: string) => {
  const term = terminals.get(id);
  if (!term || !dirPath) {
    console.log(
      `[terminal:changeDir] id=${id} dirPath=${dirPath} -> skipped (` +
        `${!term ? "no running terminal with this id" : "no dirPath"})`,
    );
    return;
  }

  const shellName = path.basename(term.shellPath).toLowerCase();
  const quoted = `"${dirPath}"`;
  let command: string;
  if (shellName.startsWith("cmd")) {
    // plain `cd` on cmd.exe won't follow a drive-letter change
    command = `cd /d ${quoted}`;
  } else if (
    shellName.startsWith("powershell") ||
    shellName.startsWith("pwsh")
  ) {
    command = `Set-Location ${quoted}`;
  } else {
    command = `cd ${quoted}`;
  }
  console.log(`[terminal:changeDir] id=${id} shell=${shellName} -> ${command}`);
  term.proc.write(`${command}\r`);
});

// ---------- IPC: agent settings (API keys / env vars) ----------
//
// Frontend-only for now: this just persists whatever the Settings panel
// collects to a JSON file in Electron's per-user app data directory (NOT
// inside the project repo, so it's never accidentally committed). The real
// multi-agent implementation (src/lib/agent.ts) is expected to read these
// values — see the comment at the top of that file for the intended wiring.

// ---------- IPC: orchestrator ----------
// The renderer never talks to the orchestrator child directly — it has no
// process access at all. Everything crosses here, which is also where the
// task's config (project root, retrieval URL, API keys, model roster) is
// assembled, so the renderer never has to know or hold any of it.

async function readAgentSettings(): Promise<AgentSettings> {
  try {
    const raw = await fs.readFile(
      path.join(app.getPath("userData"), "agent-settings.json"),
      "utf-8",
    );
    return { ...DEFAULT_AGENT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
}

async function buildTaskConfig() {
  const settings = await readAgentSettings();
  return {
    rootPath: openFolderPath ?? process.cwd(),
    codebaseId: openFolderPath ? codebaseIdFor(openFolderPath) : "no-folder",
    retrievalUrl:
      retrievalReady && retrievalPort
        ? `http://127.0.0.1:${retrievalPort}`
        : null,
    env: settings.envVars,
    enabledModelIds: settings.enabledModelIds,
    maxCostUsd: settings.maxCostUsd,
    maxSeconds: settings.maxSeconds,
  };
}

ipcMain.handle(
  "orchestrator:startTask",
  async (_evt, taskId: string, prompt: string) => {
    if (!orchestrator?.isReady())
      throw new Error("Orchestrator is not running.");
    if (!openFolderPath)
      throw new Error("Open a project folder first (File -> Open Folder).");
    return orchestrator.startTask(taskId, prompt, await buildTaskConfig());
  },
);

ipcMain.handle("orchestrator:resumeTask", async (_evt, taskId: string) => {
  if (!orchestrator?.isReady()) throw new Error("Orchestrator is not running.");
  return orchestrator.resumeTask(taskId, await buildTaskConfig());
});

ipcMain.handle("orchestrator:cancelTask", async (_evt, taskId: string) => {
  return orchestrator?.cancelTask(taskId);
});

ipcMain.handle("orchestrator:approve", async (_evt, decision: unknown) => {
  return orchestrator?.respondToApproval(decision);
});

ipcMain.handle("orchestrator:isolatedQuery", async (_evt, question: string) => {
  if (!orchestrator?.isReady()) throw new Error("Orchestrator is not running.");
  return orchestrator.isolatedQuery(question, await buildTaskConfig());
});

ipcMain.handle(
  "orchestrator:isReady",
  async () => orchestrator?.isReady() ?? false,
);

// Post-hoc inspection: replay a finished task's event log from disk. This is
// what makes the dashboard "equally usable after the task finished" — it is
// the same event stream the live view consumed, just read back.
ipcMain.handle("orchestrator:listTasks", async () => {
  if (!openFolderPath) return [];
  const base = path.join(
    app.getPath("userData"),
    "tasks",
    codebaseIdFor(openFolderPath),
  );
  try {
    const ids = await fs.readdir(base);
    const out = [];
    for (const id of ids) {
      try {
        out.push(
          JSON.parse(
            await fs.readFile(path.join(base, id, "state.json"), "utf-8"),
          ),
        );
      } catch {
        // no readable snapshot — crashed before its first checkpoint
      }
    }
    return out.sort((a: any, b: any) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
});

ipcMain.handle("orchestrator:readTaskEvents", async (_evt, taskId: string) => {
  if (!openFolderPath) return [];
  const p = path.join(
    app.getPath("userData"),
    "tasks",
    codebaseIdFor(openFolderPath),
    taskId,
    "events.jsonl",
  );
  try {
    const raw = await fs.readFile(p, "utf-8");
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // torn final line from a crash; everything before it is intact
      }
    }
    return out;
  } catch {
    return [];
  }
});

type AgentSettings = {
  envVars: Record<string, string>;
  /** Model ids (see orchestrator/models.ts) the user has enabled for routing. */
  enabledModelIds: string[];
  /** Per-task hard ceilings. Defaults match the PS's evaluation limits. */
  maxCostUsd: number;
  maxSeconds: number;
};

const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  envVars: {},
  enabledModelIds: [],
  maxCostUsd: 0.5,
  maxSeconds: 2700,
};

function settingsFilePath(): string {
  return path.join(app.getPath("userData"), "agent-settings.json");
}

ipcMain.handle("settings:get", async (): Promise<AgentSettings> => {
  try {
    const raw = await fs.readFile(settingsFilePath(), "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_AGENT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
});

ipcMain.handle(
  "settings:set",
  async (_evt, settings: AgentSettings): Promise<boolean> => {
    const target = settingsFilePath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(settings, null, 2), "utf-8");
    return true;
  },
);

/**
 * Probe the providers behind the given models and report each one's health.
 *
 * The renderer supplies the models to check rather than this process reading
 * the registry, because electron/tsconfig.json pins `rootDir` to this folder
 * and so cannot import orchestrator/models.ts. The renderer already holds the
 * registry, and the payload is inert data.
 *
 * Never throws: a settings screen that cannot render because a health check
 * failed is strictly worse than one showing "offline".
 */
ipcMain.handle(
  "models:checkHealth",
  async (_evt, req: HealthCheckRequest) => {
    try {
      return await checkModelHealth(req);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const out: Record<string, { state: string; detail: string; checkedAt: number }> = {};
      for (const m of req?.models ?? []) {
        out[m.id] = { state: "offline", detail: `Health check failed: ${detail}`, checkedAt: Date.now() };
      }
      return out;
    }
  },
);

function killAllTerminals() {
  for (const [id, term] of terminals) {
    try {
      term.proc.kill();
    } catch {
      // already gone
    }
    terminals.delete(id);
  }
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  void restoreLastFolder();
  startRetrievalService();

  orchestrator = new OrchestratorBridge(
    orchestratorScriptPath(isDev),
    app.getPath("userData"),
    () => mainWindow,
  );
  orchestrator.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  killAllTerminals();
  stopFolderWatch?.();
  stopRetrievalService();
  orchestrator?.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  killAllTerminals();
  stopFolderWatch?.();
  stopRetrievalService();
  orchestrator?.stop();
});
