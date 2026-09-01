/**
 * An unhealthy model must never be selected.
 *   npm run build:orchestrator && node tests/health.js
 *
 * The Settings screen has always been able to tell you a model is unavailable.
 * The router could not see that verdict, so it stayed a routing candidate and
 * every subtask rediscovered the same 404 at full price. These tests pin the
 * two halves of the fix:
 *
 *   1. the health snapshot is a HARD filter, applied before any call is made;
 *   2. runtime evidence outranks the snapshot in BOTH directions - a 404 takes
 *      a model out even if the probe liked it, and a success puts one back even
 *      if the probe did not.
 *
 * The negative cases matter as much: "never probed" and "rate-limited" must NOT
 * block, or a user who has not opened Settings can route nowhere at all.
 */
const assert = require('assert');
const path = require('path');
const D = path.join(__dirname, '..', 'orchestrator-dist');
const { Router, RateLimitTracker, HealthRegistry } = require(path.join(D, 'router'));
const { MODEL_REGISTRY, checkEligibility } = require(path.join(D, 'models'));

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

// Two eligible models on DIFFERENT providers, so a provider-wide block still
// leaves somewhere to route - otherwise these tests would pass for the wrong
// reason (nothing left, rather than the right thing excluded).
const eligible = MODEL_REGISTRY.filter((m) => checkEligibility(m).eligible);
const A = eligible.find((m) => m.provider === 'groq');
const B = eligible.find((m) => m.provider === 'openrouter');
assert.ok(A && B, 'fixture needs one eligible groq and one eligible openrouter model');

const signals = () => ({
  category: 'codegen',
  estimatedContextTokens: 2000,
  budgetRemaining: 1,
  timeRemaining: 600,
  attemptNumber: 1,
  cooldownProviders: [],
});

const routerWith = (health) => new Router([A.id, B.id], new RateLimitTracker(), health);
const snap = (state) => ({ state, detail: 'fixture', checkedAt: Date.now() });

console.log('\n== health: the snapshot is a hard filter, not a hint ==');

t('an "unavailable" model is never selected', () => {
  const r = routerWith(new HealthRegistry({ [A.id]: snap('unavailable') }));
  const route = r.route(signals());
  assert.ok(route, 'should still route to the healthy model');
  assert.notStrictEqual(route.model.id, A.id);
});

t('the rejection says WHY, so the dashboard can show it', () => {
  const r = routerWith(new HealthRegistry({ [A.id]: snap('unavailable') }));
  const route = r.route(signals());
  const why = route.rejected.find((x) => x.modelId === A.id)?.why ?? '';
  assert.match(why, /health check/i, `unhelpful reason: "${why}"`);
  assert.match(why, /does not serve/i, `unhelpful reason: "${why}"`);
});

t('an "invalid-key" model is never selected', () => {
  const r = routerWith(new HealthRegistry({ [A.id]: snap('invalid-key') }));
  assert.notStrictEqual(r.route(signals()).model.id, A.id);
});

t('an "offline" model is never selected', () => {
  const r = routerWith(new HealthRegistry({ [A.id]: snap('offline') }));
  assert.notStrictEqual(r.route(signals()).model.id, A.id);
});

t('routing returns null when every model is unhealthy, rather than picking one', () => {
  const r = routerWith(
    new HealthRegistry({ [A.id]: snap('offline'), [B.id]: snap('invalid-key') })
  );
  assert.strictEqual(r.route(signals()), null);
});

console.log('\n== health: what must NOT be blocked ==');

t('an unprobed model still routes - "not checked" is not "broken"', () => {
  const r = routerWith(new HealthRegistry({}));
  assert.ok(r.route(signals()), 'an empty health map must not disable routing');
});

t('a "working" model routes normally', () => {
  const r = routerWith(new HealthRegistry({ [A.id]: snap('working'), [B.id]: snap('working') }));
  assert.ok(r.route(signals()));
});

t('"unknown" does not block', () => {
  const r = routerWith(new HealthRegistry({ [A.id]: snap('unknown'), [B.id]: snap('unknown') }));
  assert.ok(r.route(signals()));
});

t('"rate-limited" does not block - a quota resets, a health block would not', () => {
  const health = new HealthRegistry({ [A.id]: snap('rate-limited'), [B.id]: snap('rate-limited') });
  assert.ok(routerWith(health).route(signals()), 'rate-limited belongs to the cooldown, not the health gate');
  assert.strictEqual(health.blockReason(A.id, A.provider), null);
});

console.log('\n== health: runtime evidence outranks the snapshot ==');

t('a 404 at run time takes that model out for the rest of the task', () => {
  const health = new HealthRegistry({});
  const scope = health.recordFailure(A.id, A.provider, {
    status: 404,
    retryable: false,
    message: 'model not found',
  });
  assert.strictEqual(scope, 'model');
  assert.notStrictEqual(routerWith(health).route(signals()).model.id, A.id);
});

t('a 404 blocks only that model, not its whole provider', () => {
  const health = new HealthRegistry({});
  health.recordFailure(A.id, A.provider, { status: 404, retryable: false, message: 'no such model' });
  const sibling = eligible.find((m) => m.provider === A.provider && m.id !== A.id);
  if (!sibling) return; // roster has only one model on this provider
  assert.strictEqual(health.blockReason(sibling.id, sibling.provider), null);
});

t('a 401 blocks the whole provider - the key is bad for all of its models', () => {
  const health = new HealthRegistry({});
  const scope = health.recordFailure(A.id, A.provider, {
    status: 401,
    retryable: false,
    message: 'auth failed',
  });
  assert.strictEqual(scope, 'provider');
  const sibling = eligible.find((m) => m.provider === A.provider && m.id !== A.id);
  if (sibling) assert.ok(health.blockReason(sibling.id, sibling.provider));
  assert.strictEqual(routerWith(health).route(signals()).model.provider, B.provider);
});

t('a "decommissioned model" message blocks even without a 404 status', () => {
  const health = new HealthRegistry({});
  const scope = health.recordFailure(A.id, A.provider, {
    status: 400,
    retryable: false,
    message: 'The model `foo` has been decommissioned.',
  });
  assert.strictEqual(scope, 'model');
});

t('a transient failure (500, timeout) is NOT recorded as a health block', () => {
  const health = new HealthRegistry({});
  assert.strictEqual(
    health.recordFailure(A.id, A.provider, { status: 500, retryable: true, message: 'server error' }),
    null
  );
  assert.strictEqual(health.blockReason(A.id, A.provider), null);
});

t('an ambiguous 400 is not attributed - it is as likely to be our own payload', () => {
  const health = new HealthRegistry({});
  assert.strictEqual(
    health.recordFailure(A.id, A.provider, {
      status: 400,
      retryable: false,
      message: 'invalid tools schema at index 2',
    }),
    null
  );
  assert.strictEqual(health.blockReason(A.id, A.provider), null);
});

t('a success overrides a stale snapshot that called the model unavailable', () => {
  const health = new HealthRegistry({ [A.id]: snap('unavailable') });
  assert.ok(health.blockReason(A.id, A.provider), 'blocked before any call');
  health.recordSuccess(A.id, A.provider);
  assert.strictEqual(health.blockReason(A.id, A.provider), null, 'a model that answered us is working');
});

t('a success on one model clears a provider block for its siblings', () => {
  const health = new HealthRegistry({});
  health.recordFailure(A.id, A.provider, { status: 401, retryable: false, message: 'auth failed' });
  health.recordSuccess(A.id, A.provider);
  assert.strictEqual(health.blockReason(A.id, A.provider), null);
});

t('blocks() reports what was excluded and why', () => {
  const health = new HealthRegistry({});
  health.recordFailure(A.id, A.provider, { status: 404, retryable: false, message: 'nope' });
  const blocks = health.blocks();
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].scope, 'model');
  assert.strictEqual(blocks[0].id, A.id);
  assert.ok(blocks[0].why.length > 0);
});

console.log('\n== health: the gate is not bypassable through failover ==');

t('failover will not hand back a model the health gate excluded', () => {
  const health = new HealthRegistry({ [A.id]: snap('unavailable') });
  const r = routerWith(health);
  // Pretend B just failed, so failover would otherwise reach for A.
  const route = r.routeFallback(signals(), [B.id]);
  assert.strictEqual(route, null, 'the only alternative is unhealthy, so there is nowhere to go');
});

t('an eligible, healthy model is still reachable through failover', () => {
  const r = routerWith(new HealthRegistry({}));
  const route = r.routeFallback(signals(), [B.id]);
  assert.ok(route);
  assert.strictEqual(route.model.id, A.id);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
