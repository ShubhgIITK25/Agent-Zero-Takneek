# NEXide

An agentic coding IDE built for the Takneek PS (IIT Kanpur Programming Club). Electron + Next.js shell around a standalone multi-agent orchestrator that plans, routes, executes, verifies, and retries coding subtasks against a curated roster of ≤80B-parameter models — with a live observability dashboard, block-level diff review, and full crash-safe resume.

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` starts the Next.js renderer (`http://localhost:3210`) and, once it's up, compiles and launches the Electron shell. The orchestrator is spawned by Electron's main process as a separate child process the first time you send a task — you don't start it manually.

### Required API keys

Open **Settings** in the app and enter keys for whichever providers you want available:

- **Groq** — `GROQ_API_KEY`. Free tier, fastest of the three, and the default for most subtasks.
- **OpenRouter** — `OPENROUTER_API_KEY`. Free-tier routes, used both as its own provider and as Groq's failover target.
- **Ollama** — no key; point it at a local `ollama serve` (default `http://localhost:11434`). Zero marginal cost, useful when you want to keep a demo running without burning free-tier quota.

A model is only offered to the router once its provider has a saved, valid key (or, for Ollama, a reachable local server). Keys are stored locally, never bundled or committed.

## The agent system

Every task goes through the same pipeline, checkpointed after each step so a task can be killed and resumed without losing progress:

**decompose → route → execute → verify → retry → aggregate**

1. **Decompose** — a planning-tier model breaks the prompt into subtasks with explicit dependencies.
2. **Route** — each subtask is assigned a model by deterministic scoring, not another LLM call: capability fit (does this model's `good_at` list cover the subtask's category), context-window fit, cost pressure (scaled by how much of the budget is already spent), with speed as a tiebreak.
3. **Execute** — the assigned model runs with tool access (read/write/run_command), gated by three independent stuck-detection caps per subtask: 3 retries, 12 steps, 60k tokens, plus a guard that aborts after 3 identical repeated tool calls.
4. **Verify** — a separate verification-tier model checks the subtask's output against its stated goal.
5. **Retry** — a failed verification re-queues the subtask (up to its retry cap) rather than failing the whole task immediately.
6. **Aggregate** — once every subtask has resolved to `done`, `failed`, or `skipped`, results are summarized back to the user.

A task only ends in `done` if **every** subtask ended `done`. Any subtask left `failed` (retries exhausted) or `skipped` (its dependency failed) makes the whole task end `failed`, with the specific subtask(s) and reasons named in the failure message — a partially-successful run is never reported as a plain success.

Long-running context is kept in check by compaction: at 70% of the active model's real context window, older turns are summarized; at 88%, compaction is forced. Anything marked as a pinned fact is re-injected verbatim after compaction rather than being re-summarized, so constraints and decisions from earlier in the task don't drift.

Writes, deletes, and shell commands never execute unmediated — they go through the approval gate described below.

## Model roster and eligibility

The PS constraint is 80B **total** parameters (not active parameters — this matters for MoE models, where total and active can differ by an order of magnitude). The registry (`orchestrator/models.ts`) is the single source of truth for eligibility, and it deliberately includes two models that fail the rule so the constraint is visibly enforced rather than just assumed:

| Model | Provider | Total params | Active params | Eligible? |
|---|---|---|---|---|
| GPT-OSS 120B | Groq | 120B | — | **No** — dense, over the 80B ceiling |
| Nemotron 3 Super 120B-A12B | OpenRouter | 120B | 12B | **No** — total is what counts, not active; this is the exact MoE trap the rule targets |

Everything else in the registry — Llama 3.1 8B, GPT-OSS 20B, Qwen 3.6 27B, and Llama 3.3 70B on Groq; Gemma 4 31B, Gemma 4 26B-A4B, Nemotron 3 Nano 30B-A3B, and LFM 2.5 2.6B on OpenRouter; Qwen2.5 Coder 7B/14B and Gemma 3 12B on Ollama — is at or under 80B total and eligible. A model whose provider doesn't publish a parameter count is treated as ineligible by default (unverifiable, not "probably fine").

Provider catalogues and pricing drift; re-check model ids against the live docs before a demo.

## Settings

- **API keys** per provider, with inline validation.
- **Model roster**, showing every registry entry with its parameter count, context window, pricing, and eligibility — including the two blocked models above, with the reason shown rather than hidden.
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

File edits are presented as block-level diffs (LCS-based) with **partial approval**: you can accept individual hunks and reject others in the same diff, and only the accepted hunks are applied — rejected ones are dropped and the hunk set is rebuilt from the original plus whatever you accepted. Shell commands go through the same approval gate as a single yes/no.

## Observability dashboard

The live dashboard and the post-hoc "replay a finished task" dashboard are driven by the same pure reducer folding over the same event stream — one from live IPC events, the other from the task's persisted `events.jsonl` — so what you see live and what you see on replay can never diverge into two different renderings of the same run.

Every task is persisted as an append-only JSONL event log plus an atomically-written (temp file + rename) snapshot, so a crash or force-quit mid-task loses at most the in-flight step, and the task list lets you resume from the last checkpoint.

## Testing

```bash
npm test
```

Runs, in order: `unit.js` (router scoring, budget math, diff/compaction unit tests), `task-completion.js` (an end-to-end regression test through the real `TaskRunner`, with the model boundary mocked, proving a task with any non-`done` subtask ends `failed` — not `done` — and emits `task_failed` with the specific subtask(s) named), and `protocol.js` (JSON-RPC message round-trip tests).

`npm run typecheck` runs all three `tsconfig.json`s (root, `electron/`, `orchestrator/`) with `--noEmit`.

## Known limitations

- Ollama models require a local server the judges' machine may not have running; keep a Groq/OpenRouter fallback path in the demo.
- Provider catalogues change; `groq:qwen3.6-27b` and similar preview-tier ids are the most likely to be renamed or retired without notice.
- The orchestrator is a separate Node child process (spawned via `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, so no separate Node install is required on the end-user machine) rather than running inside Electron's main process — this keeps a runaway agent from ever blocking the UI thread, at the cost of one extra IPC hop per event.
