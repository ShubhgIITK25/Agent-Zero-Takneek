import { contextBridge, ipcRenderer } from 'electron';

export type FileNode = {
  name: string;
  path: string;
  isDirectory: boolean;
};

const api = {
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
  onFolderOpened: (cb: (folderPath: string) => void) => {
    const listener = (_evt: unknown, folderPath: string) => cb(folderPath);
    ipcRenderer.on('folder:opened', listener);
    return () => ipcRenderer.removeListener('folder:opened', listener);
  },
  readDir: (dirPath: string): Promise<FileNode[]> => ipcRenderer.invoke('fs:readDir', dirPath),
  readFile: (filePath: string): Promise<string> => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke('fs:writeFile', filePath, content),
  createFile: (filePath: string): Promise<boolean> => ipcRenderer.invoke('fs:createFile', filePath),
  createFolder: (dirPath: string): Promise<boolean> => ipcRenderer.invoke('fs:createFolder', dirPath),
  rename: (oldPath: string, newPath: string): Promise<boolean> =>
    ipcRenderer.invoke('fs:rename', oldPath, newPath),
  deletePath: (targetPath: string): Promise<boolean> => ipcRenderer.invoke('fs:delete', targetPath),
  showItemInFolder: (targetPath: string) => ipcRenderer.invoke('shell:showItemInFolder', targetPath),
};

export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld('electronAPI', api);
