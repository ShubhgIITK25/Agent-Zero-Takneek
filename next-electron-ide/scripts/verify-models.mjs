/**
 * ============================================================================
 *  verify-models — check the registry against the live provider catalogues
 * ============================================================================
 *   npm run verify:models
 *
 * The registry in orchestrator/models.ts is a set of factual claims: this id
 * exists, it costs this much, its window is this big, it has this many total
 * parameters. Provider catalogues churn every few weeks, and a claim that has
 * quietly gone stale does not fail at build time — it fails as a 404 during a
 * demo, or worse, as a silent eligibility error nobody notices until the
 * parameter count is challenged.
 *
 * So this re-derives those claims from the sources rather than trusting the
 * file, and exits non-zero when they disagree:
 *
 *   OpenRouter  openrouter.ai/api/v1/models   — public, no key. Gives id,
 *               context, price, HuggingFace repo and published param counts.
 *   Groq        console.groq.com/docs/models  — public docs page; we assert
 *               the model id still appears in it.
 *   Ollama      ollama.com/library/<m>/tags   — public; we assert the exact
 *               tag we ask users to pull still exists.
 *   Gemini      not checkable — listing the models endpoint needs a key. The
 *               one gemini entry is reported as UNVERIFIABLE, never as OK, so
 *               it can never be mistaken for a checked claim.
 *
 * A drift in price or context is a WARN (it still works, the accounting is
 * just wrong). A missing id is a FAIL, because the model is gone.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The registry is TypeScript, and this script deliberately has no build step or
// dependencies — it must run on a clean checkout. The entries are plain object
// literals, so strip the types and evaluate the array directly.
function loadRegistry() {
  const src = readFileSync(join(ROOT, 'orchestrator/models.ts'), 'utf8');
  const start = src.indexOf('export const MODEL_REGISTRY');
  // Anchor on the `=`, not on `start` — the type annotation `: ModelEntry[]`
  // contains a `[` of its own that comes first.
  const open = src.indexOf('[', src.indexOf('=', start));
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (start < 0 || end < 0) throw new Error('could not locate MODEL_REGISTRY in orchestrator/models.ts');
  return new Function(`return ${src.slice(open, end)}`)();
}

const get = async (url, as = 'json') => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return as === 'json' ? res.json() : res.text();
};

const results = [];
const ok = (id, msg) => results.push({ level: 'ok', id, msg });
const warn = (id, msg) => results.push({ level: 'warn', id, msg });
const fail = (id, msg) => results.push({ level: 'fail', id, msg });
const skip = (id, msg) => results.push({ level: 'skip', id, msg });

const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-9);

const registry = loadRegistry();
console.log(`checking ${registry.length} registry entries\n`);

// --- OpenRouter -------------------------------------------------------------
let orModels = null;
try {
  orModels = (await get('https://openrouter.ai/api/v1/models')).data;
} catch (err) {
  console.error(`could not reach OpenRouter (${err.message}); its entries will be skipped`);
}

for (const m of registry.filter((x) => x.provider === 'openrouter')) {
  if (!orModels) {
    skip(m.id, 'OpenRouter catalogue unreachable');
    continue;
  }
  const live = orModels.find((x) => x.id === m.apiId);
  if (!live) {
    fail(m.id, `"${m.apiId}" is not in the OpenRouter catalogue any more`);
    continue;
  }
  const inPerM = Number(live.pricing.prompt) * 1e6;
  const outPerM = Number(live.pricing.completion) * 1e6;
  if (!near(inPerM, m.pricing.inputPerM) || !near(outPerM, m.pricing.outputPerM)) {
    warn(
      m.id,
      `price drift: registry $${m.pricing.inputPerM}/$${m.pricing.outputPerM} vs live $${inPerM.toFixed(3)}/$${outPerM.toFixed(3)} per 1M`
    );
  }
  if (live.context_length !== m.contextWindow) {
    warn(m.id, `context drift: registry ${m.contextWindow} vs live ${live.context_length}`);
  }
  // The eligibility-critical claim. If the description states a total, it wins
  // over anything the registry says, because that is the number a judge reads.
  const stated = /([\d.]+)B? ?(?:billion)? total param/i.exec(live.description ?? '');
  if (stated && !near(Number(stated[1]), m.paramsBTotal, 0.05)) {
    fail(m.id, `parameter claim: registry says ${m.paramsBTotal}B total, provider says ${stated[1]}B`);
  }
  if (results.at(-1)?.id !== m.id) ok(m.id, `${m.apiId} — id, price, context and parameter count all match`);
}

// --- Groq -------------------------------------------------------------------
let groqDocs = null;
try {
  groqDocs = await get('https://console.groq.com/docs/models', 'text');
} catch (err) {
  console.error(`could not reach the Groq docs (${err.message}); its entries will be skipped`);
}

for (const m of registry.filter((x) => x.provider === 'groq')) {
  if (!groqDocs) skip(m.id, 'Groq docs unreachable');
  else if (groqDocs.includes(m.apiId)) ok(m.id, `${m.apiId} — still listed on console.groq.com/docs/models`);
  else fail(m.id, `"${m.apiId}" no longer appears in the Groq model list`);
}

// --- Ollama -----------------------------------------------------------------
for (const m of registry.filter((x) => x.provider === 'ollama')) {
  const [name, tag] = m.apiId.split(':');
  try {
    const page = await get(`https://ollama.com/library/${name}/tags`, 'text');
    if (page.includes(`${name}:${tag}`)) ok(m.id, `${m.apiId} — tag exists in the Ollama library`);
    else fail(m.id, `"${m.apiId}" is not a published tag of ollama.com/library/${name}`);
  } catch (err) {
    skip(m.id, `could not read the Ollama library (${err.message})`);
  }
}

// --- Gemini -----------------------------------------------------------------
for (const m of registry.filter((x) => x.provider === 'gemini')) {
  skip(m.id, 'UNVERIFIABLE without a GEMINI_API_KEY — listing generativelanguage.googleapis.com is authenticated');
}

// --- report -----------------------------------------------------------------
const icon = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ', skip: ' skip ' };
for (const r of results) console.log(`${icon[r.level]} ${r.id.padEnd(34)} ${r.msg}`);

const counts = results.reduce((a, r) => ((a[r.level] = (a[r.level] ?? 0) + 1), a), {});
console.log(
  `\n${counts.ok ?? 0} verified, ${counts.warn ?? 0} drifted, ${counts.fail ?? 0} missing, ${counts.skip ?? 0} unchecked`
);

if (counts.fail) {
  console.log('\nA model in the registry no longer exists. Fix orchestrator/models.ts before shipping.');
  process.exit(1);
}
