export type FileNode = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export type AgentSettings = {
  envVars: Record<string, string>;
  /** Model ids from orchestrator/models.ts the user enabled for routing. */
  enabledModelIds: string[];
  coreModelId?: string;
  /** User-added models; the curated list remains available as suggestions. */
  customModels: CustomModel[];
  maxCostUsd: number;
  maxSeconds: number;
  /** Minimum quality score accepted for custom verifier models. */
  minVerifierQuality: number;
  /** Independent subtasks to run at once. 1 = strictly sequential. */
  maxParallelSubtasks: number;
};

export type CustomModel = {
  id: string;
  apiId: string;
  label: string;
  provider: 'groq' | 'openrouter' | 'ollama' | 'gemini';
  paramsBTotal: number;
  contextWindow: number;
  /** User-declared 0-100 quality estimate used by the router. */
  qualityIndex?: number;
  pricing: { inputPerM: number; outputPerM: number };
  tier: 'free' | 'payg' | 'local';
  good_at: ('planning' | 'codegen' | 'analysis' | 'simple' | 'verification')[];
  speed: 'fast' | 'medium' | 'slow';
};

/**
 * Whether a model is actually callable right now - a different question from
 * whether it is *eligible* (≤80B total params), which is what the roster
 * already showed. Computed in the main process; see electron/model-health.ts,
 * which holds the authoritative copy of this union (electron/ pins `rootDir`
 * and so cannot import from here). Keep the two in step.
 */
export type ModelHealthState =
  | 'working'
  | 'invalid-key'
  | 'rate-limited'
  | 'unavailable'
  | 'offline'
  | 'unknown';

export type ModelHealth = {
  state: ModelHealthState;
  detail: string;
  checkedAt: number;
};

export type OrchestratorStatus = {
  state: 'ready' | 'restarting' | 'unavailable';
  message?: string;
};

export type IsolatedQueryResult = {
  answer: string;
  modelId: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
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
  /**
   * The retrieval service is up but running without part of its pipeline -
   * almost always because it was spawned with a Python that lacks
   * tree-sitter / fastembed / sqlite-vec. Retrieval still works (BM25 over
   * line-window chunks) but returns worse results, so the status bar says so.
   */
  degraded?: boolean;
};

export interface ElectronAPI {
  openFolder: () => Promise<string | null>;
  /** Folder main already has open (restored from the last session), or null. */
  getCurrentFolder: () => Promise<string | null>;
  onFolderOpened: (cb: (folderPath: string) => void) => () => void;
  readDir: (dirPath: string) => Promise<FileNode[]>;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<boolean>;
  saveFileAs: (defaultPath?: string) => Promise<string | null>;
  onFileSave: (cb: () => void) => () => void;
  onFileSaveAs: (cb: () => void) => () => void;
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
  modelsCheckHealth: (req: {
    models: { id: string; apiId: string; provider: string }[];
    envVars: Record<string, string>;
  }) => Promise<Record<string, ModelHealth>>;
  onChatToggle: (cb: () => void) => () => void;
  onSettingsToggle: (cb: () => void) => () => void;
  onFilesRefresh: (cb: () => void) => () => void;

  // ---- orchestrator ----
  orchestratorStartTask: (taskId: string, prompt: string) => Promise<unknown>;
  orchestratorResumeTask: (taskId: string) => Promise<unknown>;
  orchestratorRevertLatest: (taskId: string) => Promise<{ changeId: string; path: string }>;
  orchestratorCancelTask: (taskId: string) => Promise<unknown>;
  orchestratorApprove: (decision: {
    requestId: string;
    approved: boolean;
    acceptedBlockIds?: string[];
  }) => Promise<unknown>;
  orchestratorIsolatedQuery: (question: string) => Promise<IsolatedQueryResult>;
  orchestratorIsReady: () => Promise<boolean>;
  orchestratorListTasks: () => Promise<any[]>;
  orchestratorReadTaskEvents: (taskId: string) => Promise<any[]>;
  onOrchestratorEvent: (cb: (event: any) => void) => () => void;
  onOrchestratorStatus: (cb: (status: OrchestratorStatus) => void) => () => void;
  onDashboardToggle: (cb: () => void) => () => void;

  // ---- code retrieval ----
  retrievalQuery: (query: string, k?: number) => Promise<RetrievalQueryResult>;
  retrievalOpenFile: (path: string, lineStart?: number, lineEnd?: number) => Promise<RetrievalFileResult>;
  retrievalGetStatus: () => Promise<RetrievalStatus | null>;
  retrievalReindex: () => Promise<{ ok?: boolean; error?: string }>;
  onRetrievalStatus: (cb: (status: RetrievalStatus) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
