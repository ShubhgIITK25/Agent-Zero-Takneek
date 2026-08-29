'use client';

/**
 * INLINE DIFF REVIEW, IN THE EDITOR — the VSCode-style approval surface.
 *
 * One read-only Monaco buffer holding the whole file with the agent's proposal
 * spliced in: deleted lines red and struck through, added lines green, and a
 * small Keep / Deny toolbar floating above each hunk. Nothing is on disk yet —
 * the orchestrator is blocked on the decision this collects — so "Deny" is
 * genuinely a no-op rather than an undo.
 *
 * WHY VIEW ZONES RATHER THAN ABSOLUTELY-POSITIONED REACT OVERLAYS.
 * A hunk toolbar has to sit *between* two lines of code and stay glued there
 * while the user scrolls, folds, or resizes. A React overlay positioned from
 * `getTopForLineNumber` needs a scroll listener and still drifts on every
 * layout change Monaco does internally. A view zone IS a line of the editor's
 * own layout: Monaco reserves the space and moves it, so it cannot desync.
 * This is the same mechanism VSCode's own inline chat uses.
 *
 * The zones are built once per mount and only their `data-state` is touched
 * afterwards — the parent keys this component per approval, so a new proposal
 * is a fresh mount rather than a diff of DOM that Monaco half-owns.
 */

import Editor, { OnMount } from '@monaco-editor/react';
import { useEffect, useMemo, useRef } from 'react';
import { languageFromPath } from '../lib/language';
import { ReviewDiff, blockStats, buildReviewRows, firstLineOfBlock } from '../lib/review-buffer';

export type HunkDecision = 'keep' | 'deny';

type InlineDiffEditorProps = {
  diff: ReviewDiff;
  /** Block ids the user has denied. Everything else is kept. */
  denied: Set<string>;
  onSetDecision: (blockId: string, decision: HunkDecision) => void;
  /** Scroll this hunk into view — set by the pane's next/previous buttons. */
  focusBlockId?: string | null;
  /** Locked while the decision is in flight, so a hunk cannot change under it. */
  locked?: boolean;
};

export default function InlineDiffEditor({
  diff,
  denied,
  onSetDecision,
  focusBlockId,
  locked = false,
}: InlineDiffEditorProps) {
  const rows = useMemo(() => buildReviewRows(diff), [diff]);
  const value = useMemo(() => rows.map((r) => r.text).join('\n'), [rows]);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const decorationsRef = useRef<{ set: (d: unknown[]) => void } | null>(null);
  const legacyIdsRef = useRef<string[]>([]);
  const barsRef = useRef<Map<string, HTMLElement>>(new Map());

  // The zone buttons are plain DOM created once, so their click handlers would
  // otherwise close over the first render's props forever.
  const onSetDecisionRef = useRef(onSetDecision);
  const lockedRef = useRef(locked);
  useEffect(() => {
    onSetDecisionRef.current = onSetDecision;
    lockedRef.current = locked;
  });

  const paintDecorations = () => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const decorations: unknown[] = [];
    rows.forEach((row, i) => {
      if (row.kind === 'context') return;
      const off = row.blockId != null && denied.has(row.blockId);
      // A denied addition is greyed rather than removed: the user needs to see
      // what they turned down, not have it silently vanish from the buffer.
      const cls =
        row.kind === 'add' ? (off ? 'nx-line-add-off' : 'nx-line-add') : off ? 'nx-line-del-off' : 'nx-line-del';
      const line = i + 1;
      decorations.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: cls,
          linesDecorationsClassName: `${cls}-gutter`,
        },
      });

      // Strikethrough carries one meaning throughout: "this text will NOT be
      // in the saved file". True of an addition the user denied, and equally
      // true of a deletion the user kept. isWholeLine decorations paint behind
      // the text, so striking it needs a second, inline decoration.
      const struck = row.kind === 'add' ? off : !off;
      if (struck && row.text.length > 0) {
        decorations.push({
          range: new monaco.Range(line, 1, line, row.text.length + 1),
          options: { inlineClassName: 'nx-text-struck' },
        });
      }
    });

    // createDecorationsCollection is the current API; deltaDecorations is kept
    // as a fallback so this does not depend on the bundled Monaco version.
    const anyEditor = editor as unknown as {
      createDecorationsCollection?: (d: unknown[]) => { set: (d: unknown[]) => void };
      deltaDecorations?: (old: string[], next: unknown[]) => string[];
    };
    if (decorationsRef.current) {
      decorationsRef.current.set(decorations);
    } else if (typeof anyEditor.createDecorationsCollection === 'function') {
      decorationsRef.current = anyEditor.createDecorationsCollection(decorations);
    } else if (typeof anyEditor.deltaDecorations === 'function') {
      legacyIdsRef.current = anyEditor.deltaDecorations(legacyIdsRef.current, decorations);
    }
  };

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    editor.changeViewZones((accessor) => {
      for (const block of diff.blocks) {
        const anchor = firstLineOfBlock(rows, block.id);
        const { added, removed } = blockStats(rows, block.id);

        const bar = document.createElement('div');
        bar.className = 'nx-hunk-bar';
        bar.dataset.state = denied.has(block.id) ? 'deny' : 'keep';

        const stat = document.createElement('span');
        stat.className = 'nx-hunk-stat';
        const parts: string[] = [];
        if (added) parts.push(`+${added}`);
        if (removed) parts.push(`−${removed}`);
        stat.textContent = parts.join(' ') || 'no change';

        const state = document.createElement('span');
        state.className = 'nx-hunk-state';

        const keep = document.createElement('button');
        keep.type = 'button';
        keep.className = 'nx-hunk-btn nx-hunk-btn-keep';
        keep.textContent = 'Keep';
        keep.onclick = () => {
          if (!lockedRef.current) onSetDecisionRef.current(block.id, 'keep');
        };

        const deny = document.createElement('button');
        deny.type = 'button';
        deny.className = 'nx-hunk-btn nx-hunk-btn-deny';
        deny.textContent = 'Deny';
        deny.onclick = () => {
          if (!lockedRef.current) onSetDecisionRef.current(block.id, 'deny');
        };

        bar.append(stat, state, keep, deny);
        barsRef.current.set(block.id, bar);

        accessor.addZone({
          // afterLineNumber 0 is legal and puts the bar above line 1, which is
          // where a hunk at the top of the file needs it.
          afterLineNumber: Math.max(0, anchor - 1),
          heightInPx: 30,
          domNode: bar,
        });
      }
    });

    paintDecorations();
  };

  // Decisions changed: repaint the lines and retag the toolbars. The zones
  // themselves are never rebuilt, so nothing reflows and nothing flickers.
  useEffect(() => {
    paintDecorations();
    for (const [blockId, bar] of barsRef.current) {
      const off = denied.has(blockId);
      bar.dataset.state = off ? 'deny' : 'keep';
      const state = bar.querySelector('.nx-hunk-state');
      if (state) state.textContent = off ? 'will not be applied' : 'will be applied';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denied, rows]);

  useEffect(() => {
    for (const bar of barsRef.current.values()) bar.dataset.locked = locked ? 'yes' : 'no';
  }, [locked]);

  useEffect(() => {
    if (!focusBlockId || !editorRef.current) return;
    const line = firstLineOfBlock(rows, focusBlockId);
    editorRef.current.revealLineInCenter(line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBlockId]);

  return (
    <Editor
      height="100%"
      theme="vs-dark"
      // A synthetic scheme keeps this buffer's model separate from the real
      // editor's model for the same file — otherwise opening the file being
      // reviewed would show the diff preview as if it were the file on disk.
      path={`nexide-review://${diff.path}`}
      language={languageFromPath(diff.path)}
      value={value}
      onMount={handleMount}
      options={{
        readOnly: true,
        domReadOnly: true,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        lineNumbers: 'on',
        glyphMargin: false,
        folding: false,
        tabSize: 2,
        wordWrap: 'off',
        smoothScrolling: true,
        contextmenu: false,
      }}
    />
  );
}
