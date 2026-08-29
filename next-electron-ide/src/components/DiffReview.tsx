'use client';

/**
 * HUMAN-IN-THE-LOOP DIFF REVIEW
 *
 * Block-by-block accept/reject plus accept-all/reject-all. The blocks are real
 * unified-diff hunks computed by orchestrator/diff.ts from the file on disk vs
 * the agent's proposal — nothing has been written yet when this renders, so
 * rejecting is genuinely a no-op on the filesystem rather than an undo.
 *
 * Partial approval is the interesting case: the orchestrator rebuilds the file
 * from the original plus only the accepted hunks, then tells the agent exactly
 * what landed, so its next step reasons about the real file rather than the
 * one it proposed.
 *
 * LAYOUT: this lives in a ~360px sidebar and a diff is arbitrarily long, so the
 * hunks scroll inside their own box and the action bar is sticky. Previously a
 * 40-line proposal pushed Accept/Reject past the bottom of the panel, which
 * made the gate look broken — the orchestrator was blocked waiting on a button
 * the user could not reach. Each hunk also collapses past a threshold, so a
 * multi-hunk review stays navigable instead of being one endless column.
 */

import { useState } from 'react';

export type DiffBlockView = {
  id: string;
  header: string;
  lines: { type: 'context' | 'add' | 'del'; text: string }[];
};

export type FileDiffView = {
  path: string;
  oldContent: string | null;
  newContent: string;
  blocks: DiffBlockView[];
};

type DiffReviewProps = {
  summary: string;
  diffs: FileDiffView[];
  /** Resolves false when the decision could not be delivered, so the buttons
   *  come back and the user can retry instead of the task hanging silently. */
  onDecide: (approved: boolean, acceptedBlockIds: string[]) => Promise<boolean>;
};

/** Hunks longer than this start collapsed, with a click to expand. */
const COLLAPSE_OVER_LINES = 18;

function BlockView({
  block,
  on,
  onToggle,
}: {
  block: DiffBlockView;
  on: boolean;
  onToggle: () => void;
}) {
  const long = block.lines.length > COLLAPSE_OVER_LINES;
  const [expanded, setExpanded] = useState(!long);
  const shown = expanded ? block.lines : block.lines.slice(0, COLLAPSE_OVER_LINES);
  const added = block.lines.filter((l) => l.type === 'add').length;
  const removed = block.lines.filter((l) => l.type === 'del').length;

  return (
    <div className={`diff-block${on ? ' diff-block-on' : ' diff-block-off'}`}>
      <div className="diff-block-head">
        <label className="diff-block-toggle">
          <input type="checkbox" checked={on} onChange={onToggle} />
          <span>{on ? 'Accept' : 'Rejected'}</span>
        </label>
        <code className="diff-hunk-header">{block.header}</code>
        <span className="diff-block-stat">
          {added > 0 && <span className="diff-stat-add">+{added}</span>}
          {removed > 0 && <span className="diff-stat-del">-{removed}</span>}
        </span>
      </div>
      <pre className="diff-lines">
        {shown.map((l, i) => (
          <div key={i} className={`diff-line diff-line-${l.type}`}>
            <span className="diff-gutter">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
            <span className="diff-text">{l.text || ' '}</span>
          </div>
        ))}
      </pre>
      {long && (
        <button type="button" className="diff-expand" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Collapse' : `Show ${block.lines.length - COLLAPSE_OVER_LINES} more lines`}
        </button>
      )}
    </div>
  );
}

export default function DiffReview({ summary, diffs, onDecide }: DiffReviewProps) {
  const allBlockIds = diffs.flatMap((d) => d.blocks.map((b) => b.id));
  const [accepted, setAccepted] = useState<Set<string>>(new Set(allBlockIds));
  // The orchestrator is blocked on this decision, so a double-click must not
  // send two answers — the second would have no pending approval to resolve.
  const [sent, setSent] = useState(false);

  const toggle = (id: string) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const decide = async (approved: boolean, ids: string[]) => {
    if (sent) return;
    setSent(true);
    const delivered = await onDecide(approved, ids);
    if (!delivered) setSent(false);
  };

  const acceptedCount = accepted.size;
  const isPartial = acceptedCount > 0 && acceptedCount < allBlockIds.length;

  return (
    <div className="diff-review">
      <div className="diff-review-head">
        <span className="diff-review-summary">{summary}</span>
        <span className="diff-review-count">
          {acceptedCount}/{allBlockIds.length} blocks
          {isPartial && <span className="diff-partial-flag"> · partial</span>}
        </span>
      </div>

      <div className="diff-review-body">
        {diffs.map((d) => (
          <div key={d.path} className="diff-file">
            <div className="diff-file-head">
              <span className="diff-file-path">{d.path}</span>
              {d.oldContent === null && <span className="diff-new-badge">new file</span>}
            </div>
            {d.blocks.map((b) => (
              <BlockView key={b.id} block={b} on={accepted.has(b.id)} onToggle={() => toggle(b.id)} />
            ))}
          </div>
        ))}
      </div>

      <div className="diff-review-actions">
        <button
          type="button"
          className="diff-btn diff-btn-reject"
          onClick={() => decide(false, [])}
          disabled={sent}
        >
          Reject all
        </button>
        <button
          type="button"
          className="diff-btn diff-btn-secondary"
          onClick={() => setAccepted(new Set(allBlockIds))}
          disabled={sent || acceptedCount === allBlockIds.length}
        >
          Select all
        </button>
        <button
          type="button"
          className="diff-btn diff-btn-accept"
          onClick={() => decide(true, [...accepted])}
          disabled={sent || acceptedCount === 0}
        >
          {sent ? 'Applying…' : isPartial ? `Apply ${acceptedCount} selected` : 'Accept all'}
        </button>
      </div>
    </div>
  );
}
