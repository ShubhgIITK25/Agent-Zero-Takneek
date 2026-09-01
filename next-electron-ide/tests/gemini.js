/**
 * Offline integration test for the Gemini generateContent adapter.
 *
 * This verifies the exact request shape used by the orchestrator without
 * requiring a real API key or spending quota.
 *
 *   npm run build:orchestrator && node tests/gemini.js
 */
const assert = require('assert');
const path = require('path');
const { callModel } = require(path.join(__dirname, '..', 'orchestrator-dist', 'providers'));

const model = {
  id: 'gemini:test',
  apiId: 'gemini/gemma-4-31b-it',
  label: 'Gemma test',
  provider: 'gemini',
  paramsBTotal: 31,
  contextWindow: 131072,
  pricing: { inputPerM: 0, outputPerM: 0 },
  tier: 'free',
  qualityIndex: 29.7,
  good_at: ['codegen'],
  speed: 'medium',
};

const realFetch = global.fetch;
let calls = 0;
global.fetch = async (url, init) => {
  calls++;
  assert.strictEqual(url, 'https://example.test/v1beta/models/gemma-4-31b-it:generateContent');
  assert.strictEqual(init.headers['x-goog-api-key'], 'secret');
  assert.ok(!String(url).includes('key='), 'API key must not be placed in the URL');
  const body = JSON.parse(init.body);
  assert.deepStrictEqual(body.contents, [{ role: 'user', parts: [{ text: 'Say hello.' }] }]);
  assert.strictEqual(body.generationConfig.temperature, 0.2);
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'Hello from Gemini.' }] } }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
    }),
    text: async () => '',
  };
};

callModel(
  model,
  [{ role: 'user', content: 'Say hello.' }],
  [],
  { GEMINI_API_KEY: 'secret', GEMINI_BASE_URL: 'https://example.test/v1beta' },
).then((result) => {
  assert.strictEqual(calls, 1);
  assert.strictEqual(result.text, 'Hello from Gemini.');
  assert.strictEqual(result.promptTokens, 3);
  assert.strictEqual(result.completionTokens, 4);
  console.log('Gemini adapter request/response test passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  global.fetch = realFetch;
});
