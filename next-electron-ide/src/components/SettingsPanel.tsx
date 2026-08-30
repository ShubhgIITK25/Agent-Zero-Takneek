'use client';

/**
 * SETTINGS — API keys (mandatory per the PS) and the model roster.
 *
 * The roster half is not decoration: the router can only ever pick from what
 * is enabled here, and `checkEligibility` (orchestrator/models.ts) is the same
 * function the router calls, so an ineligible model cannot be enabled from
 * this screen even by accident.
 *
 * The list is FILTERED to eligible models, so every row here is selectable and
 * none carries an "eligible" badge — a badge that reads the same on every row
 * is noise, not information. The 80B rule and the models it blocks are
 * documented in the README and enforced in models.ts; this screen is for
 * choosing among the models you can actually use.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentSettings, ModelHealth, ModelHealthState } from '../lib/electron-api';
import { MODEL_REGISTRY, checkEligibility, PROVIDER_CONFIG, ProviderId } from '../../orchestrator/models';

type SettingsPanelProps = { onClose: () => void };

/**
 * Pill label + the fix, per health state. The label says what is wrong; the
 * tooltip carries what was actually observed plus the action that resolves it,
 * because "unavailable" on its own tells the user nothing they can act on.
 */
const HEALTH_LABEL: Record<ModelHealthState, string> = {
  working: 'working',
  'invalid-key': 'invalid key',
  'rate-limited': 'rate-limited',
  unavailable: 'unavailable',
  offline: 'offline',
  unknown: 'not checked',
};

const PROVIDER_HELP: Record<ProviderId, { url: string; hint: string }> = {
  groq: { url: 'console.groq.com/keys', hint: 'Free tier, no card. Fastest of the three.' },
  openrouter: { url: 'openrouter.ai/keys', hint: 'Free routes available; used as the failover provider.' },
  ollama: { url: 'ollama.com', hint: 'Runs locally — no key, no cost. Set the host if it is not the default.' },
  gemini: { url: 'aistudio.google.com/apikey', hint: 'Google Gemini — get a free key from AI Studio.' },
};

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<'models' | 'keys'>('models');
  const [health, setHealth] = useState<Record<string, ModelHealth>>({});
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const s = await window.electronAPI?.settingsGet();
      setSettings(
        s ?? { envVars: {}, enabledModelIds: ['ollama:llama3.1-8b'], maxCostUsd: 0.5, maxSeconds: 2700, maxParallelSubtasks: 3 }
      );
    })();
  }, []);

  const byProvider = useMemo(() => {
    const groups: Record<string, typeof MODEL_REGISTRY> = {};
    for (const m of MODEL_REGISTRY) (groups[m.provider] ??= []).push(m);
    return groups;
  }, []);

  /**
   * Only eligible models are probed. An ineligible one can never be routed to,
   * so its liveness is not a fact worth spending a request on.
   *
   * `envVars` is passed rather than read in the main process on purpose: it
   * checks the keys currently TYPED IN THE FORM, not the last saved ones, so
   * you can paste a key and verify it before committing it to disk.
   */
  const runHealthCheck = useCallback(async (envVars: Record<string, string>) => {
    if (!window.electronAPI?.modelsCheckHealth) return;
    setChecking(true);
    try {
      const models = MODEL_REGISTRY.filter((m) => checkEligibility(m).eligible).map((m) => ({
        id: m.id,
        apiId: m.apiId,
        provider: m.provider,
      }));
      setHealth(await window.electronAPI.modelsCheckHealth({ models, envVars }));
      setLastChecked(Date.now());
    } finally {
      setChecking(false);
    }
  }, []);

  // Check once as soon as settings load. Opening this screen is exactly the
  // moment the user wants to know whether their roster works, and making them
  // press a button first would mean the common case is a screen full of
  // "not checked".
  const envVarsKey = settings ? JSON.stringify(settings.envVars) : null;
  useEffect(() => {
    if (envVarsKey === null) return;
    void runHealthCheck(JSON.parse(envVarsKey));
    // Re-probing on every keystroke in a key field would hammer the providers,
    // so this deliberately depends on the initial load only; the Re-check
    // button covers the "I just pasted a key" case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envVarsKey === null]);

  if (!settings) {
    return (
      <div className="settings-overlay">
        <div className="settings-panel">
          <p className="settings-loading">Loading settings…</p>
        </div>
      </div>
    );
  }

  const update = (patch: Partial<AgentSettings>) => {
    setSettings({ ...settings, ...patch });
    setSaved(false);
  };

  const toggleModel = (id: string) => {
    const next = settings.enabledModelIds.includes(id)
      ? settings.enabledModelIds.filter((x) => x !== id)
      : [...settings.enabledModelIds, id];
    update({ enabledModelIds: next });
  };

  const setEnv = (key: string, value: string) => {
    update({ envVars: { ...settings.envVars, [key]: value } });
  };

  const save = async () => {
    await window.electronAPI?.settingsSet(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const enabledCount = settings.enabledModelIds.length;
  const missingKeys = (Object.keys(byProvider) as ProviderId[]).filter((p) => {
    const usesProvider = settings.enabledModelIds.some(
      (id) => MODEL_REGISTRY.find((m) => m.id === id)?.provider === p
    );
    const cfg = PROVIDER_CONFIG[p];
    return usesProvider && !cfg.optional && !settings.envVars[cfg.keyName];
  });

  return (
    <div className="settings-overlay" role="dialog" aria-label="Agent settings">
      <div className="settings-panel settings-panel-wide">
        <header className="settings-header">
          <h2>Agent Settings</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </header>

        <div className="settings-tabs">
          {(['models', 'keys'] as const).map((t) => (
            <button key={t} type="button" className={`settings-tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {t === 'models' ? `Models (${enabledCount} enabled)` : 'API Keys'}
            </button>
          ))}
        </div>

        {missingKeys.length > 0 && (
          <div className="settings-warning">
            You have enabled models from {missingKeys.map((p) => PROVIDER_CONFIG[p].label).join(' and ')} but have not
            entered {missingKeys.length > 1 ? 'their keys' : 'its key'} yet. Add {missingKeys.length > 1 ? 'them' : 'it'} on
            the API Keys tab, or those calls will fail.
          </div>
        )}

        <div className="settings-body">
          {tab === 'models' && (
            <>
              <p className="settings-intro">
                The router picks from the models you enable here. Every model listed has a published{' '}
                <strong>total</strong> parameter count of 80B or less — active/expert count does not apply, so an
                MoE model counts as its full size, not the fraction that activates per token.
              </p>

              <div className="parallel-setting">
                <label htmlFor="max-parallel">Run independent subtasks in parallel</label>
                <select
                  id="max-parallel"
                  value={settings.maxParallelSubtasks ?? 3}
                  onChange={(e) =>
                    setSettings({ ...settings, maxParallelSubtasks: Number(e.target.value) })
                  }
                >
                  <option value={1}>1 — one at a time (sequential)</option>
                  <option value={2}>2 agents</option>
                  <option value={3}>3 agents</option>
                  <option value={4}>4 agents</option>
                  <option value={6}>6 agents</option>
                </select>
                <p className="settings-hint">
                  Only subtasks whose dependencies are already done run together, so the plan&apos;s
                  ordering is unchanged. Higher values finish a wide plan sooner but hit free-tier rate
                  limits faster; the scheduler drops back to one automatically once the cost ceiling is
                  close. Set 1 for the strictly sequential behaviour.
                </p>
              </div>

              <div className="health-bar">
                <span className="health-bar-summary">
                  {checking ? (
                    'Checking providers…'
                  ) : lastChecked ? (
                    <>
                      {(['working', 'invalid-key', 'rate-limited', 'unavailable', 'offline'] as const)
                        .map((s) => ({ s, n: Object.values(health).filter((h) => h.state === s).length }))
                        .filter(({ n }) => n > 0)
                        .map(({ s, n }) => (
                          <span key={s} className={`health-count health-count-${s}`}>
                            {n} {HEALTH_LABEL[s]}
                          </span>
                        ))}
                    </>
                  ) : (
                    'Model health not checked yet.'
                  )}
                </span>
                <button
                  type="button"
                  className="health-recheck"
                  disabled={checking}
                  onClick={() => void runHealthCheck(settings.envVars)}
                  title="Probe each provider's catalogue with the keys currently in the form"
                >
                  {checking ? 'Checking…' : 'Re-check'}
                </button>
              </div>

              {(Object.keys(byProvider) as ProviderId[]).map((provider) => {
                const visibleModels = byProvider[provider].filter((m) => checkEligibility(m).eligible);
                if (visibleModels.length === 0) return null;

                return (
                  <section key={provider} className="settings-provider">
                    <h3>
                      {PROVIDER_CONFIG[provider].label}
                      <span className="settings-provider-hint">{PROVIDER_HELP[provider].hint}</span>
                    </h3>
                    <div className="model-list">
                      {visibleModels.map((m) => {
                        const enabled = settings.enabledModelIds.includes(m.id);
                        return (
                          <label
                            key={m.id}
                            className={`model-row${enabled ? ' model-row-on' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={() => toggleModel(m.id)}
                            />
                            <span className="model-main">
                              <span className="model-name">{m.label}</span>
                              <span className="model-api-id">{m.apiId}</span>
                            </span>
                            <span className="model-meta">
                              <span className="model-params">
                                {m.paramsBTotal == null ? 'unpublished' : `${m.paramsBTotal}B total`}
                                {m.paramsBActive != null && ` / ${m.paramsBActive}B active`}
                              </span>
                              <span className="model-ctx">{(m.contextWindow / 1024).toFixed(0)}k ctx</span>
                              <span className="model-price">
                                {m.pricing.inputPerM === 0 && m.pricing.outputPerM === 0
                                  ? m.tier === 'local'
                                    ? 'local — free'
                                    : 'free tier'
                                  : `$${m.pricing.inputPerM}/$${m.pricing.outputPerM} per M`}
                              </span>
                            </span>
                            <span
                              className={`model-health model-health-${health[m.id]?.state ?? 'unknown'}`}
                              title={
                                health[m.id]?.detail ??
                                'Not checked yet — press "Re-check" to probe this provider.'
                              }
                            >
                              <span className="model-health-dot" aria-hidden="true" />
                              {checking && !health[m.id]
                                ? 'checking…'
                                : HEALTH_LABEL[health[m.id]?.state ?? 'unknown']}
                            </span>
                            {m.notes && <span className="model-note">{m.notes}</span>}
                          </label>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </>
          )}

          {tab === 'keys' && (
            <>
              <p className="settings-intro">
                Stored in Electron&apos;s per-user app-data directory, outside this repository — so keys never land in
                git. Only free-tier and pay-as-you-go providers are supported; no subscription APIs.
              </p>
              {(Object.keys(PROVIDER_CONFIG) as ProviderId[]).map((p) => {
                const cfg = PROVIDER_CONFIG[p];
                return (
                  <div key={p} className="settings-key-row">
                    <label htmlFor={`key-${p}`}>
                      <span className="settings-key-label">{cfg.label}</span>
                      <span className="settings-key-name">{cfg.keyName}</span>
                    </label>
                    <input
                      id={`key-${p}`}
                      type={cfg.optional ? 'text' : 'password'}
                      value={settings.envVars[cfg.keyName] ?? ''}
                      placeholder={cfg.defaultValue ?? (cfg.optional ? '' : 'paste your key')}
                      onChange={(e) => setEnv(cfg.keyName, e.target.value)}
                      spellCheck={false}
                    />
                    <span className="settings-key-help">{PROVIDER_HELP[p].url}</span>
                  </div>
                );
              })}

              <details className="settings-advanced">
                <summary>Other environment variables</summary>
                <p className="settings-muted">
                  Anything else the orchestrator should see — e.g. <code>GROQ_BASE_URL</code> to point at a proxy.
                </p>
                {Object.entries(settings.envVars)
                  .filter(([k]) => !Object.values(PROVIDER_CONFIG).some((c) => c.keyName === k))
                  .map(([k, v]) => (
                    <div key={k} className="settings-env-row">
                      <input
                        value={k}
                        onChange={(e) => {
                          const { [k]: old, ...rest } = settings.envVars;
                          update({ envVars: { ...rest, [e.target.value]: old } });
                        }}
                      />
                      <input value={v} onChange={(e) => setEnv(k, e.target.value)} />
                      <button
                        type="button"
                        onClick={() => {
                          const { [k]: _drop, ...rest } = settings.envVars;
                          update({ envVars: rest });
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                <button type="button" className="settings-add" onClick={() => setEnv('NEW_VAR', '')}>
                  + Add variable
                </button>
              </details>
            </>
          )}

        </div>

        <footer className="settings-footer">
          {saved && <span className="settings-saved">Saved</span>}
          <button type="button" className="settings-cancel" onClick={onClose}>
            Close
          </button>
          <button type="button" className="settings-save" onClick={save}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
