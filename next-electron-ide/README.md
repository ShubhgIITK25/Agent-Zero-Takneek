# NEXide — a minimal IDE with Next.js + Electron

A small but functional desktop code editor: file explorer, tabbed Monaco
editor, save/dirty tracking, and native "Open Folder" dialog — built as a
starting scaffold, not a finished product.

## Architecture

```
next-electron-ide/
├── electron/              # Electron main process (TypeScript, compiled to electron-dist/)
│   ├── main.ts             # BrowserWindow, native menu, filesystem + terminal + settings +
│                            #   retrieval-service process management + IPC
│   └── preload.ts          # contextBridge — the ONLY thing the renderer can call into Node with
├── retrieval-service/       # Separate Python process — code retrieval pipeline (see below)
│   ├── server.py            # localhost HTTP API, spawned by electron/main.ts
│   ├── indexer.py           # walk + gitignore filter + hash-check + orchestrate chunk/embed/store
│   ├── chunker.py           # tree-sitter AST-boundary chunking (one chunk per function/class)
│   ├── embeddings.py        # fastembed: local embed + rerank, lazy-loaded, graceful fallback
│   ├── store.py             # one SQLite file per project: FTS5 (BM25) + sqlite-vec + call graph
│   ├── retrieval.py         # recall (BM25+vector) -> graph expansion -> rerank pipeline
│   ├── languages.py         # per-language tree-sitter grammar + query config
│   └── README.md            # setup + the "why this design" writeup for your Q&A
├── src/                     # Next.js app (the UI), loaded by BrowserWindow — named `src/`
│                            #   because Next.js only auto-detects `app/` at the project
│                            #   root or under `src/`, not under an arbitrary folder
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx         # top-level state: open folder, open tabs, active file, panels
│   │   └── globals.css      # VS Code-ish dark theme
│   ├── components/
│   │   ├── FileTree.tsx     # recursive, lazily-expanded folder tree
│   │   ├── Tabs.tsx         # open-file tab bar with dirty (•) indicator
│   │   ├── EditorPane.tsx   # Monaco editor, Ctrl/Cmd+S save binding
│   │   ├── StatusBar.tsx    # terminal / AI chat toggles, settings button, retrieval index status
│   │   ├── TerminalPanel.tsx # xterm.js, wired to a real shell via node-pty over IPC
│   │   ├── ChatPanel.tsx    # AI agent chat UI — frontend only, see agent.ts below
│   │   └── SettingsPanel.tsx # API keys / env vars, persisted outside the repo
│   └── lib/
│       ├── electron-api.ts  # shared TS types + `window.electronAPI` global typing
│       ├── language.ts      # file extension → Monaco language id
│       ├── llm.ts           # ★ THE integration point — implement callLLM() here
│       ├── tools.ts         # real tool implementations, incl. retrieve_context/open_file
│       └── agent.ts         # real orchestration loop: tool-calling, approval gate,
│                            #   step-limit guard — calls llm.ts, nothing else needed
├── next.config.js          # static export (output: 'export') so Electron can load it as local files
└── package.json
```

### Why it's split this way

- **Electron main process** is the only place with real Node/filesystem access (`fs/promises`).
  It never touches the DOM.
- **preload.ts** exposes a narrow, typed `window.electronAPI` surface via
  `contextBridge`, with `contextIsolation: true` and `nodeIntegration: false`.
  The renderer can never `require('fs')` directly — this is the standard
  Electron security boundary, keep it that way even as you extend the app.
- **Next.js renderer** is a normal React app that happens to be statically
  exported and loaded from disk (`file://.../renderer-out/index.html`) in
  production, or from `http://localhost:3210` during `npm run dev`.
- **retrieval-service/** is a separate Python process, not inline in the
  Node/TS orchestrator — see its own README for the full reasoning
  (embeddings/tree-sitter are most mature in Python; keeping it a separate
  long-running process means the index survives independently of any one
  agent task instead of being rebuilt every session).

## Getting started

```bash
npm install
cd retrieval-service && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && cd ..
npm run dev
```

(Windows: `.venv\Scripts\activate` instead of `source .venv/bin/activate`.)

This runs Next.js dev server and Electron concurrently (`concurrently` +
`wait-on`), with hot reload on the renderer side, and spawns the retrieval
service as a child process. Use **File → Open Folder…** (or `Cmd/Ctrl+O`)
to pick a project directory; click files in the sidebar to open them in
tabs; `Cmd/Ctrl+S` to save; **View → Toggle Terminal** (or `Cmd/Ctrl+\``,
or the Terminal button in the status bar) for a real shell
(PowerShell/cmd on Windows, `$SHELL` elsewhere) spawned via `node-pty` in
the main process and rendered with `xterm.js`.

`node-pty` is a native module, so after `npm install` it needs to be built
against Electron's ABI rather than your system Node's — the `postinstall`
script (`electron-builder install-app-deps`) does this automatically. If
the terminal doesn't open, check the Electron devtools console: a missing
native build toolchain (Python + a C++ compiler; on Windows, the
"Desktop development with C++" workload) is the usual cause — see
node-pty's README for platform prerequisites.

## Code retrieval

Opening a folder automatically indexes it (status shown in the status
bar: "Indexing…" → "Index ready (N files, M chunks)"). The index lives
outside the repo (`app.getPath('userData')/retrieval-index/<hash>.db`,
one SQLite file per project) and updates incrementally whenever a file
changes on disk — including files created by commands typed into the
integrated terminal, since it's fed by the same folder watcher that
drives the file tree's auto-refresh.

The agent's `retrieve_context` tool (`src/lib/tools.ts`) is what actually
searches it: AST-boundary chunking (real functions/classes, not fixed
token windows) via tree-sitter, keyword (BM25) + vector recall, 1-hop
call-graph expansion, and reranking — see **`retrieval-service/README.md`**
for the full pipeline and, importantly, the "why this design" writeup you
should read before presenting (per the PS's "no blind LLM defaults, be
ready to defend the trade-offs" guidance).

If the Python dependencies aren't installed, or no `python`/`python3` is
on `PATH`, the status bar shows "Retrieval unavailable" instead of the
app crashing — everything else keeps working, the agent just falls back
to its `read_file`/`list_dir` tools.

## The agent system

Four processes, three boundaries:

```
  Renderer (Next.js)          no Node access at all
        |  contextBridge
  Electron main               fs, node-pty, dialogs, settings, watcher
        |  stdio JSON-RPC          |  local HTTP
  Orchestrator (Node)          retrieval-service (Python)
```

**The orchestrator is a separate child process**, spawned by `electron/main.ts`
(`electron/orchestrator-bridge.ts`) and driven by newline-delimited JSON-RPC
over stdio. It is launched as `process.execPath` with `ELECTRON_RUN_AS_NODE=1`,
so the packaged app needs no separate Node installation.

Why stdio rather than a local HTTP port like the retrieval service uses: no port
allocation and no Windows firewall prompt; the channel dies exactly when the
process dies, which makes the watchdog trivially correct (EOF on stdout means
"gone", whereas an HTTP client cannot distinguish crashed from slow); and the
pipe guarantees ordering, so the event log the dashboard renders is in true
causal order for free. The retrieval service is HTTP because it is a
request/response service written in Python — a different problem.

Why a separate process rather than running in-process in Electron main: an
orchestrator crash cannot take the IDE down with it, and the boundary is a real
one you can point at. `main.ts` restarts it with backoff (capped at 5) and tells
the renderer, so an interrupted task can be resumed from its checkpoint.

### The pipeline

```
ingest -> decompose -> [ route -> execute -> verify -> retry? ]* -> aggregate
                              checkpoint after every step
```

| Stage | File | What it does |
|---|---|---|
| Decompose | `agents.ts` | A planner call turns the prompt into a dependency-ordered subtask DAG. Trivial prompts short-circuit to one subtask — running plan/execute/verify to answer "what does this function do" costs three calls for a one-call question. |
| Route | `router.ts` | Scores every eligible model on capability fit, context fit, cost pressure and speed. Emits the decision **and every rejection with its reason** the instant it is made. |
| Execute | `orchestrator.ts` | The implementer's tool-calling loop for one subtask, with only that subtask's context. |
| Verify | `agents.ts` | An **independent** call, different context, no memory of the implementer's reasoning — an agent asked "are you sure?" in its own conversation almost always says yes. |
| Tie-break | `agents.ts` | Implementer and verifier disagree and the verifier is unsure → a third model on a different provider decides. Neither side wins by default. |
| Aggregate | `orchestrator.ts` | Summarises. If the budget reserve is gone, the summary is built locally rather than breaching a ceiling to say "I'm done". |

### The three independent caps

`retries` (per subtask) catches the same approach failing repeatedly. `steps`
catches tool-calling forever without finishing. `tokens` catches the case a step
cap misses entirely — forty cheap steps and six expensive ones both hit "6
steps" at wildly different costs. Whichever fires first halts the subtask and
**emits an intervention**; nothing stops silently, because a failsafe nobody can
see is a failsafe nobody trusts.

Retries escalate rather than repeat: `attemptNumber` feeds the router (biasing
toward capability) and the verifier's failure reason is appended to the
conversation, so attempt 2 is a genuinely different attempt.

### Routing

Signals: task category, estimated context size, remaining budget, remaining
time, attempt number, and which providers are in rate-limit backoff. Cost
pressure scales with how tight the remaining budget is — early in a task a
capable model is worth paying for, near the ceiling cheap wins. That is the
mechanism that keeps runs under $0.50 instead of hoping.

Rejected alternatives, and why: **asking a model which model to use** adds a
full round-trip of cost and latency to every subtask to answer what four numbers
answer deterministically, and makes the routing trace unreproducible and
therefore useless for debugging. **Static category→model mapping** was the first
version; it happily routes a 60k-token context into a 32k window and keeps
picking a provider that is currently 429-ing.

Failover keeps the conversation and swaps the model underneath it, so no work is
lost. Non-retryable failures (bad key, malformed request) fail fast instead of
burning budget retrying everywhere.

### Compaction

Triggers against the **active model's real window**, not a constant: soft at
70% (opportunistic — input tokens are billed every turn), hard at 88% (compact
or the next call fails). A fixed "every N messages" rule is wrong in both
directions.

Survives compaction: the system prompt verbatim; the last 6 messages verbatim;
and `pinnedFacts` — AGENTS.md rules, the task goal, decisions taken — re-injected
**verbatim as a system message after every compaction**, so they cannot degrade
through repeated summarisation. Everything older becomes one summary from a
cheap model. Tool-call/tool-result pairs are never split across the boundary.

Rejected alternative: **drop-oldest** is cheaper but silently loses the decisions
that explain why the code is in its current state, and the agent then re-derives
them wrongly. One small call beats losing correctness.

### Human-in-the-loop

`propose_edit` **does not touch the disk**. It computes a diff against the file
on disk and blocks on an approval request; only accepted hunks are then written.
Rejecting is genuinely a no-op, not an undo.

Partial approval rebuilds the file from the original plus only the accepted
hunks, then tells the agent exactly what landed — so its next step reasons about
the real file rather than the one it proposed. Diffs are computed in-process
(`diff.ts`) rather than by shelling out to `git diff`, because the proposal
exists only in memory before approval; writing it to disk so git could diff it
would invert the whole approval gate. Git is still used for repository
operations.

### Persistence and resume

Per task, under `userData/tasks/<codebaseId>/<taskId>/`:
`events.jsonl` (append-only trace) and `state.json` (snapshot, written
write-temp-then-rename so a crash leaves the previous good snapshot rather than a
truncated one).

Chosen over SQLite: crash safety is free (a torn last line is detectable and
discardable); the dashboard wants an ordered event stream anyway, so no query
planner and no migration when an event type is added; and zero native
dependencies — `better-sqlite3` would need an Electron ABI rebuild on three
platforms. The trade-off accepted is no cross-task queries, which is fine
because the access pattern is always "one task, in order".

### Observability

**Live and post-hoc are the same component over the same reducer**
(`src/lib/trace.ts`). Live folds events arriving over IPC; history folds events
read back from `events.jsonl`. One code path, so there are no gaps between the
modes. `Ctrl/Cmd+Shift+D`, or the Dashboard button in the status bar.

Per task it shows the full call hierarchy grouped by subtask; per node the exact
prompt and response, thought stream, tokens, cost and latency; the exact files
and chunks in each agent's context; every routing decision with its signals and
rejected candidates; compaction events with what was preserved; every
intervention; the approval history; and live cost/time meters against the
ceilings.

## Model roster and eligibility

Every model in the pipeline must have a published **total** parameter count of
80B or less. Total, not active — the trap is that the cheapest-looking models on
every provider are sparse MoE advertised by active count.

`orchestrator/models.ts` is the single source of truth, and `checkEligibility()`
is called by both the router at runtime and the settings screen at display time,
so there is exactly one definition of "allowed" and no path around it. Two
entries exist specifically to prove the rule is enforced rather than assumed:

| Model | Total | Active | Verdict |
|---|---|---|---|
| `openai/gpt-oss-120b` (Groq) | 120B | — | **blocked** |
| `nvidia/nemotron-3-super-120b-a12b` (OpenRouter) | 120B | 12B | **blocked** — passes a naive active-param check |
| `google/gemma-4-26b-a4b-it` (OpenRouter) | 26B | 4B | allowed on total |

Both blocked models are *shown* in Settings, greyed, with the reason — a model
that silently vanished would teach nobody why it cannot be used. An unpublished
parameter count is also treated as ineligible: unverifiable is a disqualification
risk, which is why the earlier Gemini wiring was removed.

Providers: **Groq** (free tier, fastest, helps the T term), **OpenRouter** (free
routes; exists so failover is real), **Ollama** (local, zero marginal cost —
the strongest lever on the C term, which is weighted ~2x time).

⚠ Provider catalogues churn. These ids were checked against provider docs in
August 2026 — re-verify before submission.

## Settings

`Agent → Settings` (`Ctrl/Cmd+,`). Three tabs: **Models** (enable per model,
with eligibility gating), **API Keys** (`GROQ_API_KEY`, `OPENROUTER_API_KEY`,
`OLLAMA_HOST`), **Limits** (per-task cost and time ceilings, defaulting to the
evaluation's $0.50 / 2700s).

Keys are stored in `app.getPath('userData')/agent-settings.json`, outside the
repository, so they never reach git.

## Manual context control

Pin files or line ranges with `@path/to/file.ts` or `@path/to/file.ts:10-40` in
the input box, or the "+ current file" button. Pins render as removable chips —
what the agent can see is always visible and always editable. They are read at
send time, so the agent gets current disk content.

Tagging works both directions: any `path:line` or `path:line-line` the agent
mentions in the chat becomes a link that opens that file at that line.

`/bytheway <question>` is isolated at the protocol level — its own command in
the orchestrator, building its own two-message conversation with no tools and
never touching a running task. Isolation is structural, not a convention.
`/run <command>` bypasses the agent entirely and types into the terminal.

## Commands

```bash
npm run dev          # Next dev server + Electron + orchestrator + retrieval service
npm run build        # next build (static export) + tsc for electron/ and orchestrator/
npm run dist         # electron-builder -> release/
npm run typecheck    # all three tsconfigs
npm test             # 29 unit tests + an end-to-end stdio protocol test
```

`npm test` needs no test framework and no network — it covers partial-approval
diff reconstruction, defensive parsing of small-model output, the 80B total-vs-
active rule, routing decisions, and pre-dispatch budget enforcement, then spawns
the real orchestrator and drives the real protocol.

## Known limitations

Name these yourself rather than letting a judge find them:

- **One task at a time.** Two agents editing the same working tree with no
  coordination is a correctness problem, not a throughput opportunity.
  Concurrency belongs inside a task (independent subtasks in the DAG), not
  across tasks — it is not implemented yet either way.
- **Retrieval**: import extraction is file-level not per-chunk; the call graph
  matches identifier text rather than resolving symbols, so two unrelated
  `validate()` functions both surface as neighbours; 8 languages have wired
  grammars, others fall back to line-window chunking.
- **Token estimates** before a call are `chars/3.6`; real accounting uses the
  provider's reported usage, but routing and compaction decisions use the
  estimate.
- **The planner is a single call.** It does not re-plan mid-task; a failed
  subtask escalates and retries but the DAG itself is fixed after planning.
- **Ollama model sizes** assume ~4-bit quantisation to fit 16GB RAM / 8GB VRAM.
  Verify `qwen2.5-coder:14b` actually loads on your box before relying on it.
