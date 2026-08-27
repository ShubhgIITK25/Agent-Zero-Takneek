/**
 * Tool definitions the agent loop (agent.ts) can offer to the LLM.
 *
 * These actually execute — read_file/list_dir hit the real filesystem via
 * window.electronAPI, write_file/delete_path/run_command are real
 * side-effecting operations. `sideEffecting: true` is what agent.ts uses to
 * decide a tool call must be human-approved (ChatPanel's Approve/Reject)
 * before it runs — see the PS's "any side-effect action needs human
 * approval" requirement. Add new tools here; nothing else needs to change
 * except the LLM actually deciding to call them (src/lib/llm.ts).
 *
 * retrieve_context / open_file are a deliberate two-tier pair (see
 * retrieval-service/retrieval.py for the pipeline behind retrieve_context):
 * retrieve_context is the cheap default — a handful of relevant snippets,
 * not whole files — and open_file is the deliberate, separate step for
 * when a snippet genuinely isn't enough. Dumping full files into every
 * small model's context by default is the fastest way to blow the PS's
 * cost ceiling (cost is weighted 2x harder than time in the scoring
 * formula), so the system prompt (agent.ts) steers the model to reach for
 * retrieve_context first and open_file only on a deliberate follow-up.
 */

import type { LLMToolSchema } from './llm';

export type ToolExecContext = {
  rootPath: string | null;
  runInTerminal: (command: string) => void;
  /** Tells the IDE a file on disk changed, so it can refresh any open tab
   *  showing it (and the file tree) instead of silently going stale. */
  notifyFileChanged: (path: string) => void;
};

export type ToolDefinition = {
  schema: LLMToolSchema;
  /** Requires human Approve/Reject before executing (write/delete/exec). */
  sideEffecting: boolean;
  execute: (args: Record<string, unknown>, ctx: ToolExecContext) => Promise<string>;
};

function requireElectronAPI() {
  if (!window.electronAPI) throw new Error('Electron bridge unavailable.');
  return window.electronAPI;
}

function requireStringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value) {
    throw new Error(`"${name}" argument (non-empty string) is required.`);
  }
  return value;
}

export const TOOLS: ToolDefinition[] = [
  {
    schema: {
      name: 'retrieve_context',
      description:
        'Search the currently open codebase for code relevant to a natural-language or symbol query. ' +
        'Returns a handful of the most relevant function/class snippets (not whole files), each with a ' +
        'file path, line range, and why it was surfaced. This is the default, cheap way to find code — ' +
        'prefer it over read_file/list_dir when you do not already know the exact file you need.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you are looking for, e.g. "the function that validates a session token"' },
          k: { type: 'number', description: 'Max number of snippets to return (default 8)' },
        },
        required: ['query'],
      },
    },
    sideEffecting: false,
    execute: async (args) => {
      const query = requireStringArg(args, 'query');
      const k = typeof args.k === 'number' ? args.k : undefined;
      const result = await requireElectronAPI().retrievalQuery(query, k);
      if (result.error) return `Retrieval unavailable: ${result.error}`;
      if (result.results.length === 0) return 'No relevant code found for that query.';
      return result.results
        .map(
          (r) =>
            `${r.file}:${r.line_start}-${r.line_end} (${r.kind} ${r.symbol}) — ${r.why_relevant}\n${r.snippet}`
        )
        .join('\n\n---\n\n');
    },
  },
  {
    schema: {
      name: 'open_file',
      description:
        'Open the full contents of a file from the currently open codebase, by the project-relative path ' +
        'returned from retrieve_context. Use this only as a deliberate follow-up when a retrieve_context ' +
        'snippet is not enough — it costs more tokens than a snippet, so do not use it as your first move.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative file path, e.g. "src/auth.py"' },
          line_start: { type: 'number', description: 'Optional: first line to include (1-indexed)' },
          line_end: { type: 'number', description: 'Optional: last line to include' },
        },
        required: ['path'],
      },
    },
    sideEffecting: false,
    execute: async (args) => {
      const path = requireStringArg(args, 'path');
      const lineStart = typeof args.line_start === 'number' ? args.line_start : undefined;
      const lineEnd = typeof args.line_end === 'number' ? args.line_end : undefined;
      const result = await requireElectronAPI().retrievalOpenFile(path, lineStart, lineEnd);
      if (result.error) return `Could not open ${path}: ${result.error}`;
      return `${result.path}:${result.line_start}-${result.line_end}\n${result.content}`;
    },
  },
  {
    schema: {
      name: 'read_file',
      description: 'Read the full text contents of a file at an absolute path.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute file path' } },
        required: ['path'],
      },
    },
    sideEffecting: false,
    execute: async (args) => {
      const path = requireStringArg(args, 'path');
      return requireElectronAPI().readFile(path);
    },
  },
  {
    schema: {
      name: 'list_dir',
      description: 'List the files and folders directly inside a directory (absolute path).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute directory path' } },
        required: ['path'],
      },
    },
    sideEffecting: false,
    execute: async (args) => {
      const path = requireStringArg(args, 'path');
      const entries = await requireElectronAPI().readDir(path);
      return JSON.stringify(entries, null, 2);
    },
  },
  {
    schema: {
      name: 'write_file',
      description: 'Create or overwrite a file at an absolute path with the given text content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path' },
          content: { type: 'string', description: 'Full new file content (overwrites any existing content)' },
        },
        required: ['path', 'content'],
      },
    },
    sideEffecting: true,
    execute: async (args, ctx) => {
      const path = requireStringArg(args, 'path');
      const content = typeof args.content === 'string' ? args.content : '';
      await requireElectronAPI().writeFile(path, content);
      ctx.notifyFileChanged(path);
      return `Wrote ${content.length} characters to ${path}`;
    },
  },
  {
    schema: {
      name: 'delete_path',
      description: 'Permanently delete a file or folder (recursively) at an absolute path.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute file or folder path' } },
        required: ['path'],
      },
    },
    sideEffecting: true,
    execute: async (args, ctx) => {
      const path = requireStringArg(args, 'path');
      await requireElectronAPI().deletePath(path);
      ctx.notifyFileChanged(path);
      return `Deleted ${path}`;
    },
  },
  {
    schema: {
      name: 'run_command',
      description:
        'Run a shell command in the IDE\'s integrated terminal (opens the terminal panel if it is closed).',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Shell command line to execute' } },
        required: ['command'],
      },
    },
    sideEffecting: true,
    execute: async (args, ctx) => {
      const command = requireStringArg(args, 'command');
      ctx.runInTerminal(command);
      return `Sent to integrated terminal: ${command}`;
    },
  },
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.schema.name === name);
}

export const TOOL_SCHEMAS: LLMToolSchema[] = TOOLS.map((t) => t.schema);
