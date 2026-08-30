/**
 * Unit tests for the settings-screen model health probe
 * (electron/model-health.ts).
 *
 *   npm run build:electron && node tests/model-health.js
 *
 * `fetch` is stubbed, so this runs offline and deterministically: the point is
 * the mapping from what a provider says to what the pill claims, and that
 * mapping must not depend on anyone's network or quota on the day.
 *
 * Every one of the five user-visible states is pinned here, because each one
 * tells the user to do something different — "invalid key" means fix the key,
 * "unavailable" means the model is gone and the roster needs editing, and
 * "rate-limited" means wait. Collapsing any two of them into one pill would
 * send the user to the wrong fix.
 */
const assert = require('assert');
const path = require('path');

const { checkModelHealth } = require(path.join(__dirname, '..', 'electron-dist', 'model-health'));

const realFetch = global.fetch;

/** Route stubbed responses by URL substring. */
function stubFetch(routes) {
  global.fetch = async (url) => {
    for (const [needle, res] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        if (res.throws) throw new Error(res.throws);
        return {
          status: res.status,
          json: async () => res.body ?? {},
        };
      }
    }
    throw new Error(`unstubbed request: ${url}`);
  };
}

const MODELS = {
  groq: { id: 'groq:a', apiId: 'llama-3.1-8b-instant', provider: 'groq' },
  groqGone: { id: 'groq:gone', apiId: 'retired-model', provider: 'groq' },
  openrouter: { id: 'or:a', apiId: 'google/gemma-4-31b-it:free', provider: 'openrouter' },
  ollama: { id: 'oll:a', apiId: 'qwen2.5-coder:7b', provider: 'ollama' },
  ollamaGone: { id: 'oll:gone', apiId: 'granite4:7b-a1b-h', provider: 'ollama' },
  gemini: { id: 'gem:a', apiId: 'gemini/gemma-4-31b-it', provider: 'gemini' },
};

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    console.log('  ok  ', name);
    pass++;
  } catch (e) {
    console.log('  FAIL', name, '\n       ', e.message);
    fail++;
  }
};

async function main() {
  console.log('\n== model health: each provider answer maps to the right pill ==');

  await t('a listed model on a valid key is "working"', async () => {
    stubFetch({
      'api.groq.com': { status: 200, body: { data: [{ id: 'llama-3.1-8b-instant' }] } },
    });
    const h = await checkModelHealth({ models: [MODELS.groq], envVars: { GROQ_API_KEY: 'k' } });
    assert.strictEqual(h['groq:a'].state, 'working');
  });

  await t('a valid key that no longer lists the model is "unavailable", not "working"', async () => {
    stubFetch({
      'api.groq.com': { status: 200, body: { data: [{ id: 'llama-3.1-8b-instant' }] } },
    });
    const h = await checkModelHealth({ models: [MODELS.groqGone], envVars: { GROQ_API_KEY: 'k' } });
    assert.strictEqual(h['groq:gone'].state, 'unavailable');
    assert.ok(/retired-model/.test(h['groq:gone'].detail), h['groq:gone'].detail);
  });

  await t('HTTP 401 is "invalid-key"', async () => {
    stubFetch({ 'api.groq.com': { status: 401, body: { error: { message: 'Invalid API Key' } } } });
    const h = await checkModelHealth({ models: [MODELS.groq], envVars: { GROQ_API_KEY: 'bad' } });
    assert.strictEqual(h['groq:a'].state, 'invalid-key');
    assert.ok(/Invalid API Key/.test(h['groq:a'].detail), h['groq:a'].detail);
  });

  await t('HTTP 429 is "rate-limited", never "invalid-key"', async () => {
    stubFetch({ 'api.groq.com': { status: 429, body: {} } });
    const h = await checkModelHealth({ models: [MODELS.groq], envVars: { GROQ_API_KEY: 'k' } });
    assert.strictEqual(h['groq:a'].state, 'rate-limited');
  });

  await t('a network failure is "offline"', async () => {
    stubFetch({ 'api.groq.com': { throws: 'ENOTFOUND' } });
    const h = await checkModelHealth({ models: [MODELS.groq], envVars: { GROQ_API_KEY: 'k' } });
    assert.strictEqual(h['groq:a'].state, 'offline');
  });

  await t('a missing key is "offline" and says so, without a request', async () => {
    stubFetch({}); // any request would throw "unstubbed"
    const h = await checkModelHealth({ models: [MODELS.groq], envVars: {} });
    assert.strictEqual(h['groq:a'].state, 'offline');
    assert.ok(/GROQ_API_KEY/.test(h['groq:a'].detail), h['groq:a'].detail);
  });

  await t('OpenRouter validates the key separately from the public catalogue', async () => {
    // /models is public and answers 200 even for a bad key — if the probe only
    // read the catalogue it would wrongly report "working".
    stubFetch({
      '/key': { status: 401, body: {} },
      '/models': { status: 200, body: { data: [{ id: 'google/gemma-4-31b-it:free' }] } },
    });
    const h = await checkModelHealth({
      models: [MODELS.openrouter],
      envVars: { OPENROUTER_API_KEY: 'bad' },
    });
    assert.strictEqual(h['or:a'].state, 'invalid-key');
  });

  await t('Gemini reports a bad key as HTTP 400, and that still reads "invalid-key"', async () => {
    stubFetch({
      generativelanguage: { status: 400, body: { error: { message: 'API key not valid' } } },
    });
    const h = await checkModelHealth({ models: [MODELS.gemini], envVars: { GEMINI_API_KEY: 'bad' } });
    assert.strictEqual(h['gem:a'].state, 'invalid-key');
  });

  await t('the gemini/ namespace prefix is stripped before matching', async () => {
    stubFetch({
      generativelanguage: { status: 200, body: { models: [{ name: 'models/gemma-4-31b-it' }] } },
    });
    const h = await checkModelHealth({ models: [MODELS.gemini], envVars: { GEMINI_API_KEY: 'k' } });
    assert.strictEqual(h['gem:a'].state, 'working');
  });

  await t('a dead Ollama host is "offline" and names the fix', async () => {
    stubFetch({ '11434': { throws: 'ECONNREFUSED' } });
    const h = await checkModelHealth({ models: [MODELS.ollama], envVars: {} });
    assert.strictEqual(h['oll:a'].state, 'offline');
    assert.ok(/ollama serve/.test(h['oll:a'].detail), h['oll:a'].detail);
  });

  await t('an un-pulled Ollama model is "unavailable" and names the pull command', async () => {
    stubFetch({ '11434': { status: 200, body: { models: [{ name: 'qwen2.5-coder:7b' }] } } });
    const h = await checkModelHealth({ models: [MODELS.ollamaGone], envVars: {} });
    assert.strictEqual(h['oll:gone'].state, 'unavailable');
    assert.ok(/ollama pull granite4:7b-a1b-h/.test(h['oll:gone'].detail), h['oll:gone'].detail);
  });

  await t('one request per provider, not one per model', async () => {
    let calls = 0;
    global.fetch = async (url) => {
      calls++;
      if (String(url).includes('api.groq.com'))
        return { status: 200, json: async () => ({ data: [{ id: 'llama-3.1-8b-instant' }] }) };
      throw new Error('unexpected');
    };
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `groq:m${i}`,
      apiId: 'llama-3.1-8b-instant',
      provider: 'groq',
    }));
    await checkModelHealth({ models: many, envVars: { GROQ_API_KEY: 'k' } });
    assert.strictEqual(calls, 1, `8 models of one provider should cost 1 request, cost ${calls}`);
  });

  await t('one dead provider does not mark a healthy provider unhealthy', async () => {
    stubFetch({
      'api.groq.com': { status: 200, body: { data: [{ id: 'llama-3.1-8b-instant' }] } },
      '11434': { throws: 'ECONNREFUSED' },
    });
    const h = await checkModelHealth({
      models: [MODELS.groq, MODELS.ollama],
      envVars: { GROQ_API_KEY: 'k' },
    });
    assert.strictEqual(h['groq:a'].state, 'working');
    assert.strictEqual(h['oll:a'].state, 'offline');
  });

  global.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
