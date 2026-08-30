# NEXide

An agentic coding IDE built for the Takneek PS (IIT Kanpur Programming Club). Electron + Next.js shell around a standalone multi-agent orchestrator that plans, routes, executes, verifies, and retries coding subtasks against a curated roster of ≤80B-parameter models — with a live observability dashboard, block-level diff review, and full crash-safe resume.

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` starts the Next.js renderer (`http://localhost:3210`) and, once it's up, compiles and launches the Electron shell. The orchestrator is spawned by Electron's main process as a separate child process the first time you send a task — you don't start it manually.

### Building desktop installers

The packaging targets are native to each desktop OS: NSIS on Windows, DMG and
ZIP on macOS, and AppImage and DEB on Linux. Run the matching command on that
platform so native dependencies such as `node-pty` are rebuilt correctly:

```bash
npm run dist:win
npm run dist:mac
npm run dist:linux
```

The installers are written to `release/`. The repository's GitHub Actions
workflow runs the same build on native Windows, macOS, and Linux runners and
uploads each platform's artifacts from every `main` push or manual run. CI
artifacts are unsigned; production signing and macOS notarization require
platform certificates and secrets.

### Required API keys

Open **Settings** in the app and enter keys for whichever providers you want available:

- **Groq** — `GROQ_API_KEY`. Free tier, fastest of the three, and the default for most subtasks.
- **OpenRouter** — `OPENROUTER_API_KEY`. Free-tier routes, used both as its own provider and as Groq's failover target.
- **Ollama** — no key; point it at a local `ollama serve` (default `http://127.0.0.1:11434`). Zero marginal cost, useful when you want to keep a demo running without burning free-tier quota. See **[Running on a local model](docs/local-models.md)** for setup, which model fits which machine, and why the local context windows are deliberately small.

A model is only offered to the router once its provider has a saved, valid key (or, for Ollama, a reachable local server). Keys are stored locally, never bundled or committed.

## The agent system

Every task goes through the same pipeline, checkpointed after each step so a task can be killed and resumed without losing progress:

**decompose → route → execute → verify → retry → aggregate**

1. **Decompose** — a planning-tier model breaks the prompt into subtasks with explicit dependencies.
2. **Route** — each subtask is assigned a model by deterministic scoring, not another LLM call: capability fit (does this model's `good_at` list cover the subtask's category), context-window fit, cost pressure (scaled by how much of the budget is already spent), with speed as a tiebreak.
3. **Execute** — the assigned model runs with tool access (read/write/run_command), gated by three independent stuck-detection caps per subtask: 3 retries, 12 steps, 60k tokens, plus a guard that aborts after 3 identical repeated tool calls.
4. **Verify** — a separate verification-tier model checks the subtask's output against its stated goal.
5. **Retry, with backtracking** — a failed verification **rolls the workspace back** to its state before the subtask ran, *then* re-queues the subtask (up to its retry cap) with the verifier's reason fed into the conversation.

   The rollback is the part that matters. Without it, attempt 2 starts from a tree the verifier has already rejected and attempt 3 compounds it — and when the retries run out, the union of every broken attempt is left on disk under a subtask marked `failed`, with its dependents blocked so nothing downstream ever cleans up. The undo point is captured lazily: the first time a subtask writes to a file, that file's prior content is stashed (creating a file records "did not exist", so undoing it is a delete). Restoring costs one write per touched file and needs no VCS — deliberately *not* `git stash`/`git checkout .`, because the project root isn't guaranteed to be a repo, and an agent reaching into the user's index to undo its own mistake is a worse failure than the one it's fixing.

   Rollback fires on all four terminal failures: verification failed with retries left, retries exhausted, the agent reported `BLOCKED`, and no model available. It never fires on a pass — verified work drops its undo point immediately, so no later failure can reach back and revert a subtask that succeeded. Because a rollback can undo edits **you approved by hand**, it's always reported as a `workspace_restored` intervention naming every file, and the retry prompt explicitly tells the model its edits were reverted (otherwise it assumes they survived and writes half a fix).

6. **Re-plan, bounded** — when a subtask has spent *every* retry, the system stops retrying and changes the plan instead.

   The retry ladder has already re-run that subtask on a stronger model with the verifier's complaint fed back in. If three of those failed, the model isn't the problem — **the subtask is**, and a fourth retry is precisely the "blindly retrying the same action" the PS penalises. So a re-planner is asked to *diagnose* the failure and either decompose the subtask into 2–3 genuinely different steps, or say it's impossible. `abandon` is a first-class answer: a re-planner that always produces a new decomposition is one that spends the remaining budget rewording the same impossible subtask.

   The replaced subtask becomes `replaced` — a status distinct from `failed` on purpose, because the work is still being attempted under new ids, and counting it as incomplete would make a *successful* re-plan report failure. Anything that depended on it is rewired to the last replacement; without that rewire the dependents wait forever on an id that can never be `done`.

   **Every bound is a hard stop, checked before the planner call so a disallowed re-plan costs nothing:**

   | Bound | Value | Why |
   |---|---|---|
   | Re-plans per task | 2 | Whole-task budget, not per-subtask — stops a struggling task rewriting its own plan indefinitely |
   | Re-plan depth | 1 | Only original subtasks may be re-planned. A replacement that fails is simply failed — no recursive tree of re-plans |
   | Replacements per re-plan | 3 | Caps how far one re-plan can widen the DAG |
   | Cost remaining | ≥25% | A re-plan buys a planner call **plus** a fresh round of subtask work |
   | Time remaining | ≥20% | Same |

   The budget gates use `fractionRemaining`, not `canAfford` — `canAfford` answers "can I pay for this one call", which is the wrong question for a decision that commits to a whole extra round of work. Starting a re-plan at 90% spent reliably converts a partial result into a **ceiling breach, which scores zero** — strictly worse than accepting one failed subtask. Every refusal emits a `replan_declined` intervention naming which bound stopped it, so "we could have re-planned but didn't" is never silent.
7. **Aggregate** — once every subtask has resolved to `done`, `failed`, `skipped`, or `replaced`, results are summarized back to the user.

**Parallel subtasks.** Subtasks whose dependencies are already satisfied run concurrently — up to the limit set in Settings (default 3; `1` is strictly sequential). The dependency graph is unchanged; the only difference is that more than one *ready* subtask may be in flight. Three things had to be made concurrency-safe first, and each is a real failure mode rather than a hypothetical one:

- **Approvals are serialised.** The review pane holds exactly one pending diff, so a second concurrent approval request would replace the first in the UI — and the first, which an agent is blocked on, would never resolve. That is a permanent hang. One approval is outstanding at a time, task-wide.
- **Every write re-checks the file.** A diff is computed against the file as it was when the agent proposed it. If the bytes moved since — a parallel subtask's approved edit, or you typing in the editor while the review sat open — the write is refused and the agent is told to re-read and re-propose. Serialising the prompt is not enough to prevent a lost update; only comparing against what was actually read is.
- **Undo points are per subtask.** Rolling back a failed subtask must not revert a sibling's approved edits, so each subtask owns its own backtrack map, and the verifier is shown only the files its own subtask changed.

Concurrency also drops back to one automatically once spending passes 75% of the cost ceiling: concurrent dispatches can each pass the affordability check and still breach together, and a breach scores zero.

A task only ends in `done` if **every** subtask ended `done`. Any subtask left `failed` (retries exhausted) or `skipped` (its dependency failed) makes the whole task end `failed`, with the specific subtask(s) and reasons named in the failure message — a partially-successful run is never reported as a plain success.

Long-running context is kept in check by compaction: at 70% of the active model's real context window, older turns are summarized; at 88%, compaction is forced. Anything marked as a pinned fact is re-injected verbatim after compaction rather than being re-summarized, so constraints and decisions from earlier in the task don't drift.

Writes, deletes, and shell commands never execute unmediated — they go through the approval gate described below.

## Code retrieval

A codebase is chunked on **AST boundaries** (tree-sitter): one chunk per function/class/method, with its signature, docstring and body kept together — never a fixed-token window that starts mid-function. Each project gets its own SQLite index keyed by `sha256(absolute path)[:16]`, so retrieval and agent memory cannot leak between projects.

A query runs four stages:

1. **Recall** — BM25 and vector search, unioned. Two independent retrievers over different representations.
2. **Expand** — 1-hop call/import-graph neighbours of the strongest vector hits, so a structurally-relevant chunk that doesn't *sound* like the query still surfaces.
3. **Rerank** — a local cross-encoder cuts the pool to the k chunks worth spending the calling model's tokens on. Fused with **Reciprocal Rank Fusion**, which combines *ranks* rather than raw scores: BM25 scores, cosine distances and cross-encoder logits live on incomparable scales, and averaging them directly would be arithmetic on units that don't share a zero.
4. **Recover** — described below.

### Making natural language match identifiers

SQLite's FTS5 tokeniser treats `computeDelinquencyGraceWindow` as **one atomic token**. So "delinquency grace window" — or any natural-language phrasing — could never match it through BM25, no matter how the query was worded, because the *indexed* form was atomic. Verified directly:

```
FTS5 MATCH 'computeDelinquencyGraceWindow'  -> 1 hit
FTS5 MATCH 'delinquency'                    -> 0 hits
```

So at index time every identifier in a chunk's symbol and code is **also** stored split into sub-words, in a dedicated `tokens` FTS column (`identifiers.py`). Raw code is still indexed verbatim, so exact-identifier search is unchanged; the split column is pure additional recall. The same split runs on the query, so a pasted `getUserById` also searches as `get user by id`.

**Why not a custom FTS5 tokeniser** — the "correct" answer, and it needs a C extension compiled per platform: exactly the dependency this service was built to avoid (it's why `sqlite-vec` was chosen over a standalone vector DB). A pre-split column is pure Python, costs one pass per chunk at index time, and is inspectable in any DB browser.

This is a schema change, so the index carries an `INDEX_FORMAT_VERSION` in `PRAGMA user_version`. An index written by an older format is dropped and rebuilt from source rather than migrated in place — rebuilding is fast and cannot leave a half-migrated file.

### Detecting and recovering from a weak retrieval

Even with that, a first attempt can come back weak. Detection uses signals that are each independently interpretable — **deliberately not the `score` field**, which is an RRF *rank* score whose maximum here is ≈0.074 and whose absolute value carries no semantic meaning. Thresholding on it would look like a confidence measure and be numerology.

The anchor signal is **retriever agreement**. BM25 and vector search are independent — different representation, different algorithm — so a chunk both rank highly is corroborated by two methods that fail differently. Agreement requires a **majority** of the top results, not one: a single lexical coincidence is not evidence.

The cross-encoder gets two thresholds, not one, because its usable range on code is not its nominal range. Measured against this project's own `orchestrator/` (161 chunks):

| | top reranker score | agreement (of top 3) |
|---|---|---|
| Answerable queries (6) | **−4.1 … +4.5** | 3/3 every time |
| Absent queries (5) | **−11.2 … −9.0** | 0–1/3 |

There is a wide empty band between ≈−9 and ≈−4 separating "the model is grumpy about code" from "nothing here is on topic". Both thresholds sit inside it:

| Signal | With agreement | Without agreement |
|---|---|---|
| Reranker below **−8** (`RERANK_IRRELEVANT_BELOW`) | **decisive** | **decisive** |
| Reranker below **−6** (`RERANK_WEAK_BELOW`) | contributing | **decisive** |
| Candidate pool thin *relative to index size* | contributing | **decisive** |
| Most results graph-expansion only | contributing | contributing |
| Fewer results than requested | contributing | contributing |

Three of these came out of testing against a real index and would have been wrong otherwise:

- **The cross-encoder cannot outvote two agreeing retrievers** — `ms-marco-MiniLM` is web-trained and systematically under-scores code, so treating its nominal 0 boundary as decisive flagged *correct* results weak.
- **…but below −8 it wins anyway.** With agreement as a blanket veto, `kubernetes ingress controller helm values` scored 0.7 and passed as strong against a codebase containing no Kubernetes — a single lexical hit on the word "values" counted as corroboration. Hence the majority rule and the second threshold.
- **Pool size is relative to index size.** An absolute "fewer than 6 candidates" floor fires on every query in a small repo, where matching most of the index is a *complete* retrieval, not a failed one.

Current accuracy on the real orchestrator source: **10/10 answerable queries not flagged, 5/5 unanswerable queries flagged**. That check runs in `test_recovery_e2e.py` so a regression in the thresholds fails a test rather than quietly degrading.

When a result is weak, retrieval retries itself before the caller ever sees it: recall widens (25 → 60), graph expansion widens (8 → 16), k doubles (capped 16), and the query is **narrowed** — filler words stripped, then optionally reduced to its most distinctive nouns.

Reformulation is deliberately conservative, and that too is a test result. An earlier version synthesised identifier spellings (`userSession`, `user_session`, `usersession`, …) and ORed a dozen guesses into the FTS query. Once the index-level split landed that bought nothing — and it started **manufacturing false agreement**: a query with no real answer would OR enough guesses together to look corroborated, so `terraform kubernetes helm chart` came back "confident". Narrowing only removes terms; it cannot invent matches.

**Why not ask a model to rewrite the query.** It puts a model round-trip inside the most-called tool in the system, on the cost term weighted ~2× time. The deterministic path costs nothing, has no latency variance, and is *reproducible* — the same weak query always escalates identically, which a rewrite model couldn't guarantee and which would make the dashboard trace unrepeatable. If it still comes back weak the tool hands the problem **up** to the agent, which is already a model in a loop and can rephrase semantically — paid for by a call we were making anyway.

Three properties that could have gone wrong:

- **Escalating can never return a worse set.** The best attempt wins on confidence; if widening surfaces only noise, the original results are returned and the low confidence reported honestly.
- **Bounded** — at most `MAX_VARIANTS_TRIED` (2) retries, exiting at the first that clears the bar.
- **Never silent** — every attempt (query, k, confidence, reasons) is recorded in `attempts` and surfaced as a `retrieval_weak` intervention. A result that *stays* weak reaches the agent with a `[retrieval confidence 0.15 — LOW]` header naming the queries already tried, so its next move is genuinely different. Silently returning low-confidence snippets is how an agent ends up confidently editing the wrong file.

### Testing retrieval

```bash
python3 -m venv retrieval-service/.venv
retrieval-service/.venv/bin/pip install -r retrieval-service/requirements.txt

npm run test:retrieval                                    # fast, stubbed, in npm test
retrieval-service/.venv/bin/python retrieval-service/test_recovery_e2e.py   # real index
retrieval-service/.venv/bin/python retrieval-service/verify.py .            # inspect a real run
```

`test_recovery.py` stubs `store` and `embeddings` to test the escalation control flow cheaply — no model download, no index on disk — and runs inside `npm test`. `test_recovery_e2e.py` builds a **real** index with real tree-sitter chunking, real embeddings and a real cross-encoder, and asserts behaviour a stub cannot: that natural-language queries now match atomic identifiers on the first attempt, that good results are *not* escalated (wasted latency), and that a query with no answer stays weak. It's ~30s on first run, so it isn't in `npm test`.

## Model roster and eligibility

The PS constraint is 80B **total** parameters (not active parameters — this matters for MoE models, where total and active can differ by an order of magnitude). The registry (`orchestrator/models.ts`) is the single source of truth for eligibility, and it deliberately carries four models that fail the rule so the constraint is visibly enforced rather than just assumed. Each fails in a different way, because each is a different way of being fooled:

| Model | Provider | Total | Active | Why it's blocked |
|---|---|---|---|---|
| GPT-OSS 120B | Groq | 120B | — | Dense and simply over the ceiling. The easy case. |
| Nemotron 3 Super 120B-A12B | OpenRouter | 120B | 12B | Total is what counts. Checking *active* params passes it. |
| Llama 4 Maverick 17B-128E | Groq | 400B | 17B | The api id itself says `17b`. Filtering on the model **name** ships a 400B model. |
| Mistral Small 4 | OpenRouter | 119B | — | Called "Small". "Small" is a product line, not a size — the published repo is `Mistral-Small-4-119B-2603`. |

A model whose provider doesn't publish a parameter count is treated as ineligible by default (unverifiable, not "probably fine").

### Eligible roster

| Model | Provider | Total | Cost /1M in→out | Quality¹ | Used for |
|---|---|---|---|---|---|
| **Qwen 3.8 27B** | Groq | 27B | $0.80 → $4.00 | **52.0** | Planning, tie-break, hard codegen |
| **Qwen 3.8 27B (1M ctx)** | OpenRouter | 27B | $0.43 → $2.55 | **52.0** | Same weights, ~half price, 1M window — failover + huge contexts |
| Qwen 3.6 27B | Groq | 27B | $0.60 → $3.00 | 37.7 | Same-provider fallback |
| Qwen 3.6 35B-A3B | OpenRouter | 35B | $0.10 → $0.90 | 32.1 | Best quality-per-dollar; default paid choice |
| Gemma 4 31B | OpenRouter | 31B | **free** | 29.7 | Free workhorse |
| Gemma 4 26B-A4B | OpenRouter | 25.2B | **free** | 26.1 | Free, 3.8B active — fast |
| Nemotron 3.5 Lightning 30B-A3B | OpenRouter | 30B | **free** | 23.6 | Free with a 1M window — the "context too big, budget too small" escape hatch |
| GPT-OSS 20B | Groq | 20B | $0.075 → $0.30 | 15.2 | Cheapest hosted model that still calls tools reliably |
| North Mini Code 30B-A3B | OpenRouter | 30B | **free** | 20.2 | Free agentic *coding* model (coding index 36.5) |
| Nemotron 3 Nano 30B-A3B | OpenRouter | 30B | **free** | 13.8 | Cheap third opinion |
| Llama 3.3 70B | Groq | 70B | $0.59 → $0.79 | — | Long-context analysis only; **not** tagged for codegen (see below) |
| Llama 3.1 8B Instant | Groq | 8B | $0.05 → $0.08 | — | Cheap floor |
| LFM 2.5 2.6B | OpenRouter | 2.6B | **free** | — | Trivial classification only |
| Qwen2.5 Coder 7B · Granite 4 7B-A1B · Qwen2.5 Coder 14B · Gemma 3 12B · Qwen3 Coder 30B-A3B | Ollama | 7–30B | **$0** | — | [Local models →](docs/local-models.md) |

¹ Artificial Analysis intelligence index, as published in the OpenRouter catalogue. Omitted where the model hasn't been benchmarked.

**Why quality index and not parameter count.** Size used to be the router's proxy for "more capable", and it has aged badly: Llama 3.3 70B is 2.6× the size of Qwen 3.8 27B and scores 11.9 against its 68.1 on coding. So the router escalates on the published benchmark index, falling back to size (capped) only for models nobody has scored. That's also why Llama 3.3 70B is no longer tagged for `codegen` — keeping it there meant the biggest model kept winning work it's now bad at.

**Where the quality actually gets spent.** The index is weighted per subtask category (`QUALITY_WEIGHT` in `orchestrator/router.ts`), not flatly, because the cost of being wrong isn't flat. A bad `simple_edit` is caught on the next line; a bad plan is only caught after every subtask under it has been paid for, and a bad verification verdict is never caught at all — it ships. So `analysis` (which is how the planner and the tie-break both route) and `verification` weight quality ~4× harder than `simple_edit` does. Cost still dominates overall — the cost penalty reaches 45 against quality's ~23 — so a free model that fits still wins early in a task, which is correct when C is weighted ~2× T in `S_task`. Quality decides between models of *similar* price, and decides the tie-break outright.

### Keeping the registry honest

```bash
npm run verify:models
```

Every id, price, context window and parameter count in the registry is a factual claim about a catalogue that churns every few weeks, and a stale claim doesn't fail at build time — it fails as a 404 mid-demo. `scripts/verify-models.mjs` re-derives those claims from the live sources (`openrouter.ai/api/v1/models`, `console.groq.com/docs/models`, `ollama.com/library/<model>/tags`) and exits non-zero if a model has disappeared. A price or context drift is reported as a warning; a missing id is a failure. Last full run: **2026-08-30 — 21 verified, 0 missing.**

The one entry it can't check is the Gemini route, because listing `generativelanguage.googleapis.com` requires a key — so it's reported as `skip`/UNVERIFIABLE rather than being quietly counted as OK.

## Settings

- **API keys** per provider, with inline validation.
- **Model roster**, showing every registry entry with its parameter count, context window, pricing, and eligibility — including the blocked models above, with the reason shown rather than hidden.
- **Live health pill** on every eligible model, checked on open and on demand: `working`, `invalid key`, `rate-limited`, `unavailable`, `offline`. This is a *different question* from eligibility — a model can be perfectly eligible and completely dead — so the two badges sit side by side rather than being merged. Hovering a pill gives what was actually observed plus the fix (`ollama pull qwen2.5-coder:7b`, `ollama serve`, the provider's own error text).

  It costs **one catalogue request per provider**, not one per model: each provider's `/models` listing answers all five questions at once — network up, key valid, quota intact, id still served — for every model of that provider simultaneously. Probing 23 models individually would burn free-tier quota to render a settings screen and would be likelier to trip the rate limit it's meant to report. Deliberately *not* a real completion call: that would be the most faithful test and it's what the orchestrator actually does, but it costs tokens every time someone opens Settings. A model that lists but errors on inference isn't caught here — it surfaces at run time as the `provider_failover` intervention that already exists. The probe runs in the main process (renderer `fetch` to provider APIs is CORS-blocked, and the keys live there), and it reads the keys **currently typed into the form**, so you can paste one and press *Re-check* before saving.
- **Budget ceiling**, checked *before* dispatch (not after) with a reserve margin, so a task can't blow past the limit mid-run.
- **Approval mode** for the diff/command gate (always ask, or auto-approve below a size threshold).

## Manual context control

`AGENTS.md` in your project root is loaded automatically and its rules are pinned through compaction, the same as any other pinned fact.

**Pinning files and code into context.** In the AI Agent panel, `@path/to/file.ts` pins a whole file and `@path/to/file.ts:20-40` pins just that line range; `+ current file` pins whatever's open in the editor. Pinned items show as removable chips above the input box — click the `×` on any chip to unpin it, or its label to jump straight to that file. Pins are read fresh off disk at send time, so a pinned file always reflects what's currently on it.

**Both directions are clickable.** Typing `@path:line` in the input box turns it into a pin; anywhere the agent writes `path:line` or `path:line-line` in its reply, the chat renders it as a link that opens that file at that line — so the agent can point back at exact code just as easily as you can point it at some.

**`.nexideignore` (or `.ignore`) — keeping noise out of context.** Drop a gitignore-syntax file named `.nexideignore` in the project root (a plain `.ignore` also works, if that's the name already in use) to stop matching paths from ever entering *automatic* context — `retrieve_context`, `read_file`, and `list_dir`, as called by an agent. `node_modules/`, build output, lockfiles, and anything holding secrets are good candidates. This does **not** touch a file you pin explicitly with `@path` — an explicit pin is a direct instruction, and letting a blanket ignore rule silently override it would be the more surprising behavior (the same asymmetry `.gitignore` has: `git add -f` still works on an ignored path). `.git` is always excluded, ignore file or not.

## Commands

- `/bytheway <question>` — an isolated one-off query that runs in its own two-message exchange, sharing no history or tool state with the active task. Use it for a quick side question without polluting the running task's context.

## Diff review

File edits are presented as Git-generated unified diffs with **partial approval**: you can accept individual hunks and reject others in the same diff, and only the accepted hunks are applied — rejected ones are dropped and the file is rebuilt from the original plus whatever you accepted. The proposal is compared with `git diff --no-index` against temporary files outside the project, so the real file is untouched until approval. Shell commands go through the same approval gate as a single yes/no.

## Observability dashboard

**Parallel execution.** A swimlane per subtask on a shared time axis, plus a live "N agents running" badge and the peak-vs-configured slot count. Bars that overlap horizontally ran concurrently — overlap is a geometric fact on a shared axis, not a claim in a status list. The lanes are drawn from recorded start/finish timestamps and the orchestrator's own `concurrency` events, never inferred from interleaved event ordering, so the dashboard cannot report parallelism that did not happen.

**Call hierarchy.** Every model call records the call that *caused* it, so the dashboard draws the real tree rather than a flat list: the planner is the root, each subtask's implementer turns hang off it, the verifier hangs off the implementer whose claim it judges, and a retry hangs off the verifier that rejected the previous attempt. Read top-down it explains *why* the task did what it did — something a time-ordered list can't show, since there "attempt 2" and "the verifier that forced attempt 2" are just two adjacent rows. Branches collapse, and a collapsed one reports the calls and cost it is hiding. **Full tree** shows the whole causal chain including edges that cross subtask boundaries; **By subtask** keeps the per-subtask grouping (status, category, retries, dependencies) with each group drawn as its own tree.

The live dashboard and the post-hoc "replay a finished task" dashboard are driven by the same pure reducer folding over the same event stream — one from live IPC events, the other from the task's persisted `events.jsonl` — so what you see live and what you see on replay can never diverge into two different renderings of the same run.

The dashboard's **Execution graph** is the compact causal view of that stream: thoughts, model calls, tool calls, approvals, checkpoints, interventions, and controlled file changes appear as connected event nodes. Each `propose_edit` write stores its before-state outside the project folder, so after a task stops the user can use **Revert latest**. Revert is guarded by a content hash and refuses to overwrite a file that changed after the agent; shell commands remain outside this tracked-write boundary because they can mutate arbitrary paths.

Every task is persisted as an append-only JSONL event log plus an atomically-written (temp file + rename) snapshot, so a crash or force-quit mid-task loses at most the in-flight step, and the task list lets you resume from the last checkpoint.

Routing decisions surface in two places from the one `routing_decision` event: the dashboard's per-node **Routing** tab, and — new — an expandable row in the agent panel itself. The panel row is a one-liner by default (`⇄ north-mini-code · fits codegen, zero marginal cost · 3 not picked`); clicking it drops down the full reason, the decision signals (category, attempt, budget/time remaining, context size), and every candidate that lost with the reason it lost (`llama-3.3-70b — scored 41.3 vs 58.7`, `gemma-4-31b — context ~60000 tok exceeds its 262144 window`). So the "why not the other models" is one click away, not buried in a separate panel.

## Testing

```bash
npm test
```

Runs, in order: `model-health.js` (the settings-screen provider probe, with `fetch` stubbed so all five health states are pinned deterministically and offline), `execution-graph.js` (durable controlled-file history, exact revert, and refusal to overwrite a later human edit), `unit.js` (router scoring, budget math, diff/compaction unit tests), `ignore.js`, `review-buffer.js`, `task-completion.js` (an end-to-end regression test through the real `TaskRunner`, with the model boundary mocked, proving a task with any non-`done` subtask ends `failed` — not `done` — and emits `task_failed` with the specific subtask(s) named), `backtrack.js` (same harness over a real temp project: every attempt fails verification, and the workspace must end byte-identical to how it started — an overwritten file restored, a created file deleted), `replan.js` (four scenarios through the real scheduler: a decomposed subtask recovers and the task still reports `done`; a failing replacement is *not* re-planned again; an abandoning re-planner leaves the failure standing; dependents are rewired to the replacements instead of deadlocking), `protocol.js` (JSON-RPC message round-trip tests), and `resume.js` (crash recovery from a hand-crafted checkpoint). `npm run test:retrieval` then runs `retrieval-service/test_recovery.py` — reformulation, the weak-detection signals, and the escalation control flow, with `store` and `embeddings` stubbed so it needs no tree-sitter, no fastembed, no model download and no index on disk. It is skipped with a notice if `python3` is unavailable.

`npm run typecheck` runs all three `tsconfig.json`s (root, `electron/`, `orchestrator/`) with `--noEmit`.

## Known limitations

- Ollama models require a local server the judges' machine may not have running; keep a Groq/OpenRouter fallback path in the demo. See [docs/local-models.md](docs/local-models.md).
- Provider catalogues change. Run `npm run verify:models` before a demo — it checks every id against the live catalogues. The Gemini entry is the one it can't check (that listing needs a key), so it's marked UNVERIFIABLE in the registry with the OpenRouter route to the same weights as its fallback.
- Backtracking covers files written through `propose_edit`, which is the only write path the orchestrator controls. Files mutated by an approved `run_command` (a formatter, a build step, a generator) are **not** captured and will survive a rollback — the intervention names exactly which files it did revert, so it never claims a clean tree it can't deliver. The undo point also lives in memory, so after a resume a rollback can only undo edits made since that resume.
- `qualityIndex` values come from Artificial Analysis via the OpenRouter catalogue. They're a published third-party benchmark, not our own measurement, and they're only comparable *between* the models listed here.
- The orchestrator is a separate Node child process (spawned via `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, so no separate Node install is required on the end-user machine) rather than running inside Electron's main process — this keeps a runaway agent from ever blocking the UI thread, at the cost of one extra IPC hop per event.
