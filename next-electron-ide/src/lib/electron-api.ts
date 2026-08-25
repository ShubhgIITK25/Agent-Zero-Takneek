export type FileNode = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export interface ElectronAPI {
  openFolder: () => Promise<string | null>;
  onFolderOpened: (cb: (folderPath: string) => void) => () => void;
  readDir: (dirPath: string) => Promise<FileNode[]>;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<boolean>;
  createFile: (filePath: string) => Promise<boolean>;
  createFolder: (dirPath: string) => Promise<boolean>;
  rename: (oldPath: string, newPath: string) => Promise<boolean>;
  deletePath: (targetPath: string) => Promise<boolean>;
  showItemInFolder: (targetPath: string) => Promise<void>;

  // ---- integrated terminal ----
  terminalCreate: (id: string, cwd?: string) => Promise<boolean>;
  terminalWrite: (id: string, data: string) => Promise<void>;
  terminalResize: (id: string, cols: number, rows: number) => Promise<void>;
  terminalKill: (id: string) => Promise<void>;
  onTerminalData: (cb: (id: string, data: string) => void) => () => void;
  onTerminalExit: (cb: (id: string, exitCode: number) => void) => () => void;
  onTerminalToggle: (cb: () => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
