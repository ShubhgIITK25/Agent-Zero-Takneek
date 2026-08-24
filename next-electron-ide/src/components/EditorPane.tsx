'use client';

import Editor, { OnMount } from '@monaco-editor/react';
import { useRef } from 'react';
import { languageFromPath } from '../lib/language';

type EditorPaneProps = {
  filePath: string | null;
  content: string;
  onChange: (value: string) => void;
  onSave: () => void;
};

export default function EditorPane({ filePath, content, onChange, onSave }: EditorPaneProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSave();
    });
  };

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
