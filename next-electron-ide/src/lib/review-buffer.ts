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
 * window, or a different diff implementation — means the user keeps the hunk
 * they can see and the orchestrator applies a different set of lines.
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
  /** Metadata carried on the first row so folding can preserve EOF newlines. */
  oldTrailingNewline?: boolean;
  newTrailingNewline?: boolean;
  newlineBlockId?: string;
};

/** Structurally what DiffReview's FileDiffView / the protocol's FileDiff give us. */
export type ReviewDiff = {
  path: string;
  oldContent: string | null;
  newContent: string;
  blocks: {
    id: string;
    header: string;
    lines: { type: ReviewRowKind; text: string }[];
    newlineChanged?: boolean;
  }[];
};

/**
 * `@@ -aStart,aCount +bStart,bCount @@` -> zero-based aStart, and aCount = how
 * many ORIGINAL lines this hunk's slice covers (its context plus its deletions).
 */
function parseHunkHeader(header: string): { aStart: number; aCount: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!m) return null;
  return { aStart: Math.max(0, Number(m[1]) - 1), aCount: m[2] == null ? 1 : Number(m[2]) };
}

/** Same logical line split as orchestrator/diff.ts. */
function toLines(text: string | null): string[] {
  if (text == null || text.length === 0) return [];
  const trailing = text.endsWith('\n');
  const body = trailing ? text.slice(0, -1) : text;
  return body.length === 0 && trailing ? [''] : body.split('\n');
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

  if (rows.length > 0) {
    const oldTrailingNewline = diff.oldContent?.endsWith('\n') ?? false;
    const newTrailingNewline = diff.newContent.endsWith('\n');
    const newlineBlockId =
      diff.blocks.find((b) => b.newlineChanged)?.id ??
      (oldTrailingNewline !== newTrailingNewline ? diff.blocks.at(-1)?.id : undefined);
    rows[0] = { ...rows[0], oldTrailingNewline, newTrailingNewline, newlineBlockId };
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
  const metadata = rows.find((row) => row.oldTrailingNewline !== undefined);
  let trailingNewline = metadata?.oldTrailingNewline ?? false;
  for (const row of rows) {
    const isDenied = row.blockId != null && denied.has(row.blockId);
    if (row.kind === 'context') out.push(row.text);
    else if (row.kind === 'add') {
      if (!isDenied) out.push(row.text);
    } else if (isDenied) {
      out.push(row.text);
    }
    if (metadata?.newlineBlockId && !denied.has(metadata.newlineBlockId)) {
      trailingNewline = metadata.newTrailingNewline ?? trailingNewline;
    }
  }
  return out.join('\n') + (trailingNewline ? '\n' : '');
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
