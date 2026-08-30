/**
 * ============================================================================
 *  TOOLS — what an agent can actually do, and what needs permission first
 * ============================================================================
 * These run inside the orchestrator process, which has full Node access. Two
 * design points worth defending:
 *
 * 1. COMMANDS ARE CAPTURED, NOT TYPED INTO THE USER'S TERMINAL.
 *    The IDE's xterm panel is an interactive shell for the human. An agent
 *    needs the *output* of a command as feedback ("did the tests pass?"), and
 *    a pty gives you interleaved, escape-code-laden text with no exit status.
 *    So `run_command` uses execFile and returns {stdout, stderr, exitCode},
 *    and separately mirrors the command into the visible terminal so the user
 *    sees what happened. Feedback for the agent, visibility for the human.
 *
 * 2. WRITES ARE PROPOSED, NOT PERFORMED.
 *    `propose_edit` does not touch the disk. It returns a diff to the
 *    orchestrator, which raises an approval_request and blocks. Only after a
 *    decision comes back does the orchestrator write the accepted hunks. This
 *    is what makes the approval gate real rather than advisory — there is no
 *    code path in this file that writes a file the user has not seen.
 *
 * `sideEffecting` marks the tools that must never run unapproved.
 */

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolSchema } from './providers';
import { buildFileDiff } from './diff';
import { FileDiff } from './protocol';

export type ToolContext = {
  rootPath: string;
  /** Identifies which per-project index the retrieval service should search.
   *  The /query endpoint requires this and does NOT derive it from rootPath. */
  codebaseId: string;
  retrievalUrl: string | null;
  /** .nexideignore / .ignore matcher — gates the AUTOMATIC tools below.
   *  See orchestrator/ignore.ts for what it does and does not cover. */
  ignore: { isIgnored: (relPath: string) => boolean; sourceFile: string | null };
  /** Mirrors a command into the IDE's visible terminal panel. */
  echoToTerminal: (command: string) => void;
  /** Set by the orchestrator when a proposal needs approving. `fullyApplied`
   *  is true when every proposed block landed on disk; `rejectedBlocks` counts
   *  the blocks the user kept out on a partial approval. */
  proposeDiff: (
    diffs: FileDiff[],
    summary: string
  ) => Promise<{ approved: boolean; written: string[]; fullyApplied: boolean; rejectedBlocks: number }>;
};

export type ToolResult = {
  content: string;
  contextItems?: { path: string; lines?: string; tokens: number }[];
  /** Raised by the orchestrator as an `intervention` event. Tools cannot emit
   *  directly — they stay pure functions of (args, ctx) so they are trivially
   *  testable — so anything a tool needs the dashboard to show travels back
   *  through here. Currently used by retrieve_context to report that a first
   *  retrieval was weak and what it did about it. */
  intervention?: { cause: 'retrieval_weak'; detail: string; action: string };
};

export type Tool = {
  schema: ToolSchema;
  sideEffecting: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (typeof v !== 'string' || !v) {
    if (required) throw new Error(`"${key}" must be a non-empty string`);
    return '';
  }
  return v;
}

/** Every path an agent supplies is confined to the open project. */
function resolveInRoot(rootPath: string, p: string): string {
  const resolved = path.resolve(rootPath, p);
  const rel = path.relative(rootPath, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path "${p}" is outside the open project folder — refused`);
  }
  return resolved;
}

function execCapture(
  command: string,
  cwd: string,
  timeoutMs = 120_000
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
    const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command];
    execFile(shell, shellArgs, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0,
      });
    });
  });
}

function execSafeGit(
  args: string[],
  cwd: string,
  timeoutMs = 30_000
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0,
      });
    });
  });
}

/** Trim tool output so one noisy command cannot blow the context window. */
function clamp(text: string, max = 6000): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max * 0.6);
  const tail = text.slice(-max * 0.35);
  return `${head}\n... [${text.length - max} characters elided] ...\n${tail}`;
}

export const TOOLS: Tool[] = [
  {
    schema: {
      name: 'retrieve_context',
      description:
        'Search the open codebase for code relevant to a natural-language or symbol query. Returns the most ' +
        'relevant function/class snippets with file paths and line ranges. This is the cheap default - use it ' +
        'before reading whole files.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you are looking for' },
          k: { type: 'number', description: 'Max snippets (default 8)' },
        },
        required: ['query'],
      },
    },
    sideEffecting: false,
    run: async (args, ctx) => {
      const query = str(args, 'query');
      if (!ctx.retrievalUrl) return { content: 'Retrieval service unavailable. Use list_dir / read_file instead.' };
      const res = await fetch(`${ctx.retrievalUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          k: typeof args.k === 'number' ? args.k : 8,
          codebase_id: ctx.codebaseId,
          root_path: ctx.rootPath,
        }),
      });
      if (!res.ok) return { content: `Retrieval failed (${res.status}).` };
      const data: any = await res.json();
      if (data.error) return { content: `Retrieval unavailable: ${data.error}` };

      const raw: any[] = data.results ?? [];
      const results = raw.filter((r) => !ctx.ignore.isIgnored(String(r.file ?? '')));
      const attempts: any[] = Array.isArray(data.attempts) ? data.attempts : [];
      const escalated = attempts.length > 1;
      const reasons: string[] = Array.isArray(data.weak_reasons) ? data.weak_reasons : [];

      // The service already detected a weak first attempt and retried it,
      // widened and reformulated, at zero model cost. Report that here so the
      // escalation is visible in the dashboard rather than being an invisible
      // "it worked the second time".
      const intervention = escalated
        ? {
            cause: 'retrieval_weak' as const,
            detail:
              `Retrieval for "${query}" scored ${attempts[0]?.confidence ?? '?'} confidence` +
              (attempts[0]?.reasons?.length ? ` (${attempts[0].reasons.join('; ')})` : '') + '.',
            action:
              `Re-ran it widened and reformulated as "${data.query_used}" — ` +
              (data.weak
                ? `still weak (${data.confidence}). Handing the result up with guidance so the agent can rephrase.`
                : `confidence improved to ${data.confidence}.`),
          }
        : undefined;

      if (!raw.length) {
        // An empty result is a fact the agent must act on, not a dead end. Tell
        // it what was already tried automatically, so its next move is a
        // genuinely different one rather than the same query again.
        const tried = attempts.map((a) => `"${a.query}"`).join(', ') || `"${query}"`;
        return {
          content:
            `No relevant code found. Already tried automatically (widened and reformulated): ${tried}.\n` +
            'Do NOT repeat those. Either search for a concrete symbol name you expect to exist, or use ' +
            'list_dir to see the project layout and read_file on a likely file.',
          intervention,
        };
      }
      if (!results.length) {
        return {
          content: `${raw.length} match(es) found, but every one is excluded by ${ctx.ignore.sourceFile}. Nothing to show.`,
          intervention,
        };
      }

      const body = results
        .map((r) => `${r.file}:${r.line_start}-${r.line_end} (${r.kind} ${r.symbol}) — ${r.why_relevant}\n${r.snippet}`)
        .join('\n\n---\n\n');

      // A weak result set is handed over WITH its weakness stated. Silently
      // returning low-confidence snippets is how an agent ends up confidently
      // editing the wrong file; saying so lets it decide to look further, and
      // it is already a model in a loop, so that costs no extra call.
      const header =
        data.weak && reasons.length
          ? `[retrieval confidence ${data.confidence} — LOW] ${reasons.join('; ')}.\n` +
            `Tried: ${attempts.map((a) => `"${a.query}"`).join(', ')}. These results may not answer the question. ` +
            'If they look unrelated, search for a specific symbol name instead of a description, or use list_dir.\n\n'
          : escalated
            ? `[retrieval confidence ${data.confidence} — recovered by reformulating to "${data.query_used}"]\n\n`
            : '';

      return {
        content: header + body,
        contextItems: results.map((r) => ({
          path: r.file,
          lines: `${r.line_start}-${r.line_end}`,
          tokens: Math.ceil(String(r.snippet ?? '').length / 3.6),
        })),
        intervention,
      };
    },
  },
  {
    schema: {
      name: 'read_file',
      description: 'Read a file from the open project by project-relative path. Costs more tokens than retrieve_context — use deliberately.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative path' },
          line_start: { type: 'number' },
          line_end: { type: 'number' },
        },
        required: ['path'],
      },
    },
    sideEffecting: false,
    run: async (args, ctx) => {
      const rel = str(args, 'path');
      if (ctx.ignore.isIgnored(rel)) {
        return {
          content: `"${rel}" is excluded from context by ${ctx.ignore.sourceFile}. It will not be read. If you genuinely need it, ask the user to pin it explicitly instead.`,
        };
      }
      const full = resolveInRoot(ctx.rootPath, rel);
      const content = await fs.readFile(full, 'utf8');
      const lines = content.split('\n');
      const start = typeof args.line_start === 'number' ? Math.max(1, args.line_start) : 1;
      const end = typeof args.line_end === 'number' ? Math.min(lines.length, args.line_end) : lines.length;
      const slice = lines.slice(start - 1, end).join('\n');
      return {
        content: `${rel}:${start}-${end}\n${clamp(slice)}`,
        contextItems: [{ path: rel, lines: `${start}-${end}`, tokens: Math.ceil(slice.length / 3.6) }],
      };
    },
  },
  {
    schema: {
      name: 'list_dir',
      description: 'List files and folders inside a project-relative directory.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    sideEffecting: false,
    run: async (args, ctx) => {
      const rel = str(args, 'path', false) || '.';
      const full = resolveInRoot(ctx.rootPath, rel);
      const entries = await fs.readdir(full, { withFileTypes: true });
      return {
        content: entries
          .filter((e) => !['node_modules', '.git', '.next', '__pycache__', '.venv'].includes(e.name))
          .filter((e) => !ctx.ignore.isIgnored(path.posix.join(rel === '.' ? '' : rel, e.name)))
          .map((e) => `${e.isDirectory() ? 'dir ' : 'file'}  ${path.posix.join(rel === '.' ? '' : rel, e.name)}`)
          .join('\n'),
      };
    },
  },
  {
    schema: {
      name: 'propose_edit',
      description:
        'Propose a change to a file. This does NOT write to disk — it shows the user a diff for block-by-block ' +
        'approval, and only the blocks they accept get written. Always supply the complete intended file content. ' +
        'The result tells you exactly what ended up on disk, which may be a partial application.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative path' },
          content: { type: 'string', description: 'Complete new file content' },
          summary: { type: 'string', description: 'One line: what this change does and why' },
        },
        required: ['path', 'content', 'summary'],
      },
    },
    sideEffecting: true,
    run: async (args, ctx) => {
      const rel = str(args, 'path');
      const newContent = typeof args.content === 'string' ? args.content : '';
      const summary = str(args, 'summary', false) || `edit ${rel}`;
      const full = resolveInRoot(ctx.rootPath, rel);

      let oldContent: string | null = null;
      try {
        oldContent = await fs.readFile(full, 'utf8');
      } catch {
        oldContent = null; // new file
      }

      const diff = buildFileDiff(rel, oldContent, newContent);
      if (diff.blocks.length === 0) return { content: `No change: ${rel} already matches the proposed content.` };

      const outcome = await ctx.proposeDiff([diff], summary);
      if (!outcome.approved) {
        // Telling the model precisely what happened is what lets it work
        // around a rejection instead of blindly re-proposing the same edit.
        return { content: `The user REJECTED all changes to ${rel}. The file is unchanged on disk. Do not re-propose the same edit — either take a different approach or ask what they want instead.` };
      }
      if (outcome.written.length === 0) {
        return { content: `No blocks were accepted for ${rel}; the file is unchanged on disk. Do not re-propose the same edit.` };
      }
      if (outcome.fullyApplied) {
        // The whole proposal is on disk. Re-reading and echoing the file back
        // here just tempts a small model into "reviewing" its own change and
        // proposing again — so confirm succinctly and tell it to move on.
        return {
          content:
            `Applied to ${rel} in full — every proposed block is now on disk. This edit is complete. ` +
            `Do NOT call propose_edit for ${rel} again unless you have a further, genuinely different change to make. ` +
            `If this was the last thing the subtask needed, reply now with a line starting "DONE:".`,
        };
      }
      // Partial approval: the model DOES need to see the real file to continue
      // correctly around the blocks the user rejected.
      return {
        content:
          `Partial approval on ${rel}: the user rejected ${outcome.rejectedBlocks} block(s). The file on disk now reads:\n\n` +
          `${clamp(await fs.readFile(full, 'utf8'), 3000)}\n\n` +
          `Continue from this actual on-disk content. Do not re-propose the rejected block(s) unchanged.`,
      };
    },
  },
  {
    schema: {
      name: 'run_command',
      description:
        'Run a shell command in the project root and return its stdout, stderr and exit code. Requires user ' +
        'approval. Use this to run tests, linters, and build steps to verify your own work.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, why: { type: 'string', description: 'Why you need to run it' } },
        required: ['command'],
      },
    },
    sideEffecting: true,
    run: async (args, ctx) => {
      const command = str(args, 'command');
      ctx.echoToTerminal(command);
      const { stdout, stderr, code } = await execCapture(command, ctx.rootPath);
      return { content: `exit ${code}\n--- stdout ---\n${clamp(stdout)}\n--- stderr ---\n${clamp(stderr, 2000)}` };
    },
  },
  {
    schema: {
      name: 'git',
      description:
        'Run a read-only git query on the project: status, log, diff, branch, show. State-changing subcommands ' +
        '(commit, push, merge, checkout, reset) are routed through approval automatically.',
      parameters: {
        type: 'object',
        properties: { 
          // CHANGED: Force the LLM to provide a safe array of strings instead of one long string
          args: { 
            type: 'array', 
            items: { type: 'string' },
            description: 'Array of git arguments, e.g. ["log", "-n", "5", "--oneline"]' 
          } 
        },
        required: ['args'],
      },
    },
    sideEffecting: false,
    run: async (args, ctx) => {
      // Ensure we have an array of strings
      const gitArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      if (gitArgs.length === 0) return { content: 'No git arguments provided.' };

      const READ_ONLY = ['status', 'log', 'diff', 'show', 'branch', 'blame', 'ls-files', 'rev-parse'];
      const sub = gitArgs[0]; // The first item is always the subcommand

      if (!READ_ONLY.includes(sub)) {
        return { content: `"git ${sub}" changes repository state. Use run_command (which is approval-gated) for it.` };
      }

      // Execute safely using the array
      const { stdout, stderr, code } = await execSafeGit(gitArgs, ctx.rootPath, 30_000);
      return { content: `exit ${code}\n${clamp(stdout)}${stderr ? `\nstderr: ${clamp(stderr, 1000)}` : ''}` };
    },
  },
  {
    schema: {
      name: 'web_search',
      description:
        'Search the web using DuckDuckGo to find current documentation, API signatures, migration guides, compiler errors, and general knowledge. Returns extracted text from the search results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
    },
    sideEffecting: false,
    run: async (args) => {
      const query = str(args, 'query');
      
      try {

        const res = await fetch('https://lite.duckduckgo.com/lite/', {
          method: 'POST',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          body: `q=${encodeURIComponent(query)}`
        });

        if (!res.ok) {
          return { content: `Web search failed with status ${res.status}.` };
        }

        const html = await res.text();

        // 1. Remove script and style blocks entirely (though DDG Lite has very few)
        let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
        text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
        
        // 2. Remove all HTML tags
        text = text.replace(/<[^>]+>/g, ' ');
        
        // 3. Decode basic HTML entities
        text = text.replace(/&quot;/g, '"')
                     .replace(/&#39;/g, "'")
                     .replace(/&amp;/g, '&')
                     .replace(/&lt;/g, '<')
                     .replace(/&gt;/g, '>');
                     
        // 4. Collapse multiple spaces, tabs, and newlines into a dense, readable block
        text = text.replace(/\s+/g, ' ').trim();

        if (!text || text.length < 50) {
          return { content: `No meaningful results found for query: ${query}` };
        }

        // Return clamped text so we don't blow out the agent's context window
        return { 
          content: `Search results for "${query}":\n\n${clamp(text, 6000)}\n\n(Note: This is scraped text. Look for keywords or URLs within the block.)` 
        };
        
      } catch (err) {
        return { content: `Search request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  },
];

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.schema.name === name);
}

export const TOOL_SCHEMAS: ToolSchema[] = TOOLS.map((t) => t.schema);

/** Verifier gets a deliberately smaller surface: it checks, it does not edit. */
export const VERIFIER_TOOL_SCHEMAS: ToolSchema[] = TOOLS.filter((t) =>
  ['retrieve_context', 'read_file', 'list_dir', 'git', 'run_command', 'web_search'].includes(t.schema.name)
).map((t) => t.schema);
