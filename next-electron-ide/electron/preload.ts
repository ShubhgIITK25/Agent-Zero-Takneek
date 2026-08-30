import { contextBridge, ipcRenderer } from "electron";

export type FileNode = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export type AgentSettings = {
  envVars: Record<string, string>;
  enabledModelIds: string[];
  maxCostUsd: number;
  maxSeconds: number;
};

export type OrchestratorStatus = {
  state: "ready" | "restarting" | "unavailable";
  message?: string;
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
  state: "idle" | "indexing" | "ready" | "error" | "unavailable";
  codebaseId?: string;
  message?: string;
  files_indexed?: number;
  chunks_indexed?: number;
  files_updated?: number;
  chunks_updated?: number;
  vector_search?: boolean;
};

const api = {
  openFolder: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:openFolder"),
  /** The folder already open in main (restored from the last session), or null. */
  getCurrentFolder: (): Promise<string | null> =>
    ipcRenderer.invoke("folder:getCurrent"),
  onFolderOpened: (cb: (folderPath: string) => void) => {
    const listener = (_evt: unknown, folderPath: string) => cb(folderPath);
    ipcRenderer.on("folder:opened", listener);
    return () => ipcRenderer.removeListener("folder:opened", listener);
  },
  readDir: (dirPath: string): Promise<FileNode[]> =>
    ipcRenderer.invoke("fs:readDir", dirPath),
  readFile: (filePath: string): Promise<string> =>
    ipcRenderer.invoke("fs:readFile", filePath),
  writeFile: (filePath: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke("fs:writeFile", filePath, content),
  createFile: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke("fs:createFile", filePath),
  createFolder: (dirPath: string): Promise<boolean> =>
    ipcRenderer.invoke("fs:createFolder", dirPath),
  rename: (oldPath: string, newPath: string): Promise<boolean> =>
    ipcRenderer.invoke("fs:rename", oldPath, newPath),
  deletePath: (targetPath: string): Promise<boolean> =>
    ipcRenderer.invoke("fs:delete", targetPath),
  showItemInFolder: (targetPath: string) =>
    ipcRenderer.invoke("shell:showItemInFolder", targetPath),

  // ---- integrated terminal ----
  terminalCreate: (id: string, cwd?: string): Promise<boolean> =>
    ipcRenderer.invoke("terminal:create", id, cwd),
  terminalWrite: (id: string, data: string): Promise<void> =>
    ipcRenderer.invoke("terminal:write", id, data),
  terminalResize: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke("terminal:resize", id, cols, rows),
  terminalKill: (id: string): Promise<void> =>
    ipcRenderer.invoke("terminal:kill", id),
  terminalChangeDir: (id: string, dirPath: string): Promise<void> =>
    ipcRenderer.invoke("terminal:changeDir", id, dirPath),
  onTerminalData: (cb: (id: string, data: string) => void) => {
    const listener = (_evt: unknown, id: string, data: string) => cb(id, data);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  onTerminalExit: (cb: (id: string, exitCode: number) => void) => {
    const listener = (_evt: unknown, id: string, exitCode: number) =>
      cb(id, exitCode);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.removeListener("terminal:exit", listener);
  },
  onTerminalToggle: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("terminal:toggle", listener);
    return () => ipcRenderer.removeListener("terminal:toggle", listener);
  },

  // ---- agent settings (API keys / env vars) ----
  settingsGet: (): Promise<AgentSettings> => ipcRenderer.invoke("settings:get"),
  settingsSet: (settings: AgentSettings): Promise<boolean> =>
    ipcRenderer.invoke("settings:set", settings),
  // Probe each model's provider and report whether it is actually callable.
  // Keys are passed through from settings the renderer already holds; they do
  // not leave the app.
  modelsCheckHealth: (req: {
    models: { id: string; apiId: string; provider: string }[];
    envVars: Record<string, string>;
  }): Promise<Record<string, { state: string; detail: string; checkedAt: number }>> =>
    ipcRenderer.invoke("models:checkHealth", req),
  onChatToggle: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("chat:toggle", listener);
    return () => ipcRenderer.removeListener("chat:toggle", listener);
  },
  onSettingsToggle: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("settings:toggle", listener);
    return () => ipcRenderer.removeListener("settings:toggle", listener);
  },
  onFilesRefresh: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("files:refresh", listener);
    return () => ipcRenderer.removeListener("files:refresh", listener);
  },

  // ---- orchestrator ----
  // Control commands are request/response; trace events arrive on a
  // subscription. Main.ts assembles the task config on every call, and the
  // renderer's settings form is the only place that temporarily holds keys.
  orchestratorStartTask: (taskId: string, prompt: string): Promise<unknown> =>
    ipcRenderer.invoke("orchestrator:startTask", taskId, prompt),
  orchestratorResumeTask: (taskId: string): Promise<unknown> =>
    ipcRenderer.invoke("orchestrator:resumeTask", taskId),
  orchestratorCancelTask: (taskId: string): Promise<unknown> =>
    ipcRenderer.invoke("orchestrator:cancelTask", taskId),
  orchestratorApprove: (decision: unknown): Promise<unknown> =>
    ipcRenderer.invoke("orchestrator:approve", decision),
  orchestratorIsolatedQuery: (
    question: string,
  ): Promise<{ answer: string; modelId: string; costUsd: number }> =>
    ipcRenderer.invoke("orchestrator:isolatedQuery", question),
  orchestratorIsReady: (): Promise<boolean> =>
    ipcRenderer.invoke("orchestrator:isReady"),
  orchestratorListTasks: (): Promise<any[]> =>
    ipcRenderer.invoke("orchestrator:listTasks"),
  orchestratorReadTaskEvents: (taskId: string): Promise<any[]> =>
    ipcRenderer.invoke("orchestrator:readTaskEvents", taskId),
  onOrchestratorEvent: (cb: (event: any) => void) => {
    const listener = (_evt: unknown, event: any) => cb(event);
    ipcRenderer.on("orchestrator:event", listener);
    return () => ipcRenderer.removeListener("orchestrator:event", listener);
  },
  onOrchestratorStatus: (cb: (status: OrchestratorStatus) => void) => {
    const listener = (_evt: unknown, status: OrchestratorStatus) => cb(status);
    ipcRenderer.on("orchestrator:status", listener);
    return () => ipcRenderer.removeListener("orchestrator:status", listener);
  },
  onDashboardToggle: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("dashboard:toggle", listener);
    return () => ipcRenderer.removeListener("dashboard:toggle", listener);
  },

  // ---- code retrieval ----
  // Backed by the separate Python retrieval service (retrieval-service/) —
  // see electron/main.ts's retrieval:* handlers for how codebase_id
  // resolution and isolation actually work. The renderer never needs to
  // know or pass a codebase_id itself; main.ts already knows which folder
  // is open.
  retrievalQuery: (query: string, k?: number): Promise<RetrievalQueryResult> =>
    ipcRenderer.invoke("retrieval:query", query, k),
  retrievalOpenFile: (
    path: string,
    lineStart?: number,
    lineEnd?: number,
  ): Promise<RetrievalFileResult> =>
    ipcRenderer.invoke("retrieval:openFile", path, lineStart, lineEnd),
  onRetrievalStatus: (cb: (status: RetrievalStatus) => void) => {
    const listener = (_evt: unknown, status: RetrievalStatus) => cb(status);
    ipcRenderer.on("retrieval:status", listener);
    return () => ipcRenderer.removeListener("retrieval:status", listener);
  },
};

export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld("electronAPI", api);
