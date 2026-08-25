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
