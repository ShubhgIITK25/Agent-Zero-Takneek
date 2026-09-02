'use client';

/**
 * SETTINGS - API keys (mandatory per the PS) and the model roster.
 *
 * The roster half is not decoration: the router can only ever pick from what
 * is enabled here, and `checkEligibility` (orchestrator/models.ts) is the same
 * function the router calls, so an ineligible model cannot be enabled from
 * this screen even by accident.
 *
 * The list is FILTERED to eligible models, so every row here is selectable and
 * none carries an "eligible" badge - a badge that reads the same on every row
 * is noise, not information. The 80B rule and the models it blocks are
 * documented in the README and enforced in models.ts; this screen is for
 * choosing among the models you can actually use.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Key, Cpu, ExternalLink, Eye, EyeOff, ChevronDown, ChevronRight, Monitor, Zap, X } from 'lucide-react';
import type { AgentSettings, CustomModel, ModelHealth, ModelHealthState } from '../lib/electron-api';
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
  ollama: { url: 'ollama.com', hint: 'Runs locally - no key, no cost. Set the host if it is not the default.' },
  gemini: { url: 'aistudio.google.com/apikey', hint: 'Google Gemini - get a free key from AI Studio.' },
};

type CustomCapability = CustomModel['good_at'][number];

const CUSTOM_CAPABILITY_OPTIONS: { id: CustomCapability; label: string }[] = [
  { id: 'simple', label: 'Simple edits' },
  { id: 'codegen', label: 'Code generation' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'planning', label: 'Planning' },
  { id: 'verification', label: 'Verification' },
];

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<'models' | 'keys'>('models');
  const [health, setHealth] = useState<Record<string, ModelHealth>>({});
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const [customDraft, setCustomDraft] = useState({
    provider: 'groq' as ProviderId,
    apiId: '',
    label: '',
    paramsBTotal: '30',
    contextWindow: '131072',
    qualityIndex: '20',
    inputPerM: '0',
    outputPerM: '0',
    good_at: ['codegen'] as CustomCapability[],
  });
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** Inference-time evidence is more current than the last catalogue probe. */
  const runtimeHealth = useRef<Record<string, ModelHealth>>({});

  useEffect(() => {
    (async () => {
      const s = await window.electronAPI?.settingsGet();
      setSettings(
        s ?? { envVars: {}, enabledModelIds: ['ollama:llama3.1-8b'], customModels: [], maxCostUsd: 0.5, maxSeconds: 2700, maxParallelSubtasks: 3, minVerifierQuality: 20 }
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
      const models = [...MODEL_REGISTRY.filter((m) => checkEligibility(m).eligible), ...(settings?.customModels ?? [])].map((m) => ({
        id: m.id,
        apiId: m.apiId,
        provider: m.provider,
      }));
      const result = await window.electronAPI.modelsCheckHealth({ models, envVars });
      // A provider catalogue can still list a model after its inference quota
      // has been exhausted. Keep a fresh runtime 429 visible until a live
      // inference succeeds or the status is explicitly refreshed later.
      setHealth((current) => {
        const merged = { ...current, ...result };
        for (const [id, runtime] of Object.entries(runtimeHealth.current)) {
          if (runtime.state === 'rate-limited') merged[id] = runtime;
        }
        return merged;
      });
      setLastChecked(Date.now());
    } finally {
      setChecking(false);
    }
  }, [settings?.customModels]);

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

  // Health probes use catalogue endpoints and cannot see inference-only quota
  // failures. The orchestrator already emits the exact model and error for
  // every call, so listen to that same stream and update the pill immediately.
  useEffect(() => {
    const calls = new Map<string, { modelId: string; provider: string }>();
    const isRateLimitError = (value: unknown) => /\b429\b|rate[ -]?limit|quota/i.test(String(value ?? ''));
    const off = window.electronAPI?.onOrchestratorEvent((event: any) => {
      if (event?.type === 'agent_call_start' && typeof event.nodeId === 'string') {
        calls.set(event.nodeId, { modelId: event.modelId, provider: event.provider });
        return;
      }
      if (event?.type !== 'agent_call_end' || typeof event.nodeId !== 'string') return;
      const call = calls.get(event.nodeId);
      calls.delete(event.nodeId);
      const modelId = typeof event.modelId === 'string' ? event.modelId : call?.modelId;
      const provider = typeof event.provider === 'string' ? event.provider : call?.provider;
      if (!modelId || !provider) return;

      const checkedAt = typeof event.ts === 'number' ? event.ts : Date.now();
      if (event.error && isRateLimitError(event.error)) {
        const status: ModelHealth = {
          state: 'rate-limited',
          detail: `A live ${provider} inference request was rate-limited: ${event.error}`,
          checkedAt,
        };
        runtimeHealth.current[modelId] = status;
        setHealth((current) => ({ ...current, [modelId]: status }));
        setLastChecked(checkedAt);
      } else if (!event.error) {
        delete runtimeHealth.current[modelId];
        const status: ModelHealth = {
          state: 'working',
          detail: `A live ${provider} inference request succeeded.`,
          checkedAt,
        };
        setHealth((current) => ({ ...current, [modelId]: status }));
        setLastChecked(checkedAt);
      }
    });
    return () => off?.();
  }, []);

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

  const addCustomModel = () => {
    const apiId = customDraft.apiId.trim();
    const paramsBTotal = Number(customDraft.paramsBTotal);
    const contextWindow = Number(customDraft.contextWindow);
    const qualityIndex = Number(customDraft.qualityIndex);
    const inputPerM = Number(customDraft.inputPerM);
    const outputPerM = Number(customDraft.outputPerM);
    if (
      !apiId ||
      !Number.isFinite(paramsBTotal) || paramsBTotal <= 0 || paramsBTotal > 80 ||
      !Number.isFinite(contextWindow) || contextWindow < 1024 ||
      !Number.isFinite(qualityIndex) || qualityIndex < 0 || qualityIndex > 100 ||
      !Number.isFinite(inputPerM) || inputPerM < 0 ||
      !Number.isFinite(outputPerM) || outputPerM < 0 ||
      customDraft.good_at.length === 0
    ) return;
    const id = `custom:${customDraft.provider}:${apiId}`;
    const model: CustomModel = {
      id, apiId, label: customDraft.label.trim() || apiId, provider: customDraft.provider,
      paramsBTotal, contextWindow, qualityIndex,
      pricing: { inputPerM, outputPerM },
      tier: customDraft.provider === 'ollama' ? 'local' : inputPerM === 0 && outputPerM === 0 ? 'free' : 'payg',
      good_at: [...customDraft.good_at], speed: 'medium',
    };
    update({ customModels: [...settings.customModels.filter((m) => m.id !== id), model], enabledModelIds: [...new Set([...settings.enabledModelIds, id])] });
    setCustomDraft((d) => ({ ...d, apiId: '', label: '' }));
  };

  const toggleCustomCapability = (capability: CustomCapability) => {
    setCustomDraft((draft) => ({
      ...draft,
      good_at: draft.good_at.includes(capability)
        ? draft.good_at.filter((value) => value !== capability)
        : [...draft.good_at, capability],
    }));
  };

  const testCustomDraft = async () => {
    const apiId = customDraft.apiId.trim();
    if (!apiId || !window.electronAPI?.modelsCheckHealth) return;
    setChecking(true);
    try {
      const id = `custom:${customDraft.provider}:${apiId}`;
      const result = await window.electronAPI.modelsCheckHealth({
        envVars: settings.envVars,
        models: [{ id, apiId, provider: customDraft.provider }],
      });
      setHealth((current) => {
        const merged = { ...current, ...result };
        for (const [id, runtime] of Object.entries(runtimeHealth.current)) {
          if (runtime.state === 'rate-limited') merged[id] = runtime;
        }
        return merged;
      });
      setLastChecked(Date.now());
    } finally {
      setChecking(false);
    }
  };

  const removeCustomModel = (id: string) => update({
    customModels: settings.customModels.filter((m) => m.id !== id),
    enabledModelIds: settings.enabledModelIds.filter((modelId) => modelId !== id),
  });

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
      (id) => (settings.customModels.find((m) => m.id === id) ?? MODEL_REGISTRY.find((m) => m.id === id))?.provider === p
    );
    const cfg = PROVIDER_CONFIG[p];
    return usesProvider && !cfg.optional && !settings.envVars[cfg.keyName];
  });

  return (
    <div className="settings-overlay" role="dialog" aria-label="Agent settings" onClick={onClose}>
      <div className="settings-panel settings-panel-wide" onClick={(e) => e.stopPropagation()}>
        <header className="settings-header">
          <h2>Agent Settings</h2>
          <button type="button" className="settings-close-btn" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </header>

        <div className="settings-tabs">
          <button type="button" className={`settings-tab${tab === 'models' ? ' active' : ''}`} onClick={() => setTab('models')}>
            <Cpu size={16} style={{ marginRight: 6 }} /> Models
          </button>
          <button type="button" className={`settings-tab${tab === 'keys' ? ' active' : ''}`} onClick={() => setTab('keys')}>
            <Key size={16} style={{ marginRight: 6 }} /> API Keys
          </button>
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
              <div className="health-bar" style={{ marginBottom: 20 }}>
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
                    <h4>
                      {PROVIDER_CONFIG[provider].label}
                      <span className="settings-provider-hint">{PROVIDER_HELP[provider].hint}</span>
                    </h4>
                    <div className="model-grid">
                      {visibleModels.map((m) => {
                        return (
                          <div key={m.id} className="model-card">
                            <div className="model-card-top">
                              <div className="model-card-title">
                                <span className="model-name">{m.label}</span>
                                <code className="model-api-id">{m.apiId}</code>
                              </div>
                              <span
                                className={`model-health model-health-${health[m.id]?.state ?? 'unknown'}`}
                                title={
                                  health[m.id]?.detail ??
                                  'Not checked yet - press "Re-check" to probe this provider.'
                                }
                              >
                                <span className="model-health-dot" aria-hidden="true" />
                                {checking && !health[m.id]
                                  ? 'checking…'
                                  : HEALTH_LABEL[health[m.id]?.state ?? 'unknown']}
                              </span>
                            </div>

                            {m.notes && <p className="model-card-note">{m.notes}</p>}

                            <div className="model-card-badges">
                              <span className="model-badge">
                                {m.paramsBTotal == null ? 'unpublished' : `${m.paramsBTotal}B total`}
                                {m.paramsBActive != null && ` / ${m.paramsBActive}B active`}
                              </span>
                              <span className="model-badge">{(m.contextWindow / 1024).toFixed(0)}k ctx</span>
                              <span className="model-badge">
                                {m.qualityIndex != null ? `quality ${m.qualityIndex}/100` : 'quality unrated'}
                              </span>
                              <span className="model-badge model-badge-price">
                                {m.pricing.inputPerM === 0 && m.pricing.outputPerM === 0
                                  ? m.tier === 'local'
                                    ? 'local - free'
                                    : 'free tier'
                                  : `$${m.pricing.inputPerM}/$${m.pricing.outputPerM} per M`}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}

              <section className="settings-provider custom-models-section" style={{ marginTop: 24 }}>
                <h4>
                  Add Custom Model
                  <span className="settings-provider-hint">Add any model your configured provider serves; press Save to make it routable.</span>
                </h4>
                <div className="custom-model-card">
                  <div className="custom-model-grid">
                    <div className="custom-field">
                      <label>Provider</label>
                      <select value={customDraft.provider} onChange={(e) => setCustomDraft({ ...customDraft, provider: e.target.value as ProviderId })}>
                        {(Object.keys(PROVIDER_CONFIG) as ProviderId[]).map((p) => <option key={p} value={p}>{PROVIDER_CONFIG[p].label}</option>)}
                      </select>
                    </div>
                    <div className="custom-field custom-field-wide">
                      <label>Model ID</label>
                      <input value={customDraft.apiId} onChange={(e) => setCustomDraft({ ...customDraft, apiId: e.target.value })} placeholder={customDraft.provider === 'gemini' ? 'e.g. gemini-2.5-flash' : 'e.g. qwen/qwen3-coder'} spellCheck={false} />
                    </div>
                    <div className="custom-field custom-field-wide">
                      <label>Display Name (optional)</label>
                      <input value={customDraft.label} onChange={(e) => setCustomDraft({ ...customDraft, label: e.target.value })} placeholder="e.g. Qwen3 Coder" />
                    </div>
                    <div className="custom-field">
                      <label>Params (B)</label>
                      <input type="number" min="1" max="80" value={customDraft.paramsBTotal} onChange={(e) => setCustomDraft({ ...customDraft, paramsBTotal: e.target.value })} title="Total parameters in billions (max 80)" />
                    </div>
                    <div className="custom-field">
                      <label>Context (tokens)</label>
                      <input type="number" min="1024" value={customDraft.contextWindow} onChange={(e) => setCustomDraft({ ...customDraft, contextWindow: e.target.value })} title="Context window in tokens" />
                    </div>
                    <div className="custom-field">
                      <label>Quality (0-100)</label>
                      <input type="number" min="0" max="100" value={customDraft.qualityIndex} onChange={(e) => setCustomDraft({ ...customDraft, qualityIndex: e.target.value })} title="Your quality estimate. Use benchmark evidence where available." />
                    </div>
                    <div className="custom-field">
                      <label>Input $ / 1M</label>
                      <input type="number" min="0" step="any" value={customDraft.inputPerM} onChange={(e) => setCustomDraft({ ...customDraft, inputPerM: e.target.value })} title="Actual input price in USD per million tokens; use 0 for free/local." />
                    </div>
                    <div className="custom-field">
                      <label>Output $ / 1M</label>
                      <input type="number" min="0" step="any" value={customDraft.outputPerM} onChange={(e) => setCustomDraft({ ...customDraft, outputPerM: e.target.value })} title="Actual output price in USD per million tokens; use 0 for free/local." />
                    </div>
                    <div className="custom-field custom-field-wide">
                      <label>Capabilities</label>
                      <div className="custom-capability-list">
                        {CUSTOM_CAPABILITY_OPTIONS.map((option) => (
                          <label key={option.id} className="custom-capability-option">
                            <input
                              type="checkbox"
                              checked={customDraft.good_at.includes(option.id)}
                              onChange={() => toggleCustomCapability(option.id)}
                            />
                            {option.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                  <p className="settings-hint custom-quality-hint">
                    <strong>Determining quality:</strong> The quality can be estimated from benchmarks (officially from Artifical Analysis intelligence benchmarks), or if none are available, from the model's size and context window. A rough rule of thumb is that a model with 30B parameters and a 128k context window is about quality 20/100.
                  </p>

                  <div className="custom-model-actions">
                    <button type="button" className="settings-add-btn" onClick={addCustomModel} disabled={!customDraft.apiId.trim()}>
                      + Add Model
                    </button>
                    <button type="button" className="health-recheck" onClick={() => void testCustomDraft()} disabled={checking || !customDraft.apiId.trim()} title="Tests the key and model ID before saving">
                      Test Model
                    </button>
                  </div>
                </div>

                {settings.customModels.length > 0 && (
                  <div className="custom-model-list" style={{ marginTop: 12 }}>
                    {settings.customModels.map((m) => (
                      <div className="custom-model-row" key={m.id}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          {m.label} <code>{m.apiId}</code>
                          <span className="model-badge">quality {m.qualityIndex ?? Math.min(30, m.paramsBTotal * 0.4).toFixed(1)}/100</span>
                          <span className="model-badge">{m.good_at.join(', ')}</span>
                        </span>
                        <span className={`model-health model-health-${health[m.id]?.state ?? 'unknown'}`}>{HEALTH_LABEL[health[m.id]?.state ?? 'unknown']}</span>
                        <button type="button" onClick={() => removeCustomModel(m.id)}>Remove</button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <details className="settings-advanced" open={advancedOpen} onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
                <summary><Monitor size={14} style={{ marginRight: 6 }} /> Advanced Settings</summary>
                <div className="parallel-setting" style={{ marginTop: 12 }}>
                  <label htmlFor="max-parallel">Run independent subtasks in parallel</label>
                  <select
                    id="max-parallel"
                    value={settings.maxParallelSubtasks ?? 3}
                    onChange={(e) =>
                      setSettings({ ...settings, maxParallelSubtasks: Number(e.target.value) })
                    }
                  >
                    <option value={1}>1 - one at a time (sequential)</option>
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
                <div className="parallel-setting" style={{ marginTop: 12 }}>
                  <label htmlFor="min-verifier-quality">Minimum quality for custom verifiers</label>
                  <input
                    id="min-verifier-quality"
                    type="number"
                    min="0"
                    max="100"
                    value={settings.minVerifierQuality ?? 20}
                    onChange={(e) =>
                      setSettings({ ...settings, minVerifierQuality: Number(e.target.value) })
                    }
                  />
                  <p className="settings-hint">
                    A custom model below this score is never selected for verification, even if you assign it the
                    verification capability. Set 0 to allow every custom verifier.
                  </p>
                </div>
              </details>
            </>
          )}

          {tab === 'keys' && (
            <>
              <p className="settings-intro">
                Stored in Electron&apos;s per-user app-data directory, outside this repository - so keys never land in
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
                    <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
                      <input
                        id={`key-${p}`}
                        type={cfg.optional || showKeys[p] ? 'text' : 'password'}
                        value={settings.envVars[cfg.keyName] ?? ''}
                        placeholder={cfg.defaultValue ?? (cfg.optional ? '' : 'paste your key')}
                        onChange={(e) => setEnv(cfg.keyName, e.target.value)}
                        spellCheck={false}
                        style={{ flex: 1, paddingRight: cfg.optional ? 8 : 36 }}
                      />
                      {!cfg.optional && (
                        <button
                          type="button"
                          onClick={() => setShowKeys({ ...showKeys, [p]: !showKeys[p] })}
                          style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#888', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0 }}
                          title={showKeys[p] ? "Hide key" : "Show key"}
                        >
                          {showKeys[p] ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      )}
                    </div>
                    <span className="settings-key-help">
                      <a href={`https://${PROVIDER_HELP[p].url}`} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'inherit', textDecoration: 'none' }}>
                        {PROVIDER_HELP[p].url} <ExternalLink size={12} />
                      </a>
                    </span>
                  </div>
                );
              })}

              <details className="settings-advanced">
                <summary>Other environment variables</summary>
                <p className="settings-muted">
                  Anything else the orchestrator should see - e.g. <code>GROQ_BASE_URL</code> to point at a proxy.
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
