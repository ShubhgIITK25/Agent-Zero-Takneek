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

## AI chat & agent settings

**View → Toggle AI Chat** (`Cmd/Ctrl+L`, or the AI Chat button in the status
bar) opens a chat panel on the right. **Agent → Agent Settings…**
(`Cmd/Ctrl+,`, or the Settings button) opens a key/value editor for API keys
and other environment variables (e.g. `OPENROUTER_API_KEY`, `GROQ_API_KEY`,
`OLLAMA_HOST`) — saved to a JSON file in Electron's per-user app-data
directory (`app.getPath('userData')/agent-settings.json`), outside the repo,
so it's never accidentally committed.

**The orchestration is real; only the model call is a stub.** Sending a
chat message drives an actual multi-step agent loop (`src/lib/agent.ts`,
`AgentSession.sendMessage`):

1. It calls `callLLM()` (`src/lib/llm.ts`) with the running conversation and
   the tool schemas from `src/lib/tools.ts` (`retrieve_context`, `open_file`,
   `read_file`, `list_dir`, `write_file`, `delete_path`, `run_command`). The
   system prompt steers the model to reach for `retrieve_context` first —
   it returns a handful of relevant snippets, not whole files, which
   matters because the PS's scoring formula weights cost 2x harder than
   time.
2. If the model asks to use a tool, `write_file` / `delete_path` /
   `run_command` — anything side-effecting — is held for a human
   Approve/Reject click in the chat panel before it runs (per the PS's "any
   side-effect action needs human approval" requirement); the retrieval and
   read-only tools run immediately.
3. The tool's result is appended to the conversation and the loop calls the
   model again — up to `MAX_STEPS` (8) rounds, or until it stops early
   because the same tool call repeated 3x in a row (a minimal version of
   "detect stuck/looping tasks").
4. `/bytheway <question>` is a genuinely isolated call — fresh system+user
   messages only, no tools, no access to the running session's history —
   that never touches the main conversation.

**`src/lib/llm.ts` is wired to Google's Gemini API** (`generateContent`,
with function calling) — add a `GEMINI_API_KEY` row in Agent → Settings with
your Google AI Studio key and it's live; no other file needs to change.

⚠ **Check this before the actual submission**: the brain file's hard
constraint is every model ≤80B TOTAL params, and Google doesn't publish
Gemini's parameter count — there's no way to verify Gemini satisfies that
constraint, which risks disqualification. This wiring is real and useful
for development, but treat it as a placeholder to swap for a provider with
a published open-weight parameter count (Groq, OpenRouter, or a local
Ollama server all work) before you present. `llm.ts` has a commented-out
OpenAI-compatible implementation ready to drop in for any of those — it's
the shape most other providers actually speak, unlike Gemini's. (The
retrieval service's own models — `BAAI/bge-small-en-v1.5`,
`Xenova/ms-marco-MiniLM-L-6-v2` — are already small, local, and disclosed,
so they're not part of this risk.)

`/run <command>` still exists as a manual bypass — it skips the agent
entirely and runs directly in the terminal, useful for testing that wiring
without a model configured.

## Production build

```bash
npm run build   # next build (static export) + tsc for electron/
npm run dist    # electron-builder — produces installers in release/
```

`retrieval-service/` is copied into the packaged app as an `extraResource`
(see `package.json`'s `build.extraResources`) — the end user still needs a
Python interpreter with the deps installed (`retrieval-service/requirements.txt`)
on their machine; this scaffold doesn't bundle a Python runtime.

## What's intentionally NOT here (extend as needed)

This is a scaffold, sized to actually run rather than to be exhaustive.
Natural next additions, each fairly self-contained given the IPC pattern
already in place:

- **Multi-root workspaces / recent folders** — persist via `electron-store`.
- **Git integration** — shell out to `git` from the main process, surface
  status/diff in the sidebar.
- **Extension/plugin system, LSP** — this is where it becomes a "real" IDE;
  worth designing deliberately rather than bolting on.
- **Unsaved-changes-on-close guard**, multi-window support.

## Notes for your Takneek build

This scaffold now covers several of the PS's boxes for real, not just as
UI: the **mandatory settings screen** for API keys (Agent → Settings), a
**multi-step tool-calling loop** (`AgentSession` in `agent.ts`), tools that
actually touch the filesystem, terminal, and codebase index (`tools.ts`),
a **human approval gate** in front of every side-effecting tool call, and
a real **code retrieval pipeline** (`retrieval-service/`). All of the
LLM-facing part is provider-agnostic — plugging in a model is one file
(`llm.ts`). Here's what that does and doesn't cover against the PS's
required features, so you know exactly what's left to design:

- **Multi-agent orchestration (14%)** — `AgentSession` is ONE agent
  looping with tools, not multiple agents collaborating, disagreeing, or
  dividing work. Stuck-detection is minimal (fixed step cap + "same tool
  call 3x in a row" — no retry-with-backoff, no semantic notion of "stuck",
  no backtracking). Long-horizon/multi-session resume doesn't exist:
  `AgentSession` lives in memory only and is lost when the chat panel
  unmounts or the app closes. All real design work still to do.
- **Smart routing (5%)** — doesn't exist. `llm.ts` always calls whatever
  single endpoint/model you hardcode; there's no signal-based model/provider
  selection, no visible routing decision in the UI, no rate-limit fallback.
- **Context compaction (5%)** — doesn't exist. `AgentSession.history` grows
  unbounded every turn; nothing detects an approaching context limit or
  summarizes/trims older messages.
- **Code retrieval pipeline (12%)** — real now: AST-boundary chunking
  (tree-sitter), a keyword index (SQLite FTS5/BM25), a vector index
  (sqlite-vec), and a symbol/call graph, combined in a 3-stage
  recall→graph-expand→rerank pipeline (`retrieval-service/retrieval.py`),
  with per-project isolation enforced by `codebase_id` at the API layer.
  What's still simplified, and worth naming yourself in Q&A rather than
  letting a judge find it: import extraction is file-level not per-chunk;
  the call graph matches on identifier text, not real cross-file symbol
  resolution (no true "go to definition"); only 8 languages have a wired
  grammar (others fall back to line-window chunking); the service holds
  one connection per project it's seen since last close, with no eviction
  cap for many concurrently open projects. See `retrieval-service/README.md`
  for the full design writeup and reasoning — read it before you present,
  it's written to be defended line-by-line.
- **Manual context control (6%)** — the context checkbox is a start, not
  the feature: no clickable file/line tagging in the chat input or output,
  no per-message add/remove of individual files or code blocks.
  `/bytheway` IS properly isolated now (`runIsolatedQuery` in `agent.ts`
  bypasses `AgentSession` entirely — no shared history, no tools).
- **Human-in-the-loop review (3%)** — the approval gate covers *whether* a
  side-effecting tool call runs, which is the "Autonomous Tool Use"
  requirement (#8), not this one. #10 specifically wants real Git diffs
  with **block-by-block** accept/reject and continuation around partial
  rejection — `write_file`'s approval today is all-or-nothing on the whole
  file write, no diff view. Different feature, not yet built.
- **Observability dashboard (8%)** — doesn't exist. `AgentEvent`s
  (tool-start/tool-result/assistant-text/error) are the natural hook point
  — they already carry per-call args/results — but nothing traces, times,
  token-counts, or persists them anywhere for later drill-down.
- **AGENTS.md handling (2%)** — not read or enforced anywhere;
  `buildSystemPrompt()` in `agent.ts` is a fixed string.

If you're adapting this for the agentic-IDE project generally: `llm.ts`'s
network calls run in the renderer process by default (plain `fetch`,
simplest) — only proxy them through a main-process IPC channel if you have
a specific reason to (e.g. keeping keys out of renderer memory), since that
boundary exists in this codebase for Node/OS access (filesystem, PTY,
native dialogs), not for network calls.
