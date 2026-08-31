'use client';

import Editor, { OnMount } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import { languageFromPath } from '../lib/language';

type EditorPaneProps = {
  filePath: string | null;
  content: string;
  /** Scroll to and highlight this line — set when a clickable file:line tag
   *  in the agent chat is followed. */
  revealLine?: number;
  onChange: (value: string) => void;
  onSave: () => void | Promise<void>;
  onSaveAs?: () => void | Promise<void>;
};

export default function EditorPane({ filePath, content, revealLine, onChange, onSave, onSaveAs }: EditorPaneProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const onSaveRef = useRef(onSave);
  const onSaveAsRef = useRef(onSaveAs);

  // Monaco registers keyboard commands once when the editor mounts. Keep the
  // latest callback in a ref so Ctrl/Cmd+S saves the currently active file,
  // rather than the "no file selected" state from that first mount.
  useEffect(() => {
    onSaveRef.current = onSave;
    onSaveAsRef.current = onSaveAs;
  }, [onSave, onSaveAs]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void onSaveRef.current();
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => {
      void onSaveAsRef.current?.();
    });
  };

  // Following a file:line tag from the chat scrolls the editor to that line.
  useEffect(() => {
    if (!revealLine || !editorRef.current) return;
    const editor = editorRef.current;
    editor.revealLineInCenter(revealLine);
    editor.setPosition({ lineNumber: revealLine, column: 1 });
    editor.focus();
  }, [revealLine, filePath]);

  if (!filePath) {
    return (
      <div className="editor-empty">
        <div>
          <h2>No file open</h2>
          <p>Open a folder from the sidebar and select a file to start editing.</p>
          <p className="hint">Ctrl/Cmd + S to save</p>
        </div>
      </div>
    );
  }

  return (
    <Editor
      height="100%"
      theme="vs-dark"
      path={filePath}
      language={languageFromPath(filePath)}
      value={content}
      onMount={handleMount}
      onChange={(value) => onChange(value ?? '')}
      options={{
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
        minimap: { enabled: true },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        tabSize: 2,
        wordWrap: 'off',
        smoothScrolling: true,
        cursorBlinking: 'smooth',
      }}
    />
  );
}
