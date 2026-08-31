'use client';

/**
 * The approval gate, as an editor surface rather than a chat widget.
 *
 * Everything the orchestrator is blocked on lives here: the proposal summary,
 * a tab per touched file, per-hunk Keep/Deny (in InlineDiffEditor), and the
 * single Apply / Deny-everything decision that unblocks the task.
 *
 * ONE DECISION, NOT MANY. The orchestrator raises one approval_request and
 * waits on one answer carrying the accepted block ids, so per-hunk Keep/Deny
 * marks intent and Apply is what actually sends. That ordering matters: a
 * hunk-by-hunk send would leave the task half-answered if the user walked away
 * mid-review, and there is no protocol message to take a decision back.
 */

import { useMemo, useState } from 'react';
import InlineDiffEditor from './InlineDiffEditor';
import { ReviewDiff } from '../lib/review-buffer';

type DiffReviewPaneProps = {
  summary: string;
  diffs: ReviewDiff[];
  /** Resolves false when the decision could not be delivered, so the buttons
   *  come back and the user can retry rather than the task hanging silently. */
  onDecide: (approved: boolean, acceptedBlockIds: string[]) => Promise<boolean>;
};

export default function DiffReviewPane({ summary, diffs, onDecide }: DiffReviewPaneProps) {
  const allBlockIds = useMemo(() => diffs.flatMap((d) => d.blocks.map((b) => b.id)), [diffs]);
  const [denied, setDenied] = useState<Set<string>>(new Set());
  const [activeFile, setActiveFile] = useState(0);
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null);
  const [navIndex, setNavIndex] = useState(0);
  const [sent, setSent] = useState(false);

  const active = diffs[Math.min(activeFile, diffs.length - 1)];
  const fileBlockIds = active?.blocks.map((b) => b.id) ?? [];
  const keptCount = allBlockIds.length - denied.size;

  const setDecision = (blockId: string, decision: 'keep' | 'deny') => {
    setDenied((prev) => {
      const next = new Set(prev);
      if (decision === 'deny') next.add(blockId);
      else next.delete(blockId);
      return next;
    });
  };

  const jump = (delta: number) => {
    if (fileBlockIds.length === 0) return;
    const next = (navIndex + delta + fileBlockIds.length) % fileBlockIds.length;
    setNavIndex(next);
    setFocusBlockId(fileBlockIds[next]);
  };

  const decide = async (approved: boolean, ids: string[]) => {
    if (sent) return;
    setSent(true);
    const delivered = await onDecide(approved, ids);
    // Only release the buttons on failure - on success the pane unmounts.
    if (!delivered) setSent(false);
  };

  if (!active) return null;

  return (
    <div className="review-pane">
      <div className="review-head">
        <div className="review-head-main">
          <span className="review-badge">Agent proposal</span>
          <span className="review-summary">{summary}</span>
        </div>
        <span className="review-head-note">Nothing is written until you apply.</span>
      </div>

      {diffs.length > 1 && (
        <div className="review-tabs">
          {diffs.map((d, i) => {
            const off = d.blocks.filter((b) => denied.has(b.id)).length;
            return (
              <button
                key={d.path}
                type="button"
                className={`review-tab${i === activeFile ? ' active' : ''}`}
                onClick={() => {
                  setActiveFile(i);
                  setNavIndex(0);
                  setFocusBlockId(null);
                }}
              >
                {d.path.split(/[\\/]/).pop()}
                <span className="review-tab-count">
                  {d.blocks.length - off}/{d.blocks.length}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="review-toolbar">
        <div className="review-path" title={active.path}>
          {active.path}
          {active.oldContent === null && <span className="review-new-badge">new file</span>}
        </div>

        <div className="review-nav">
          <button type="button" onClick={() => jump(-1)} disabled={fileBlockIds.length < 2} title="Previous change">
            ↑
          </button>
          <span className="review-nav-label">
            {fileBlockIds.length ? `${navIndex + 1} / ${fileBlockIds.length}` : '0'}
          </span>
          <button type="button" onClick={() => jump(1)} disabled={fileBlockIds.length < 2} title="Next change">
            ↓
          </button>
        </div>

        <div className="review-bulk">
          <button
            type="button"
            className="review-bulk-btn"
            onClick={() => setDenied(new Set())}
            disabled={sent || denied.size === 0}
          >
            Keep all
          </button>
          <button
            type="button"
            className="review-bulk-btn"
            onClick={() => setDenied(new Set(allBlockIds))}
            disabled={sent || denied.size === allBlockIds.length}
          >
            Deny all
          </button>
        </div>
      </div>

      <div className="review-editor">
        <InlineDiffEditor
          key={active.path}
          diff={active}
          denied={denied}
          onSetDecision={setDecision}
          focusBlockId={focusBlockId}
          locked={sent}
        />
      </div>

      <div className="review-actions">
        <span className="review-actions-count">
          {keptCount} of {allBlockIds.length} change{allBlockIds.length === 1 ? '' : 's'} kept
          {keptCount > 0 && keptCount < allBlockIds.length && <span className="review-partial"> · partial</span>}
        </span>
        <button type="button" className="review-btn review-btn-deny" onClick={() => decide(false, [])} disabled={sent}>
          Deny everything
        </button>
        <button
          type="button"
          className="review-btn review-btn-apply"
          onClick={() => decide(true, allBlockIds.filter((id) => !denied.has(id)))}
          disabled={sent || keptCount === 0}
        >
          {sent ? 'Applying...' : `Apply ${keptCount} change${keptCount === 1 ? '' : 's'}`}
        </button>
        <button
          type="button"
          className="review-btn review-btn-approve-all"
          onClick={() => decide(true, allBlockIds)}
          disabled={sent || allBlockIds.length === 0}
          title="Keep every hunk and apply immediately"
        >
          {sent ? 'Applying...' : 'Approve all'}
        </button>
      </div>
    </div>
  );
}
