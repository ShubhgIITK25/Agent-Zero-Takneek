/**
 * ============================================================================
 *  DIFFS — Git-generated hunks with block-level acceptance
 * ============================================================================
 * The HITL requirement has three parts:
 *   (a) a real Git unified diff,
 *   (b) block-by-block accept/reject plus accept-all/reject-all, and
 *   (c) partial approval must leave a coherent file for the next agent step.
 *
 * The proposed content exists only in memory before approval. We therefore
 * compare two temporary files with `git diff --no-index`; neither temporary
 * file is inside the project and the real project file is not touched until
 * the user approves. `--no-index` works both inside and outside a Git repo.
 *
 * Git hunks are parsed into the protocol's DiffBlock shape for the existing
 * renderer. Partial application uses those same Git hunk headers rather than
 * recomputing a second diff algorithm, so the block the user approves is the
 * block that gets applied.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DiffBlock, FileDiff } from './protocol';

const CONTEXT_LINES = 3;
const GIT_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;
const NO_NEWLINE = '\\ No newline at end of file';

type HunkHeader = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
};

type ParsedHunk = HunkHeader & {
  header: string;
  lines: DiffBlock['lines'];
  /** Git emitted an EOF marker for one side of this hunk. */
  newlineChanged: boolean;
};

/** A logical line list that does not use a fake trailing empty line. */
function contentLines(text: string | null): { lines: string[]; trailingNewline: boolean } {
  if (text == null || text.length === 0) return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  // "\n" is one empty, newline-terminated line; an empty file has no lines.
  const lines = body.length === 0 && trailingNewline ? [''] : body.split('\n');
  return { lines, trailingNewline };
}

function controlLine(raw: string): string {
  // Git writes LF output, but a CRLF source line keeps its CR as content. Only
  // remove CR for control-line matching; hunk body text must retain it.
  return raw.endsWith('\r') ? raw.slice(0, -1) : raw;
}

function parseHunkHeader(line: string): HunkHeader | null {
  const m = GIT_HUNK.exec(controlLine(line));
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] == null ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] == null ? 1 : Number(m[4]),
  };
}

function gitDiffOutput(oldContent: string | null, newContent: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexide-git-diff-'));
  const before = join(dir, 'before');
  const after = join(dir, 'after');
  try {
    // These are deliberately outside the project. The approval gate remains
    // meaningful because the user's real file is untouched at this point.
    writeFileSync(before, oldContent ?? '', 'utf8');
    writeFileSync(after, newContent, 'utf8');

    try {
      return execFileSync(
        'git',
        [
          'diff',
          '--no-index',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          `--unified=${CONTEXT_LINES}`,
          '--',
          before,
          after,
        ],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (err) {
      const failure = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      // `git diff` returns 1 when differences exist. That is the successful
      // result we want; 0 means the files are identical.
      if (failure.status === 1) return String(failure.stdout ?? '');
      const detail = String(failure.stderr ?? failure.message ?? 'unknown Git error').trim();
      throw new Error(`Could not generate a Git diff: ${detail}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseGitHunks(output: string, filePath: string): ParsedHunk[] {
  // Split only on LF so a CR belonging to a CRLF source line remains part of
  // the hunk text and can be applied without silently changing line endings.
  const lines = output.split('\n');
  const hunks: ParsedHunk[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = parseHunkHeader(lines[i]);
    if (!header) continue;
    const headerText = controlLine(lines[i]);

    const body: DiffBlock['lines'] = [];
    let newlineChanged = false;
    for (i += 1; i < lines.length; i++) {
      const raw = lines[i];
      if (parseHunkHeader(raw)) {
        i -= 1;
        break;
      }

      const line = controlLine(raw);
      if (line === NO_NEWLINE) {
        newlineChanged = true;
        continue;
      }
      if (raw.startsWith('+')) body.push({ type: 'add', text: raw.slice(1) });
      else if (raw.startsWith('-')) body.push({ type: 'del', text: raw.slice(1) });
      else if (raw.startsWith(' ')) body.push({ type: 'context', text: raw.slice(1) });
      // Ignore diff metadata after the final hunk. A valid Git hunk has only
      // the three prefixed line kinds above plus the EOF marker.
    }

    const oldLines = body.filter((line) => line.type !== 'add').length;
    const newLines = body.filter((line) => line.type !== 'del').length;
    if (oldLines !== header.oldCount || newLines !== header.newCount) {
      throw new Error(
        `Git hunk for ${filePath} was malformed: expected ${header.oldCount}/${header.newCount} ` +
          `lines, parsed ${oldLines}/${newLines}`,
      );
    }

    hunks.push({
      ...header,
      header: headerText,
      lines: body,
      newlineChanged,
    });
  }

  return hunks;
}

/** Stable id for hunk N of a file. */
export function blockId(filePath: string, n: number): string {
  return filePath + '#' + n;
}

/**
 * Generate the review diff with Git's own unified-diff engine.
 *
 * A text diff with no hunks is impossible unless the inputs are equal or Git
 * considers the file binary. The latter is not representable by our text
 * approval protocol, so fail clearly instead of showing "no change" and
 * silently skipping a proposed edit.
 */
export function buildFileDiff(filePath: string, oldContent: string | null, newContent: string): FileDiff {
  if ((oldContent ?? '') === newContent) return { path: filePath, oldContent, newContent, blocks: [] };

  const output = gitDiffOutput(oldContent, newContent);
  const hunks = parseGitHunks(output, filePath);
  if (hunks.length === 0) {
    throw new Error(
      `Git could not produce a text diff for ${filePath}. Binary files are not supported by propose_edit.`,
    );
  }

  const blocks: DiffBlock[] = hunks.map((hunk, n) => ({
    id: blockId(filePath, n),
    header: hunk.header,
    lines: hunk.lines,
    ...(hunk.newlineChanged ? { newlineChanged: true } : {}),
  }));

  return { path: filePath, oldContent, newContent, blocks };
}

function headerForBlock(block: DiffBlock): HunkHeader {
  const parsed = parseHunkHeader(block.header);
  if (!parsed) throw new Error(`Invalid Git hunk header for ${block.id}: ${block.header}`);
  return parsed;
}

function assertOldLine(oldLines: string[], index: number, expected: string, block: DiffBlock): void {
  if (oldLines[index] !== expected) {
    throw new Error(
      `File changed while diff ${block.id} was awaiting approval; expected the original line at ${index + 1}.`,
    );
  }
}

/**
 * Rebuild the file from the original plus only the Git hunks the user kept.
 * The hunk headers and line prefixes come from Git, and this function uses
 * those exact ranges instead of rerunning a separate diff algorithm.
 */
export function applyAcceptedBlocks(diff: FileDiff, acceptedBlockIds: string[]): string {
  const realIds = new Set(diff.blocks.map((b) => b.id));
  const accepted = new Set(acceptedBlockIds.filter((id) => realIds.has(id)));

  if (diff.blocks.length === 0) return diff.newContent;
  if (diff.blocks.every((b) => accepted.has(b.id))) return diff.newContent;
  if (accepted.size === 0) return diff.oldContent ?? '';

  const old = contentLines(diff.oldContent);
  const out: string[] = [];
  let cursor = 0;
  let trailingNewline = old.trailingNewline;

  for (const block of diff.blocks) {
    const hunk = headerForBlock(block);
    const start = Math.max(0, hunk.oldStart - 1);
    const end = start + hunk.oldCount;
    if (start < cursor || start > old.lines.length || end > old.lines.length) {
      throw new Error(`Git hunk ${block.id} falls outside the original file.`);
    }
    out.push(...old.lines.slice(cursor, start));

    if (accepted.has(block.id)) {
      let oldIndex = start;
      for (const line of block.lines) {
        if (line.type === 'add') {
          out.push(line.text);
        } else {
          assertOldLine(old.lines, oldIndex, line.text, block);
          if (line.type === 'context') out.push(line.text);
          oldIndex++;
        }
      }
      if (oldIndex !== end) throw new Error(`Git hunk ${block.id} did not consume its declared old range.`);
      if (block.newlineChanged) {
        trailingNewline = contentLines(diff.newContent).trailingNewline;
      }
    } else {
      out.push(...old.lines.slice(start, end));
    }
    cursor = end;
  }

  out.push(...old.lines.slice(cursor));
  return out.join('\n') + (trailingNewline ? '\n' : '');
}

/** Human-readable unified diff, used for the log and for agent feedback. */
export function renderUnified(diff: FileDiff): string {
  const head = `--- a/${diff.path}\n+++ b/${diff.path}`;
  const body = diff.blocks
    .map((blk) => [blk.header, ...blk.lines.map((l) => (l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text)].join('\n'))
    .join('\n');
  return `${head}\n${body}`;
}
