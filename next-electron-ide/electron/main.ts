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
        { role: 'reload' },
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

const terminals = new Map<string, IPty>();

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

  terminals.set(id, ptyProcess);

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
  terminals.get(id)?.write(data);
});

ipcMain.handle('terminal:resize', (_evt, id: string, cols: number, rows: number) => {
  const cleanCols = Math.max(1, Math.floor(cols) || 80);
  const cleanRows = Math.max(1, Math.floor(rows) || 24);
  terminals.get(id)?.resize(cleanCols, cleanRows);
});

ipcMain.handle('terminal:kill', (_evt, id: string) => {
  terminals.get(id)?.kill();
  terminals.delete(id);
});

function killAllTerminals() {
  for (const [id, term] of terminals) {
    try {
      term.kill();
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
