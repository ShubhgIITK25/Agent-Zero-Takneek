/**
 * ============================================================================
 *  REVIEW BUFFER — the text Monaco shows during an inline diff review
 * ============================================================================
 * VSCode's inline AI review shows ONE buffer containing the original file with
 * the proposed changes spliced in: removed lines in red, added lines in green,
 * everything else untouched. This builds exactly that buffer.
 *
 * WHY IT IS RECONSTRUCTED FROM THE HUNKS RATHER THAN RE-DIFFED HERE.
 * The renderer could run its own diff of oldContent vs newContent, but then
 * the hunk boundaries on screen would be the RENDERER's, while the block ids
 * the user's Keep/Deny decisions travel under are the ORCHESTRATOR's (minted
 * by orchestrator/diff.ts). Any drift between the two — a different context
 * window, a different tie-break in the LCS walk — means the user keeps the
 * hunk they can see and the orchestrator applies a different set of lines.
 *
 * So instead this walks the blocks the orchestrator actually sent, using each
 * hunk header's `-aStart,aCount` to know precisely which original lines that
 * hunk consumes, and copies the untouched original lines through in between.
 * Every add/del row therefore carries the real block id, and the preview is
 * the same object the decision is made against.
 *
 * The invariant that makes this trustworthy is tested in tests/review-buffer.js:
 * folding the rows with a set of denied blocks produces byte-for-byte what
 * orchestrator/diff.ts's applyAcceptedBlocks() will write to disk. What you
 * see in the editor is what lands.
 */

export type ReviewRowKind = 'context' | 'add' | 'del';

export type ReviewRow = {
  kind: ReviewRowKind;
  text: string;
  /** The hunk this row belongs to; null for untouched lines outside any hunk. */
  blockId: string | null;
};

/** Structurally what DiffReview's FileDiffView / the protocol's FileDiff give us. */
export type ReviewDiff = {
  path: string;
  oldContent: string | null;
  newContent: string;
  blocks: { id: string; header: string; lines: { type: ReviewRowKind; text: string }[] }[];
};

/**
 * `@@ -aStart,aCount +bStart,bCount @@` -> zero-based aStart, and aCount = how
 * many ORIGINAL lines this hunk's slice covers (its context plus its deletions).
 */
function parseHunkHeader(header: string): { aStart: number; aCount: number } | null {
  const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(header);
  if (!m) return null;
  return { aStart: Number(m[1]) - 1, aCount: Number(m[2]) };
}

/** Same line split orchestrator/diff.ts uses, so a trailing newline round-trips. */
function toLines(text: string | null): string[] {
  return text == null ? [] : text.split('\n');
}

export function buildReviewRows(diff: ReviewDiff): ReviewRow[] {
  const original = toLines(diff.oldContent);
  const rows: ReviewRow[] = [];
  let cursor = 0;

  for (const block of diff.blocks) {
    const parsed = parseHunkHeader(block.header);
    // A header we cannot parse would silently corrupt the buffer, so fall back
    // to "starts where the last hunk ended" rather than guessing an offset.
    const aStart = parsed ? parsed.aStart : cursor;
    const aCount = parsed ? parsed.aCount : 0;

    for (let i = cursor; i < aStart && i < original.length; i++) {
      rows.push({ kind: 'context', text: original[i], blockId: null });
    }
    for (const line of block.lines) {
      rows.push({ kind: line.type, text: line.text, blockId: block.id });
    }
    cursor = Math.max(cursor, aStart + aCount);
  }

  for (let i = cursor; i < original.length; i++) {
    rows.push({ kind: 'context', text: original[i], blockId: null });
  }
  return rows;
}

/**
 * Fold the rows down to the file content that a given set of DENIED blocks
 * would produce. A denied hunk keeps its deletions and drops its additions —
 * i.e. that part of the file stays exactly as it was.
 *
 * This is the preview's contract with the orchestrator: for the same decision,
 * this must equal applyAcceptedBlocks(diff, keptIds).
 */
export function applyDecisionsToRows(rows: ReviewRow[], denied: Set<string>): string {
  const out: string[] = [];
  for (const row of rows) {
    const isDenied = row.blockId != null && denied.has(row.blockId);
    if (row.kind === 'context') out.push(row.text);
    else if (row.kind === 'add') {
      if (!isDenied) out.push(row.text);
    } else if (isDenied) {
      out.push(row.text);
    }
  }
  return out.join('\n');
}

/** Per-hunk +/- counts, for the label on each Keep/Deny toolbar. */
export function blockStats(rows: ReviewRow[], blockId: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.blockId !== blockId) continue;
    if (row.kind === 'add') added++;
    else if (row.kind === 'del') removed++;
  }
  return { added, removed };
}

/** 1-based line number of a hunk's first row in the review buffer. */
export function firstLineOfBlock(rows: ReviewRow[], blockId: string): number {
  const idx = rows.findIndex((r) => r.blockId === blockId);
  return idx < 0 ? 1 : idx + 1;
}
