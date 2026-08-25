'use client';

import { useEffect, useState } from 'react';
import type { AgentSettings } from '../lib/electron-api';

type SettingsPanelProps = {
  onClose: () => void;
};

type Row = { key: string; value: string; reveal: boolean };

function settingsToRows(settings: AgentSettings): Row[] {
  return Object.entries(settings.envVars).map(([key, value]) => ({ key, value, reveal: false }));
}

function rowsToSettings(rows: Row[]): AgentSettings {
  const envVars: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) envVars[key] = row.value;
  }
  return { envVars };
}

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.settingsGet().then((settings) => {
      if (cancelled) return;
      setRows(settingsToRows(settings));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateRow = (index: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const removeRow = (index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const addRow = () => {
    setRows((prev) => [...prev, { key: '', value: '', reveal: true }]);
  };

  const handleSave = async () => {
    if (!window.electronAPI) return;
    setSaveState('saving');
    await window.electronAPI.settingsSet(rowsToSettings(rows));
    setSaveState('saved');
    setTimeout(() => setSaveState('idle'), 1200);
  };

  return (
    <div className="settings-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-modal">
        <div className="settings-header">
          <span>Agent Settings</span>
          <button className="terminal-close-btn" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <div className="settings-body">
          <p className="settings-hint">
            API keys and other environment variables the agent needs (e.g.{' '}
            <code>OPENROUTER_API_KEY</code>, <code>GROQ_API_KEY</code>,{' '}
            <code>OLLAMA_HOST</code>). Stored locally outside the project folder —
            never committed to git. Read these from{' '}
            <code>window.electronAPI.settingsGet()</code> in{' '}
            <code>src/lib/agent.ts</code>.
          </p>

          {loading ? (
            <p className="settings-hint">Loading…</p>
          ) : (
            <div className="settings-rows">
              {rows.length === 0 && (
                <p className="settings-hint settings-empty">
                  No variables set yet. Add one below.
                </p>
              )}
              {rows.map((row, i) => (
                <div className="settings-row" key={i}>
                  <input
                    type="text"
                    className="settings-key-input"
                    placeholder="KEY_NAME"
                    value={row.key}
                    onChange={(e) => updateRow(i, { key: e.target.value.toUpperCase() })}
                  />
                  <input
                    type={row.reveal ? 'text' : 'password'}
                    className="settings-value-input"
                    placeholder="value"
                    value={row.value}
                    onChange={(e) => updateRow(i, { value: e.target.value })}
                  />
                  <button
                    type="button"
                    className="chat-icon-btn"
                    title={row.reveal ? 'Hide' : 'Show'}
                    onClick={() => updateRow(i, { reveal: !row.reveal })}
                  >
                    {row.reveal ? '🙈' : '👁'}
                  </button>
                  <button
                    type="button"
                    className="terminal-close-btn"
                    title="Remove"
                    onClick={() => removeRow(i)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <button type="button" className="settings-add-row" onClick={addRow}>
            + Add variable
          </button>
        </div>

        <div className="settings-footer">
          <button type="button" onClick={onClose} className="settings-cancel-btn">
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={saveState === 'saving'}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
