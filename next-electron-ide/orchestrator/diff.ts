/**
 * ============================================================================
 *  DIFFS — real hunks, block-level acceptance, partial application
 * ============================================================================
 * The HITL requirement has three parts and the third is the one that is easy
 * to fake: (a) real git diffs, (b) block-by-block accept/reject plus
 * accept-all/reject-all, (c) when the user accepts only SOME blocks, the agent
 * must continue correctly around the rejected ones.
 *
 * (c) is why acceptance is applied by rebuilding the file from the hunks the
 * user kept rather than by writing the model's proposed content and then
 * trying to undo parts of it. We reconstruct: walk the original file, and at
 * each hunk either apply it (accepted) or copy the original lines through
 * (rejected). The result is a file that is exactly the original plus the
 * accepted hunks — which is a state the agent can then be truthfully told
 * about, so its next step reasons about what is really on disk.
 *
 * We compute hunks ourselves with an LCS diff rather than shelling out to
 * `git diff`, for one concrete reason: `git diff` only sees committed or
 * staged content, and the agent's proposal exists only in memory before
 * approval. Writing the proposal to disk to get git to diff it would mean
 * touching the user's files BEFORE they approved the touch, which inverts the
 * whole approval gate. Git is still used for repository operations (status,
 * branch, commit, real committed-history diffs) in tools.ts.
 *
 * ONE SOURCE OF TRUTH FOR HUNK BOUNDARIES. buildFileDiff (which mints the
 * block ids the UI renders) and applyAcceptedBlocks (which decides which
 * lines a given block id owns) BOTH route through hunkRanges(). They used to
 * carry independent copies of the grouping logic; any drift between them meant
 * an "accepted" block id matched no lines on the apply side, the file was
 * written unchanged, and the agent re-proposed the same edit in a loop.
 * Keeping the boundary decision in exactly one place removes that class of bug.
 */

import { DiffBlock, FileDiff } from './protocol';

/** Standard LCS table. Files here are source files; O(n*m) is fine. */
function lcsMatrix(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

type Op = { type: 'context' | 'add' | 'del'; text: string; aIdx: number; bIdx: number };

function diffOps(a: string[], b: string[]): Op[] {
  const dp = lcsMatrix(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: 'context', text: a[i], aIdx: i, bIdx: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: a[i], aIdx: i, bIdx: j });
      i++;
    } else {
      ops.push({ type: 'add', text: b[j], aIdx: i, bIdx: j });
      j++;
    }
  }
  while (i < a.length) ops.push({ type: 'del', text: a[i], aIdx: i++, bIdx: j });
  while (j < b.length) ops.push({ type: 'add', text: b[j], aIdx: i, bIdx: j++ });
  return ops;
}

const CONTEXT_LINES = 3;

/** Line split that keeps "a\nb\n" and "a\nb" distinguishable: the trailing
 *  empty element the naive split produces is what encodes the final newline,
 *  and join('\n') puts it back, so reconstruction round-trips exactly. */
function toLines(text: string | null): string[] {
  return text == null ? [] : text.split('\n');
}

/**
 * THE one place hunk boundaries are decided. Returns, for the given op stream,
 * the [start,end] op-index span of each hunk — changed ops merged when they
 * sit within 2*CONTEXT_LINES of each other, so two edits a few lines apart
 * read as one reviewable block. Both buildFileDiff and applyAcceptedBlocks
 * call this, so "block N" covers the same ops on both sides.
 */
function hunkRanges(ops: Op[]): { start: number; end: number }[] {
  const changedIdx: number[] = [];
  ops.forEach((op, idx) => {
    if (op.type !== 'context') changedIdx.push(idx);
  });
  if (changedIdx.length === 0) return [];

  const ranges: { start: number; end: number }[] = [];
  let start = changedIdx[0];
  let end = changedIdx[0];
  for (const idx of changedIdx.slice(1)) {
    if (idx - end <= CONTEXT_LINES * 2) {
      end = idx;
    } else {
      ranges.push({ start, end });
      start = idx;
      end = idx;
    }
  }
  ranges.push({ start, end });
  return ranges;
}

/** Stable id for hunk N of a file. Opaque everywhere it is used — React key,
 *  Set membership, and the UI/orchestrator match are all plain string
 *  equality, so the only requirement is that both sides mint it identically. */
export function blockId(filePath: string, n: number): string {
  return filePath + '#' + n;
}

/**
 * Group changed ops into hunks with surrounding context, in the shape a
 * unified diff uses — so the UI can render something a developer recognises
 * rather than a bespoke format.
 */
export function buildFileDiff(filePath: string, oldContent: string | null, newContent: string): FileDiff {
  const a = toLines(oldContent);
  const b = toLines(newContent);
  const ops = diffOps(a, b);
  const ranges = hunkRanges(ops);

  const blocks: DiffBlock[] = ranges.map((r, n) => {
    const from = Math.max(0, r.start - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, r.end + CONTEXT_LINES);
    const slice = ops.slice(from, to + 1);

    const aStart = slice.find((o) => o.type !== 'add')?.aIdx ?? slice[0].aIdx;
    const bStart = slice.find((o) => o.type !== 'del')?.bIdx ?? slice[0].bIdx;
    const aCount = slice.filter((o) => o.type !== 'add').length;
    const bCount = slice.filter((o) => o.type !== 'del').length;

    return {
      id: blockId(filePath, n),
      header: `@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`,
      lines: slice.map((o) => ({ type: o.type, text: o.text })),
    };
  });

  return { path: filePath, oldContent, newContent, blocks };
}

/**
 * Rebuild file content from the original plus ONLY the accepted hunks.
 * Rejected hunks contribute their original lines unchanged, which is what
 * makes partial approval produce a coherent file rather than a merge artifact.
 *
 * Guarantees, given a diff `d` from buildFileDiff:
 *   applyAcceptedBlocks(d, <every block id>) === d.newContent
 *   applyAcceptedBlocks(d, [])               === d.oldContent ?? ''
 * Unknown ids are ignored rather than throwing, and an id set that (after
 * ignoring unknowns) covers every real block is treated as accept-all — so a
 * UI or serialisation hiccup degrades to "apply the change" instead of
 * "silently write nothing and make the agent loop".
 */
export function applyAcceptedBlocks(diff: FileDiff, acceptedBlockIds: string[]): string {
  const realIds = new Set(diff.blocks.map((b) => b.id));
  const accepted = new Set(acceptedBlockIds.filter((id) => realIds.has(id)));

  if (diff.blocks.length === 0) return diff.newContent;
  if (diff.blocks.every((b) => accepted.has(b.id))) return diff.newContent;
  if (accepted.size === 0) return diff.oldContent ?? '';

  const a = toLines(diff.oldContent);
  const b = toLines(diff.newContent);
  const ops = diffOps(a, b);

  // Same grouping call buildFileDiff used, so "op index -> owning block id"
  // here is exactly the mapping the ids in `accepted` were minted against.
  const ownerOf = new Map<number, string>();
  hunkRanges(ops).forEach((r, n) => {
    for (let i = r.start; i <= r.end; i++) ownerOf.set(i, blockId(diff.path, n));
  });

  const out: string[] = [];
  ops.forEach((op, idx) => {
    const owner = ownerOf.get(idx);
    const isAccepted = owner != null && accepted.has(owner);
    if (op.type === 'context') {
      out.push(op.text);
    } else if (op.type === 'add') {
      if (isAccepted) out.push(op.text); // keep the addition only if accepted
    } else {
      // deletion: accepted means actually delete, rejected means keep the line
      if (!isAccepted) out.push(op.text);
    }
  });

  return out.join('\n');
}

/** Human-readable unified diff, used for the log and for agent feedback. */
export function renderUnified(diff: FileDiff): string {
  const head = `--- a/${diff.path}\n+++ b/${diff.path}`;
  const body = diff.blocks
    .map((blk) => [blk.header, ...blk.lines.map((l) => (l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text)].join('\n'))
    .join('\n');
  return `${head}\n${body}`;
}
