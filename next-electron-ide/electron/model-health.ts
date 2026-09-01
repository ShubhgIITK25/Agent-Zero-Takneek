/**
 * ============================================================================
 *  MODEL HEALTH - is this model actually callable right now?
 * ============================================================================
 * The settings screen can tell you a model is *eligible* (≤80B total params).
 * It could not, until now, tell you whether calling it would work. Those are
 * different questions, and the second one is the one that ruins a demo: a
 * mistyped key, a model the provider retired last week, or an Ollama server
 * nobody started all present identically - as a task that dies on its first
 * dispatch with a provider error buried in the event log.
 *
 * WHY THIS RUNS IN THE MAIN PROCESS.
 * Two reasons, either sufficient. The renderer is a browser context, so a
 * fetch to api.groq.com is blocked by CORS before it leaves. And the API keys
 * live here; probing from the renderer would mean a second place that handles
 * them.
 *
 * WHY ONE REQUEST PER PROVIDER, NOT ONE PER MODEL.
 * Every provider here exposes a catalogue endpoint that lists what it will
 * serve you, for the key you present. That single response answers all five
 * questions at once - is the network up, is the key valid, are we rate
 * limited, does this specific model id still exist - for every model of that
 * provider simultaneously. Probing 23 models individually would mean 23
 * requests, would burn free-tier quota just to render a settings screen, and
 * would be far more likely to trip the rate limit it is trying to report.
 *
 * WHY NOT A REAL COMPLETION CALL.
 * It would be the most faithful test - it is exactly what the orchestrator
 * does - but it costs money and tokens every time someone opens Settings, and
 * on a metered free tier that is a real budget line. A catalogue lookup is
 * free and distinguishes all five states. The one thing it cannot catch is a
 * model that lists but errors on inference; that surfaces as a normal
 * provider_failover intervention at run time, which is already handled.
 */

/**
 * Health of one model, from the user's point of view.
 *
 * Mirrored in src/lib/electron-api.ts - electron/tsconfig.json sets
 * `rootDir: "."`, so this directory cannot import from the renderer's tree or
 * from orchestrator/. Keep the two unions in step.
 */
export type ModelHealthState =
  | "working" // listed by the provider for this key - a call should succeed
  | "invalid-key" // provider answered, but rejected the credentials
  | "rate-limited" // provider answered 429; the key is fine, the quota is not
  | "unavailable" // provider is up and the key works, but it does not serve this id
  | "offline" // could not reach the provider at all, or no key is configured
  | "unknown"; // not checked yet

export type ModelHealth = {
  state: ModelHealthState;
  /** One line, shown on hover. Always says what was actually observed. */
  detail: string;
  checkedAt: number;
};

export type HealthCheckRequest = {
  models: { id: string; apiId: string; provider: string }[];
  envVars: Record<string, string>;
};

/** A provider either gave us its catalogue, or gave us a reason it did not. */
type ProviderProbe =
  | { ok: true; ids: Set<string>; detail: string }
  | { ok: false; state: Exclude<ModelHealthState, "working" | "unavailable">; detail: string };

const TIMEOUT_MS = 8000;

async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; networkError?: string }> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      // A non-JSON body is fine - the status code carries the verdict.
    }
    return { status: res.status, body };
  } catch (err) {
    return {
      status: 0,
      body: null,
      networkError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Turn an HTTP status into one of our states. Kept in one place so every
 * provider reports the same status the same way - a 429 from Groq and a 429
 * from Gemini must not render as two different things.
 */
function stateForStatus(
  status: number,
  networkError: string | undefined,
  label: string,
): Exclude<ModelHealthState, "working" | "unavailable"> | null {
  if (networkError) return "offline";
  if (status === 401 || status === 403) return "invalid-key";
  // Gemini reports a bad key as 400 INVALID_ARGUMENT rather than 401.
  if (status === 400) return "invalid-key";
  if (status === 429) return "rate-limited";
  if (status >= 500 || status === 0) return "offline";
  if (status >= 200 && status < 300) return null; // healthy
  return "offline";
}

async function probeGroq(env: Record<string, string>): Promise<ProviderProbe> {
  const key = env.GROQ_API_KEY;
  if (!key) return { ok: false, state: "offline", detail: "No GROQ_API_KEY set." };

  const base = env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
  const { status, body, networkError } = await getJson(`${base}/models`, {
    Authorization: `Bearer ${key}`,
  });

  const bad = stateForStatus(status, networkError, "Groq");
  if (bad)
    return {
      ok: false,
      state: bad,
      detail: networkError
        ? `Could not reach Groq: ${networkError}`
        : `Groq answered HTTP ${status}${body?.error?.message ? ` - ${body.error.message}` : ""}`,
    };

  const ids = new Set<string>((body?.data ?? []).map((m: any) => String(m.id)));
  return { ok: true, ids, detail: `Groq lists ${ids.size} model(s) for this key.` };
}

async function probeOpenRouter(env: Record<string, string>): Promise<ProviderProbe> {
  const key = env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, state: "offline", detail: "No OPENROUTER_API_KEY set." };

  const base = env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

  // OpenRouter's /models is public and answers 200 even for a bad key, so the
  // credential has to be checked against an authenticated endpoint. /key is
  // the cheapest one - it returns the key's own quota record.
  const auth = await getJson(`${base}/key`, { Authorization: `Bearer ${key}` });
  const bad = stateForStatus(auth.status, auth.networkError, "OpenRouter");
  if (bad)
    return {
      ok: false,
      state: bad,
      detail: auth.networkError
        ? `Could not reach OpenRouter: ${auth.networkError}`
        : `OpenRouter rejected the key with HTTP ${auth.status}.`,
    };

  const cat = await getJson(`${base}/models`);
  if (cat.networkError || !cat.body?.data)
    return {
      ok: false,
      state: "offline",
      detail: `Key is valid but the OpenRouter catalogue was unreadable${cat.networkError ? `: ${cat.networkError}` : "."}`,
    };

  const ids = new Set<string>((cat.body.data ?? []).map((m: any) => String(m.id)));
  return { ok: true, ids, detail: `Key valid; OpenRouter lists ${ids.size} model(s).` };
}

async function probeOllama(env: Record<string, string>): Promise<ProviderProbe> {
  const host = env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const { status, body, networkError } = await getJson(`${host}/api/tags`);

  if (networkError || status === 0)
    return {
      ok: false,
      state: "offline",
      // The overwhelmingly common cause, named directly rather than as a
      // generic connection error the user has to interpret.
      detail: `No Ollama server at ${host}. Start it with: ollama serve`,
    };
  const bad = stateForStatus(status, networkError, "Ollama");
  if (bad) return { ok: false, state: bad, detail: `Ollama answered HTTP ${status}.` };

  // Ollama reports pulled tags, e.g. "qwen2.5-coder:7b". An untagged pull is
  // stored as ":latest", so register both spellings.
  const ids = new Set<string>();
  for (const m of body?.models ?? []) {
    const name = String(m.name ?? m.model ?? "");
    if (!name) continue;
    ids.add(name);
    if (name.endsWith(":latest")) ids.add(name.slice(0, -":latest".length));
  }
  return { ok: true, ids, detail: `Ollama has ${ids.size} model(s) pulled.` };
}

async function probeGemini(env: Record<string, string>): Promise<ProviderProbe> {
  const key = env.GEMINI_API_KEY;
  if (!key) return { ok: false, state: "offline", detail: "No GEMINI_API_KEY set." };

  const base = env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
  const { status, body, networkError } = await getJson(
    `${base}/models`,
    { "x-goog-api-key": key },
  );

  const bad = stateForStatus(status, networkError, "Gemini");
  if (bad)
    return {
      ok: false,
      state: bad,
      detail: networkError
        ? `Could not reach the Gemini API: ${networkError}`
        : `Gemini answered HTTP ${status}${body?.error?.message ? ` - ${body.error.message}` : ""}`,
    };

  // Names come back as "models/gemma-4-31b-it"; the registry stores
  // "gemini/gemma-4-31b-it". Normalise both to the bare model name. A Gemini
  // catalogue also includes embedding/image-only models, so only advertise a
  // model as working when it supports the generateContent method we call.
  const ids = new Set<string>(
    (body?.models ?? [])
      .filter((m: any) =>
        !Array.isArray(m.supportedGenerationMethods) ||
        m.supportedGenerationMethods.includes("generateContent"),
      )
      .map((m: any) => String(m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean),
  );
  return { ok: true, ids, detail: `Gemini lists ${ids.size} model(s) for this key.` };
}

const PROBES: Record<string, (env: Record<string, string>) => Promise<ProviderProbe>> = {
  groq: probeGroq,
  openrouter: probeOpenRouter,
  ollama: probeOllama,
  gemini: probeGemini,
};

/** Strip the provider namespace the registry adds, to get the id the provider itself uses. */
function bareApiId(provider: string, apiId: string): string {
  if (provider === "gemini") {
    return apiId.replace(/^gemini\//, "").replace(/^models\//, "");
  }
  return apiId;
}

/**
 * Check every requested model, one catalogue request per DISTINCT provider.
 * Providers are probed concurrently - a dead Ollama host must not add its
 * timeout to the wait for a perfectly healthy Groq.
 */
export async function checkModelHealth(
  req: HealthCheckRequest,
): Promise<Record<string, ModelHealth>> {
  const providers = [...new Set(req.models.map((m) => m.provider))];
  const checkedAt = Date.now();

  const probes = new Map<string, ProviderProbe>();
  await Promise.all(
    providers.map(async (p) => {
      const probe = PROBES[p];
      probes.set(
        p,
        probe
          ? await probe(req.envVars)
          : { ok: false, state: "offline", detail: `No health probe for provider "${p}".` },
      );
    }),
  );

  const out: Record<string, ModelHealth> = {};
  for (const m of req.models) {
    const probe = probes.get(m.provider)!;
    if (!probe.ok) {
      out[m.id] = { state: probe.state, detail: probe.detail, checkedAt };
      continue;
    }
    const bare = bareApiId(m.provider, m.apiId);
    out[m.id] = probe.ids.has(bare)
      ? { state: "working", detail: `Listed by ${m.provider} as "${bare}".`, checkedAt }
      : {
          state: "unavailable",
          detail:
            m.provider === "ollama"
              ? `Not pulled locally. Run: ollama pull ${bare}`
              : `${m.provider} is reachable and the key works, but it does not serve "${bare}" any more.`,
          checkedAt,
        };
  }
  return out;
}
