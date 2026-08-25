import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Dirent } from 'fs';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

const isDev = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;
let openFolderPath: string | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1e1e1e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:3210');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer-out/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow!, {
              properties: ['openDirectory'],
            });
            if (!result.canceled && result.filePaths[0]) {
              openFolderPath = result.filePaths[0];
              mainWindow?.webContents.send('folder:opened', openFolderPath);
            }
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Refresh Files',
          accelerator: 'CmdOrCtrl+R',
          // Deliberately NOT { role: 'reload' } — that reloads the whole
          // renderer (losing the open folder, tabs, chat session, terminal).
          // This just tells the renderer to re-read the file tree and any
          // open files from disk in place.
          click: () => mainWindow?.webContents.send('files:refresh'),
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Toggle Terminal',
          accelerator: 'CmdOrCtrl+`',
          click: () => mainWindow?.webContents.send('terminal:toggle'),
        },
      ],
    },
    {
      label: 'Agent',
      submenu: [
        {
          label: 'Toggle AI Chat',
          accelerator: 'CmdOrCtrl+L',
          click: () => mainWindow?.webContents.send('chat:toggle'),
        },
        { type: 'separator' },
        {
          label: 'Agent Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('settings:toggle'),
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

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  openFolderPath = result.filePaths[0];
  return openFolderPath;
});

ipcMain.handle('fs:readDir', async (_evt, dirPath: string): Promise<FileNode[]> => {
  const entries: Dirent[] = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
    .map((e) => ({
      name: e.name,
      path: path.join(dirPath, e.name),
      isDirectory: e.isDirectory(),
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
});

ipcMain.handle('fs:readFile', async (_evt, filePath: string): Promise<string> => {
  return fs.readFile(filePath, 'utf-8');
});

ipcMain.handle('fs:writeFile', async (_evt, filePath: string, content: string): Promise<boolean> => {
  await fs.writeFile(filePath, content, 'utf-8');
  return true;
});

ipcMain.handle('fs:createFile', async (_evt, filePath: string): Promise<boolean> => {
  await fs.writeFile(filePath, '', { flag: 'wx' });
  return true;
});

ipcMain.handle('fs:createFolder', async (_evt, dirPath: string): Promise<boolean> => {
  await fs.mkdir(dirPath, { recursive: false });
  return true;
});

ipcMain.handle('fs:rename', async (_evt, oldPath: string, newPath: string): Promise<boolean> => {
  await fs.rename(oldPath, newPath);
  return true;
});

ipcMain.handle('fs:delete', async (_evt, targetPath: string): Promise<boolean> => {
  await fs.rm(targetPath, { recursive: true, force: true });
  return true;
});

ipcMain.handle('shell:showItemInFolder', (_evt, targetPath: string) => {
  shell.showItemInFolder(targetPath);
});

// ---------- IPC: integrated terminal (node-pty) ----------

type TerminalEntry = {
  proc: IPty;
  shellPath: string;
};

const terminals = new Map<string, TerminalEntry>();

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

ipcMain.handle('terminal:create', (_evt, id: string, cwd?: string): boolean => {
  if (terminals.has(id)) return true;

  const shellPath = defaultShell();
  const ptyProcess = pty.spawn(shellPath, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd || openFolderPath || process.env.HOME || process.env.USERPROFILE || process.cwd(),
    env: process.env as { [key: string]: string },
  });

  terminals.set(id, { proc: ptyProcess, shellPath });
  console.log(`[terminal:create] id=${id} shell=${shellPath} cwd=${
    cwd || openFolderPath || process.env.HOME || process.env.USERPROFILE || process.cwd()
  }`);

  ptyProcess.onData((data) => {
    mainWindow?.webContents.send('terminal:data', id, data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    mainWindow?.webContents.send('terminal:exit', id, exitCode);
    terminals.delete(id);
  });

  return true;
});

ipcMain.handle('terminal:write', (_evt, id: string, data: string) => {
  terminals.get(id)?.proc.write(data);
});

ipcMain.handle('terminal:resize', (_evt, id: string, cols: number, rows: number) => {
  const cleanCols = Math.max(1, Math.floor(cols) || 80);
  const cleanRows = Math.max(1, Math.floor(rows) || 24);
  terminals.get(id)?.proc.resize(cleanCols, cleanRows);
});

ipcMain.handle('terminal:kill', (_evt, id: string) => {
  terminals.get(id)?.proc.kill();
  terminals.delete(id);
});

// There is no OS-level way to change another process's working directory
// from the outside, so when a folder is opened while a terminal is already
// running, we "type" a cd command into its shell instead — the same thing a
// person would do by hand. No-ops if that terminal id isn't currently
// running (e.g. the terminal panel is closed).
ipcMain.handle('terminal:changeDir', (_evt, id: string, dirPath: string) => {
  const term = terminals.get(id);
  if (!term || !dirPath) {
    console.log(
      `[terminal:changeDir] id=${id} dirPath=${dirPath} -> skipped (` +
        `${!term ? 'no running terminal with this id' : 'no dirPath'})`
    );
    return;
  }

  const shellName = path.basename(term.shellPath).toLowerCase();
  const quoted = `"${dirPath}"`;
  let command: string;
  if (shellName.startsWith('cmd')) {
    // plain `cd` on cmd.exe won't follow a drive-letter change
    command = `cd /d ${quoted}`;
  } else if (shellName.startsWith('powershell') || shellName.startsWith('pwsh')) {
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

type AgentSettings = {
  envVars: Record<string, string>;
};

const DEFAULT_AGENT_SETTINGS: AgentSettings = { envVars: {} };

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'agent-settings.json');
}

ipcMain.handle('settings:get', async (): Promise<AgentSettings> => {
  try {
    const raw = await fs.readFile(settingsFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return { envVars: {}, ...parsed };
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
});

ipcMain.handle('settings:set', async (_evt, settings: AgentSettings): Promise<boolean> => {
  const target = settingsFilePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(settings, null, 2), 'utf-8');
  return true;
});

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  killAllTerminals();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  killAllTerminals();
});
