export type FileNode = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export type AgentSettings = {
  envVars: Record<string, string>;
};

export type RetrievalMatch = {
  file: string;
  symbol: string;
  kind: string;
  line_start: number;
  line_end: number;
  snippet: string;
  why_relevant: string;
  score: number;
};

export type RetrievalQueryResult = {
  results: RetrievalMatch[];
  candidates_considered?: number;
  vector_search?: boolean;
  reranked?: boolean;
  error?: string;
};

export type RetrievalFileResult = {
  path: string;
  line_start: number;
  line_end: number;
  content: string;
  error?: string;
};

export type RetrievalStatus = {
  state: 'idle' | 'indexing' | 'ready' | 'error' | 'unavailable';
  codebaseId?: string;
  message?: string;
  files_indexed?: number;
  chunks_indexed?: number;
  files_updated?: number;
  chunks_updated?: number;
  vector_search?: boolean;
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
  terminalChangeDir: (id: string, dirPath: string) => Promise<void>;
  onTerminalData: (cb: (id: string, data: string) => void) => () => void;
  onTerminalExit: (cb: (id: string, exitCode: number) => void) => () => void;
  onTerminalToggle: (cb: () => void) => () => void;

  // ---- agent settings (API keys / env vars) ----
  settingsGet: () => Promise<AgentSettings>;
  settingsSet: (settings: AgentSettings) => Promise<boolean>;
  onChatToggle: (cb: () => void) => () => void;
  onSettingsToggle: (cb: () => void) => () => void;
  onFilesRefresh: (cb: () => void) => () => void;

  // ---- code retrieval ----
  retrievalQuery: (query: string, k?: number) => Promise<RetrievalQueryResult>;
  retrievalOpenFile: (path: string, lineStart?: number, lineEnd?: number) => Promise<RetrievalFileResult>;
  onRetrievalStatus: (cb: (status: RetrievalStatus) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
