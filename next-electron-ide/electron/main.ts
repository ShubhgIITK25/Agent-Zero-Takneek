import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Dirent } from 'fs';

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

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
