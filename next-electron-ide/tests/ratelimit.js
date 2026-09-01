/**
 * Rate limits are information, not errors - and the wait must match the quota.
 *   npm run build:orchestrator && node tests/ratelimit.js
 *
 * Two things are pinned here.
 *
 * PARSING. Providers report a limit as nested JSON with their headers embedded
 * in it. Everything downstream - how long to wait, whether to give up on the
 * provider for the day, what sentence the user reads - is derived from that
 * blob, so a regex that silently stops matching would degrade the handling
 * without failing anything visibly.
 *
 * BACKOFF. Blind exponential backoff is wrong in both directions: far too short
 * against a per-day quota (every retry buys another 429), and often too long
 * when the provider has said exactly when it will accept traffic again.
 */
const assert = require('assert');
const path = require('path');
const D = path.join(__dirname, '..', 'orchestrator-dist');
const { describeProviderError, quotaScopeOf, retryAfterMsOf, classifyCooldownScope } = require(path.join(D, 'providers'));
const { RateLimitTracker, Router } = require(path.join(D, 'router'));

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log('  ok  ', name);
    pass++;
  } catch (e) {
    console.log('  FAIL', name, '\n       ', e.message);
    fail++;
  }
};

// The exact body OpenRouter returned in the reported failure.
const OPENROUTER_DAILY = JSON.stringify({
  error: {
    message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day',
    code: 429,
    metadata: { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1800' } },
  },
});

console.log('\n== rate limits: reading what the provider actually said ==');

t('the human sentence is extracted, not the JSON envelope', () => {
  const msg = describeProviderError(OPENROUTER_DAILY);
  assert.ok(msg.startsWith('Rate limit exceeded: free-models-per-day'), msg);
  assert.ok(!msg.includes('{'), `still contains JSON: ${msg}`);
  assert.ok(!msg.includes('metadata'), `still contains headers: ${msg}`);
});

t('a non-JSON body degrades to readable text', () => {
  const msg = describeProviderError('  Too   Many\n Requests ');
  assert.strictEqual(msg, 'Too Many Requests');
});

t('an empty body still produces something sayable', () => {
  assert.ok(describeProviderError('').length > 0);
});

t('a per-day quota is recognised', () => {
  assert.strictEqual(quotaScopeOf(OPENROUTER_DAILY), 'day');
  assert.strictEqual(quotaScopeOf('requests per day exceeded'), 'day');
  assert.strictEqual(quotaScopeOf('RPD limit reached'), 'day');
});

t('a per-minute quota is recognised', () => {
  assert.strictEqual(quotaScopeOf('Rate limit reached: 30 requests per minute'), 'minute');
  assert.strictEqual(quotaScopeOf('TPM limit exceeded'), 'minute');
});

t('an unstated quota is not guessed at', () => {
  assert.strictEqual(quotaScopeOf('Too Many Requests'), 'unknown');
});

console.log('\n== rate limits: the three encodings of "when to come back" ==');

t('Retry-After in seconds', () => {
  assert.strictEqual(retryAfterMsOf('{"retry-after": 42}'), 42_000);
});

t('X-RateLimit-Reset as a plain duration in seconds', () => {
  assert.strictEqual(retryAfterMsOf(OPENROUTER_DAILY), 1800 * 1000);
});

t('X-RateLimit-Reset as absolute epoch seconds', () => {
  const inTwoMin = Math.floor((Date.now() + 120_000) / 1000);
  const got = retryAfterMsOf(`{"X-RateLimit-Reset":"${inTwoMin}"}`);
  assert.ok(Math.abs(got - 120_000) < 3_000, `expected ~120s, got ${got}ms`);
});

t('X-RateLimit-Reset as absolute epoch milliseconds', () => {
  const got = retryAfterMsOf(`{"X-RateLimit-Reset":"${Date.now() + 90_000}"}`);
  assert.ok(Math.abs(got - 90_000) < 3_000, `expected ~90s, got ${got}ms`);
});

t('a reset already in the past waits zero rather than going negative', () => {
  assert.strictEqual(retryAfterMsOf(`{"X-RateLimit-Reset":"${Date.now() - 60_000}"}`), 0);
});

t('an absurd reset is clamped rather than parking a provider for a week', () => {
  const got = retryAfterMsOf('{"retry-after": 999999999}');
  assert.ok(got <= 6 * 60 * 60_000, `not clamped: ${got}ms`);
});

t('no hint at all returns undefined, so the caller falls back', () => {
  assert.strictEqual(retryAfterMsOf('Too Many Requests'), undefined);
});

console.log('\n== rate limits: the cooldown matches the quota that was hit ==');

t('a daily quota parks the provider for hours, not seconds', () => {
  const rl = new RateLimitTracker();
  rl.penalise('openrouter', true, { quotaScope: 'day', note: 'daily quota spent' });
  const secs = rl.cooldownRemainingSeconds('openrouter');
  assert.ok(secs > 3600, `only ${secs}s - a 20s backoff against a daily quota just buys another 429`);
});

t("a provider's own retry hint is respected", () => {
  const rl = new RateLimitTracker();
  rl.penalise('groq', true, { quotaScope: 'minute', retryAfterMs: 30_000 });
  const secs = rl.cooldownRemainingSeconds('groq');
  assert.ok(secs >= 29 && secs <= 33, `expected ~31s, got ${secs}s`);
});

t('with no hint it still falls back to exponential backoff', () => {
  const rl = new RateLimitTracker();
  rl.penalise('groq', true);
  assert.ok(rl.inCooldown('groq'));
  assert.ok(rl.cooldownRemainingSeconds('groq') > 0);
});

t('the reason is human-readable, for the routing trace', () => {
  const rl = new RateLimitTracker();
  rl.penalise('openrouter', true, { quotaScope: 'day', note: 'daily quota spent' });
  assert.strictEqual(rl.cooldownReason('openrouter'), 'daily quota spent');
});

t('a provider not in cooldown reports no reason', () => {
  const rl = new RateLimitTracker();
  assert.strictEqual(rl.cooldownReason('groq'), null);
  assert.strictEqual(rl.cooldownRemainingSeconds('groq'), 0);
});

t('clearing a provider forgets the wait and the reason', () => {
  const rl = new RateLimitTracker();
  rl.penalise('openrouter', true, { quotaScope: 'day' });
  rl.clear('openrouter');
  assert.strictEqual(rl.inCooldown('openrouter'), false);
  assert.strictEqual(rl.cooldownReason('openrouter'), null);
});

t('a daily park does not leak onto a different provider', () => {
  const rl = new RateLimitTracker();
  rl.penalise('openrouter', true, { quotaScope: 'day' });
  assert.strictEqual(rl.inCooldown('groq'), false);
});

console.log('\n== rate limits: park the route, not the whole provider ==');

t('a model-level 429 does not park sibling models on the same provider', () => {
  const rl = new RateLimitTracker();
  rl.penalise('openrouter', true, { scope: 'model', modelId: 'openrouter:laguna-xs-2.1' });
  assert.ok(rl.inCooldown('openrouter', 'openrouter:laguna-xs-2.1', 'free'));
  assert.strictEqual(rl.inCooldown('openrouter', 'openrouter:qwen3-next-80b-thinking', 'payg'), false);
  assert.strictEqual(rl.inCooldown('openrouter'), false);
});

t('a free-tier daily quota parks free models only', () => {
  const rl = new RateLimitTracker();
  rl.penalise('openrouter', true, { scope: 'free-tier', quotaScope: 'day' });
  assert.ok(rl.inCooldown('openrouter', 'openrouter:laguna-xs-2.1', 'free'));
  assert.strictEqual(rl.inCooldown('openrouter', 'openrouter:qwen3-next-80b-thinking', 'payg'), false);
});

t('after a model-level park the router still picks another model on that provider', () => {
  const rl = new RateLimitTracker();
  rl.penalise('openrouter', true, { scope: 'model', modelId: 'openrouter:laguna-xs-2.1' });
  const r = new Router(
    ['openrouter:laguna-xs-2.1', 'openrouter:qwen3-coder-30b', 'groq:qwen3.8-27b'],
    rl
  );
  const route = r.route({
    category: 'simple_edit',
    estimatedContextTokens: 1000,
    budgetRemaining: 0.4,
    timeRemaining: 2000,
    attemptNumber: 1,
    cooldownProviders: [],
  });
  assert.ok(route, 'should still have a route');
  assert.notStrictEqual(route.model.id, 'openrouter:laguna-xs-2.1');
});

t('soonestReadyMs is zero when nothing is cooling', () => {
  assert.strictEqual(new RateLimitTracker().soonestReadyMs(), 0);
});

t('soonestReadyMs reports a model-level wait', () => {
  const rl = new RateLimitTracker();
  rl.penalise('openrouter', true, { scope: 'model', modelId: 'openrouter:laguna-xs-2.1', retryAfterMs: 15_000 });
  const ms = rl.soonestReadyMs();
  assert.ok(ms > 10_000 && ms <= 16_000, `got ${ms}ms`);
});

t('"Provider returned error" parks the model, not the provider', () => {
  assert.strictEqual(classifyCooldownScope('Provider returned error'), 'model');
});

t('a free-models-per-day 429 parks the free tier', () => {
  assert.strictEqual(
    classifyCooldownScope('Rate limit exceeded: free-models-per-day. Add 10 credits'),
    'free-tier'
  );
});

t('a free-tier model 429 is classified as free-tier even without that phrase', () => {
  assert.strictEqual(
    classifyCooldownScope('Rate limit exceeded (429)', { tier: 'free' }),
    'free-tier'
  );
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
