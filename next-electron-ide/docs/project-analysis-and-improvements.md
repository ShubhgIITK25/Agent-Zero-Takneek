# NEXide (`next-electron-ide`) - End-to-End Project Analysis & Improvement Plan

> **Scope:** Full review of the Electron shell, TypeScript orchestrator, Next.js/React renderer, Python retrieval service, test suite, and build/packaging configuration.
> **Date:** 2026-08-31
> **Method:** Line-by-line review of all source files across the four layers.

---

## 1. Executive Summary

NEXide is a desktop AI-coding IDE built as **Next.js (renderer) + Electron (shell) + a Node stdio JSON-RPC orchestrator + a Python retrieval microservice**. The codebase is in notably good shape for its stage: the renderer is sandboxed correctly, comments explain *why* rather than *what*, degraded modes are honest and observable, and the retrieval recovery design is tested invariant-by-invariant.

The biggest risks cluster into four themes:

1. **Trust-boundary enforcement (security).** The Electron sandbox is set up correctly, but the main process will read, overwrite, and **recursively force-delete any path the renderer names**, echo unescaped paths into a live PTY shell, and forward renderer-controlled URLs carrying real API keys. A single renderer XSS becomes full machine compromise.
2. **Concurrency & cancellation correctness.** Cancellation misses parallel in-flight model calls (critical), a shared SQLite connection is used concurrently by `/query` and `/index` threads, and two event reducers mutate previous React state (breaks under StrictMode).
3. **Structural scaling limits.** `orchestrator.ts` is an 1,869-line god-class, `page.tsx` owns all IDE state, `main.ts` is 1,127 lines, and there is a fully duplicated dead `DiffReview.tsx` plus a 2,810-line single CSS file.
4. **Engineering process.** 19 test suites exist but **nothing runs them automatically** (no CI), the retrieval test failures are masked by `|| echo '(skipped…)'`, and Python dependencies are unbounded with no lock.

**Top 5 actions by risk-per-effort:**

| # | Action | Effort | Removes |
|---|--------|--------|---------|
| 1 | Add a workspace "jail" helper to all `fs:*` IPC handlers + replace `rm -rf` with `shell.trashItem` | Small | Highest-severity security exposure |
| 2 | Fix cancellation with `Set<AbortController>` in the orchestrator | ~5 lines | Critical cancellation bug |
| 3 | Make the two React event reducers truly immutable (`trace.ts`, `ChatPanel.tsx`) | Small | Dev-mode state corruption |
| 4 | Add GitHub Actions CI running `npm test` + retrieval tests (and fix the masking `||` + `python3` issues) | Small | Untested regressions |
| 5 | Add shared-secret auth to the retrieval HTTP service + per-codebase DB locks | Medium | Local file-read primitive, SQLite races |

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Electron Main (electron/main.ts, 1,127 lines)                    │
│  • IPC handlers (fs, terminal/pty, settings, tasks, retrieval)   │
│  • Spawns: orchestrator child (stdio JSON-RPC)                   │
│            Python retrieval service (localhost HTTP)             │
│  • Model health probes, settings persistence                     │
└──────┬──────────────────────────┬───────────────────────────────┘
       │ contextBridge (typed,    │ HTTP (localhost, no auth)
       │ sandboxed renderer)      ▼
┌──────┴───────────────┐   ┌─────────────────────────────────────┐
│ Next.js Renderer     │   │ Python Retrieval Service             │
│ (src/app, src/comp)  │   │ (stdlib http.server + SQLite/FTS5)   │
│ Monaco, xterm, chat  │   │ chunker → embeddings → vector search │
└──────────────────────┘   └─────────────────────────────────────┘
       │ stdio JSON-RPC
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ Orchestrator (orchestrator/, ~14 modules)                        │
│ TaskRunner: scheduler, re-planner, retry ladder, verifier,       │
│ approval gate, diff application, backtracking, budget, router    │
└─────────────────────────────────────────────────────────────────┘
```

**Strengths of the architecture (keep these):**
- Correct Electron security baseline: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, typed `contextBridge` API only.
- Single reducer (`src/lib/trace.ts`) shared by **live and history** trace rendering - eliminates live-vs-replay divergence.
- `review-buffer.ts` reconstructs the approved buffer from the orchestrator's hunks ("what you see is what lands") - a single source of truth for the approval contract.
- Retrieval service isolates per-codebase SQLite files **by construction**, reports capabilities honestly, and its recovery/escalation path is pinned by dedicated tests.
- Dependency-injected `python-interpreter.ts` - pure, unit-testable resolution logic with an actionable `isFallback` warning.

---

## 3. Findings - Electron Shell (`electron/`)

### 3.1 Security

#### S1 - [HIGH] Unscoped filesystem IPC: full read/write/delete of the machine from the renderer
`electron/main.ts:625–694`

Every `fs:*` handler accepts an arbitrary absolute path with **zero validation against the open workspace**:

```ts
ipcMain.handle("fs:delete", async (_evt, targetPath: string) => {
  await fs.rm(targetPath, { recursive: true, force: true });
  return true;
});
```

An IDE renderer renders untrusted content by design (opened files, agent output, markdown chat). One XSS in the renderer yields arbitrary read (`~/.ssh`, `~/.aws`), arbitrary write, and **arbitrary recursive-force deletion with no confirmation**.

**Fix:** enforce a workspace jail in one shared helper and apply it to *all* `fs:*` handlers:

```ts
function assertInsideWorkspace(p: string): string {
  if (!openFolderPath) throw new Error("No folder open");
  const resolved = path.resolve(p);
  if (!resolved.startsWith(path.resolve(openFolderPath) + path.sep))
    throw new Error("Path outside workspace");
  return resolved;
}
```

For `fs:delete`, additionally refuse to delete the workspace root and prefer `shell.trashItem` over `rm -rf`.

#### S2 - [MEDIUM] Path traversal via `taskId` in `orchestrator:readTaskEvents`
`electron/main.ts:949–957` - `taskId` is interpolated into a path unvalidated; `"../../.."` escapes the tasks directory. The codebase already knows the right pattern - `orchestrator:revertLatest` (line 897) validates `if (!/^[A-Za-z0-9._-]+$/.test(taskId))`. **Fix:** extract that check into `assertValidTaskId()` and use it in `startTask`, `resumeTask`, `cancelTask`, and `readTaskEvents`.

#### S3 - [MEDIUM] Renderer-controlled base URLs + plaintext keys = exfiltration vector
`electron/main.ts:1067–1083` → `electron/model-health.ts:119, 142, 201`. The renderer supplies API keys *and* the env vars used to build request URLs; a compromised renderer can point a "model" at an attacker server with the user's real keys attached. Additionally, the **Gemini key is sent in the URL query string** (`model-health.ts:203`), which leaks into proxy/server logs. **Fix:** main-process URL allowlist per provider; move the Gemini key to the `x-goog-api-key` header.

#### S4 - [MEDIUM] Shell-quoting injection in `terminal:changeDir`
`electron/main.ts:817–831` - the renderer-supplied path is interpolated into a shell command for the live PTY. A path like `foo"; calc; echo "` executes arbitrary commands. **Fix:** spawn `cd` without a shell where possible, or strictly escape per platform.

#### S5 - [MEDIUM] No `will-navigate` / `setWindowOpenHandler` guards
`electron/main.ts:24–50` - navigation and window-open are unrestricted. **Fix:** deny both (open external links via `shell.openExternal` after an allowlist check).

#### S6 - [LOW] No sender validation on IPC handlers; non-critical surface hardening
Validate `event.senderFrame` / `event.sender` against the known webContents in handlers that perform destructive or privileged work.

### 3.2 Correctness & robustness

| # | Finding | Where | Severity |
|---|---------|-------|----------|
| R1 | `AgentSettings` type drift between preload and main (`maxParallelSubtasks` missing in preload type) | preload.ts:9–14 vs main.ts:975 | Medium |
| R2 | Retrieval service: no restart watchdog (orchestrator child has a good one - mirror it) | main.ts:183–187 | Medium |
| R3 | 30s command-timeout timers in the bridge are never cleared | orchestrator-bridge.ts:150 | Low |
| R4 | `mainWindow!` non-null assertions | main.ts:499, 603, 612 | Low |
| R5 | Unvalidated numeric settings (negative/zero budgets accepted) | main.ts:1000–1007 | Low |
| R6 | Identical if/else branches + dead `isDev` variable | orchestrator-bridge.ts:198–203 | Low |

### 3.3 Structure

- **[MEDIUM]** `main.ts` is 1,127 lines mixing IPC routing, PTY management, service supervision, and settings. Split into `ipc/fs.ts`, `ipc/terminal.ts`, `ipc/tasks.ts`, `retrieval-supervisor.ts`, `settings.ts` with a thin composition root.
- **[LOW]** Triplicated `degraded` computation (`main.ts:295–299, 227, 346–350`) - extract `retrievalDegraded()`.
- **[LOW]** `readAgentSettings()` duplicates `settings:get`'s body exactly - one should call the other.
- **[LOW]** Stale comments describing past architecture (e.g. "frontend-only for now" at main.ts:834–840 while orchestrator IPC sits right below) actively misdirect readers.
- **[LOW]** Hardcoded tuning constants (`MAX_RESTARTS`, timeouts, budget defaults) are individually documented (good) but not centralized - consider one `config.ts`.

**Done well:** the orchestrator watchdog (`MAX_RESTARTS` with backoff), the actionable retrieval-degradation warnings naming the README section, `python-interpreter.ts` as a pure module, `strict: true` TypeScript with deliberate `rootDir` isolation documenting the main/renderer boundary.

## 4. Findings - TypeScript Orchestrator (`orchestrator/`)

### 4.1 Architecture & modularity

#### O1 - [HIGH] `orchestrator.ts` is a god-file; `TaskRunner` is a god-class
`orchestrator/orchestrator.ts:100–1869` - one class (~1,670 lines) owns the scheduler, re-planner, retry ladder, verifier loop, approval gate + diff transaction, backtracking/rollback engine, budget gating, routing-signal construction, event emission, and summarization - plus **20+ mutable fields** whose invariants only make sense in combination (e.g. `restoreBacktrackPoint` at 1073–1142 touches five pieces of state and the event log at once). Every safety property the comments promise ("a re-plan must not disarm a sibling's rollback") is enforced implicitly by field arrangement in one class.

**Fix - split along the seams that already exist in the comments:**
- `Scheduler` (lines 760–955: the readyNow/conflict/parallel loop, `blockDependents`, deadlock resolution)
- `ApprovalGate` (342–502 - already a de-facto module)
- `Backtracker` (1038–1142 + `changedBySubtask`)
- `SubtaskExecutor` (1543–1725) and `Verifier` (1735–1804)
- `Replanner` (1344–1474)

`TaskRunner` remains a thin composition root owning `Budget`, `Router`, `TaskStore`; `dispatch()` (509–727) is the natural inner bus.

### 4.2 Correctness & concurrency

| # | Finding | Where | Severity |
|---|---------|-------|----------|
| O2 | **[CRITICAL]** Single `activeAbortController`: cancelling a task misses parallel in-flight model calls - they keep streaming (and spending budget) after cancel | orchestrator.ts:107, 592, 242 | **Critical** |
| O3 | Approval round-trip has no timeout - a lost/dropped approval request blocks the task forever | orchestrator.ts:378, 496 | High |
| O4 | Backtrack capture can restore file state across subtask boundaries while a sibling is `verifying` | orchestrator.ts:1050, 805 | Medium |
| O5 | Concurrent budget overspend is mitigated (reserve) but not fully prevented | orchestrator.ts:534, 845 | Medium |
| O6 | Tools are not abortable; `execFileSync` in `diff.ts` blocks the event loop | tools.ts:96–112; diff.ts:83 | Medium |
| O7 | Non-`ProviderError` exceptions wrapped as retryable - e.g. a local bug retried as if it were rate limiting | orchestrator.ts:627 | Medium |
| O8 | Subtask state transitions are implicit - ~15 scattered mutation sites, no transition guard | orchestrator.ts (various) | Medium |
| O9 | Snapshot write not fsynced; `renameSync` EPERM (Windows file lock) fails the whole task | store.ts:135–140 | Medium |
| O10 | Sync checkpoint writes on the hot path | orchestrator.ts:283; store.ts:136 | Low |
| O11 | Full event-log re-read per revert; unbounded log growth | store.ts:178 | Low |
| O12 | `seq` reconstruction counts torn (partially written) lines | store.ts:90 | Low |
| O13 | Double `task_cancelled` emission | orchestrator.ts:245, 960 | Low |
| O14 | Module-global node counter - breaks determinism across tasks | orchestrator.ts:97 | Low |
| O15 | Hardcoded 6h daily-quota backoff; overlaps with health-tracker state | router.ts:189 | Low |
| O16 | `uncaughtException` handler can orphan an in-progress on-disk write | index.ts:236; orchestrator.ts:450–462 | Low |

**Fix for O2 (~5 lines):** replace the single controller with `const aborts = new Set<AbortController>()`; register on dispatch, remove in `finally`, and abort all in `cancel()`.

**Fix for O3:** wrap the approval promise with a timeout that auto-denies (or re-prompts) after N minutes, and surface a `approval_timeout` event.

### 4.3 Type safety & data boundaries

- **[HIGH]** `extractJson(): any` (`agents.ts:42`) anchors all agent output parsing in `any` - malformed model output surfaces as runtime crashes far from the cause. **Fix:** validate against narrow runtime guards (or zod-style validators) at the parse boundary; type the result.
- **[HIGH]** Unchecked casts on persisted/wire data (`store.ts:144,244`; `providers.ts:303,403,563`; `protocol.ts:253`) and **no snapshot schema version** - old task snapshots will crash after format changes instead of being migrated or discarded.
- **[LOW]** `parseLine` re-implemented in `index.ts:217` duplicating `protocol.ts:249`.

### 4.4 Duplication

- **[MEDIUM]** The ~40-line tool-execution loop is written twice (implementer at 1639–1711, verifier at 1772–1801) **with real drift already**: verifier hardcodes `ms: 0` (an observable data-quality bug) and truncates to 6,000 vs 8,000 chars, and skips the repeat-guard. Extract `runToolCalls(calls, opts)` used by both.
- **[MEDIUM]** Routing-signals construction duplicated at 6 call sites - extract a builder.
- **[MEDIUM]** Retry-ladder constants (delays, ceilings) duplicated between implementer and verifier paths - centralize.

### 4.5 Testability

- **[MEDIUM]** `callModel` is imported directly (`orchestrator.ts:42`), not injectable - unit-testing the retry/verify/replan state machine requires module interception. **Fix:** `constructor(..., private callModelFn: typeof callModel = callModel)` - one line, unlocks the whole state machine with scripted fake models.
- **[MEDIUM]** The pipeline (retry ladder, replan bounds, scheduler, backtracking) has **no direct tests**; only edges (protocol handshake, resume, git tool) are covered, and only against `dist/` builds. Add table-driven tests for `applyAcceptedBlocks`, `parsePlan`/`parseVerdict` failure paths, `Budget` boundaries, router scoring determinism, and a state-machine test asserting every subtask reaches a terminal status.

**Done well:** the retry ladder and escalation design are carefully reasoned in comments; the approval gate + diff transaction is self-contained and well-documented; the reserve-based budget mitigation; bounded replan counts.

## 5. Findings - Frontend (`src/`)

### 5.1 Correctness

#### F1 - [HIGH] `applyEvent` mutates previous state's nested objects despite claiming purity
`src/lib/trace.ts:269–445` - the doc comment says *"Pure - returns a new view, never mutates the input."* The function shallow-copies arrays (`v.nodes = [...view.nodes]`) but then finds a **shared node object** and mutates it in place (`n.thoughts = [...n.thoughts, e.text]`, `n.promptTokens = ...`). Under React StrictMode / concurrent re-rendering, `setTrace((prev) => applyEvent(...))` (`page.tsx:55`) can **append the same thought/tool call twice**, and any consumer holding an older `TraceView` (e.g. `historyTrace` snapshots in Dashboard) is silently corrupted.

**Fix:** copy the node before mutating:
```ts
v.nodes = v.nodes.map((x) => x.nodeId === e.nodeId
  ? { ...x, promptTokens: e.promptTokens ?? 0, finishedAt: e.ts, /* … */ }
  : x);
```

#### F2 - [HIGH] Same mutation bug in `ChatPanel`'s routing-row collapsing
`src/components/ChatPanel.tsx:186–204` - `let nextBubbles = [...currentBubbles]` copies the array but `last.count += 1` mutates the **object shared with the previous state**, so counts can double-increment in dev. **Fix:** `nextBubbles.map((b, i) => i === last && matches ? { ...b, count: b.count + 1 } : b)`.

#### F3 - [HIGH] No error boundary anywhere in the renderer
Zero `ErrorBoundary`/`componentDidCatch` hits across `src/`. A renderer with three Monaco instances, xterm, and long-lived IPC streams has a worst-case failure mode: one bad event or a Monaco view-zone throw **unmounts the whole IDE shell to a white screen**, losing unsaved editor state held in refs. Also `ChatPanel.tsx:241` reads `e.request.requestId` unguarded for all approval kinds.

**Fix:** wrap the four "islands" (editor pane, chat, dashboard, terminal) in small error boundaries (~30–50 lines total) that render a recoverable fallback instead of killing the window.

### 5.2 Structure & duplication

| # | Finding | Where | Severity |
|---|---------|-------|----------|
| F4 | **Dead duplicated component**: `DiffReview.tsx` is fully superseded by `DiffReviewPane.tsx` - two diff types with the same name drift apart | DiffReview.tsx vs DiffReviewPane.tsx | Medium |
| F5 | `page.tsx` (17KB) owns all IDE state (workspace, tabs, autosave, trace, IPC subscriptions) - hard to extend/test | page.tsx | Medium |
| F6 | Duplicated workspace-file-listing logic between page and FileTree | page.tsx / FileTree.tsx | Medium |
| F7 | `globals.css` is a single 2,810-line file mixing tokens, per-component styles, and one-offs | src/app/globals.css | Medium |
| F8 | Repeated modal/popover behavior (escape-to-close, outside-click) re-implemented per component | SettingsPanel, ChatPanel, Dashboard | Low |

**Fix for F5:** extract `useWorkspaceFiles`, `useElectronShellEvents`, and a `WorkspaceProvider` context. **Fix for F4:** delete `DiffReview.tsx` and unify the diff type in `lib/review-buffer.ts`.

### 5.3 Performance

- **[MEDIUM]** `FileTree` re-renders the whole tree on any workspace change - memoize nodes / virtualize for large repos.
- **[MEDIUM]** The full `TraceView` is rebuilt on every streaming event; the 500-node cap bounds memory but per-event `O(nodes)` rebuilds are visible with long tasks. Consider keyed incremental updates.
- **[LOW]** Chat bubble list re-renders in full per event - `memo` per bubble type once reducers are immutable (F1/F2 are prerequisites).

### 5.4 Accessibility

- **[MEDIUM]** `Tabs` is click-only (no `role="tablist"`, no arrow-key navigation); `FileTree` lacks ARIA tree semantics and keyboard traversal.
- **[MEDIUM]** Monaco inline-diff zone buttons (accept/reject) are not keyboard reachable.
- **[LOW]** Modals/popovers don't trap focus or restore it on close.

**Done well (keep these patterns):** the `refreshWorkspaceRef` stable-subscription pattern (page.tsx:287–294) applied consistently; thorough `useEffect` cleanup everywhere (timers, rAF, ResizeObserver, xterm dispose, pty kill); optimistic UI ordering with documented rationale (`ChatPanel.decide` sends the approval *before* collapsing the widget); SSR boundaries via `dynamic(..., { ssr: false })` with explanatory comments; xterm `safeFit` + double-rAF retry ladder; scroll-respects-user logic in chat; the IDE-level `pendingDiff` decision architecture (one place to answer a blocking approval); small a11y touches (`aria-expanded`, `role="status"`).

## 6. Findings - Retrieval Service (`retrieval-service/`) & Build/Test Infrastructure

### 6.1 Python retrieval service

#### P1 - [HIGH] Unauthenticated localhost API with caller-controlled `root_path` = local arbitrary-file-read
`server.py:138–147, 170–196` - `/file` guards against escaping `root_path` (good), but `root_path` itself is supplied by the caller and never validated. Any local process (or a drive-by web page POSTing to `http://127.0.0.1:<port>/file` - browsers can send cross-origin POSTs even without reading the response) can read any file on the machine, index arbitrary directories, or `/evict` indexes. The docstring's "clean isolation boundary" is per-*codebase*, not per-*caller* - localhost binding is not authentication.

**Fix:** Electron generates a one-time shared secret at spawn (passed via `--token` argv or stdin); every handler checks an `Authorization` header. Optionally validate `root_path` against an allowlist registered at spawn time.

#### P2 - [HIGH] Shared SQLite connection used concurrently by `/query` and `/index` threads
`store.py:104` (`check_same_thread=False`) + `server.py:235` (`ThreadingHTTPServer`). Writes are serialized by `_index_locks`, but **`_handle_query` takes no lock** and runs on the same cached connection concurrently with an in-flight `/index` or `/update` - risking `sqlite3.ProgrammingError` or interleaved transactions. This is the *normal* path (the watcher fires `/update` while the agent calls `/query`), not an edge case.

**Fix:** open a short-lived connection per request (the schema is already configured for WAL concurrent read/write across connections at `store.py:106`), or guard *all* uses of a cached connection with the per-codebase lock.

#### P3 - [MEDIUM] Heavy work runs inside request handlers; first-use model download blocks a request
`indexer.py:95–122`, `embeddings.py:27–38` - full indexing runs synchronously in the handler thread, and the first `/index`/`/query` on a fresh machine downloads the ONNX weights (~30–100 MB) **inside the request**, with no timeout and no progress (the existing `progress_cb` is never wired). Users see a frozen "indexing" state on large repos. **Fix:** return `202` with a job id and index in a worker thread; at minimum pre-warm the embedder at startup and expose progress.

#### P4 - [MEDIUM] Error handling hides root causes
`do_POST` catch-all returns 500 without stack traces (unactionable when debugging from the Electron side) - log the traceback server-side and include a request id. Malformed JSON in `/update` silently no-ops instead of returning 400.

#### P5 - [MEDIUM] Indexer ignores `.nexideignore`; two divergent ignore systems
`orchestrator/ignore.ts` and the Python indexer apply different ignore rules, so what the agent sees and what gets indexed can disagree. **Fix:** single source of truth - pass the resolved ignore set from Electron to the indexer, or port one implementation.

#### P6 - [HIGH] `requirements.txt` uses unbounded version ranges, no lock file
A future transitive break silently changes the shipped service. **Fix:** pin exact versions (or add a lock via `pip-tools`/`uv`) and regenerate per release.

### 6.2 Tests & CI

| # | Finding | Severity |
|---|---------|----------|
| T1 | **No CI at all** - 19 test suites exist, nothing runs them automatically on push/PR | High |
| T2 | `test:retrieval` masks failures (`|| echo '(skipped…)'`) and invokes `python3`, which does not exist on Windows | High |
| T3 | Hand-rolled test harness � - 19 files - no shared runner, no filtering, no coverage reporting | Medium |
| T4 | Coverage gaps: server/store/chunker untested; orchestrator pipeline untested (see 4.5); renderer has zero tests | Medium |
| T5 | Calibration e2e (`verify.py`) never runs automatically | Medium |

**Fixes:** GitHub Actions running `npm test` + `pytest` on all three OSes; remove the `||` fallback and resolve Python the same way `electron/python-interpreter.ts` does; adopt Node's built-in test runner or Vitest incrementally; add a CI job that runs `verify.py` on a fixture repo.

### 6.3 Build & packaging

| # | Finding | Severity |
|---|---------|----------|
| B1 | `nodemon` is in **production** `dependencies` (ships in the installer) | Medium |
| B2 | Renderer deps (Monaco, xterm, React) bundled raw into the installer via `files` globs - installer larger and slower than needed | Medium |
| B3 | No hot-reload/watch for the Electron main process during dev - every main-process edit needs a full restart | Low |
| B4 | No release workflow/tagging; `npm ci` not used/documented | Low |
| B5 | `_to_delete/` stray folder and stray logs (`dev.log`, `build.log`, `launch.log`, `tsconfig.tsbuildinfo`) not gitignored | Low |

**Fixes:** move `nodemon` to devDependencies; audit `files` globs; add `tsc --watch -p electron/tsconfig.json` + `electron .` under `concurrently` (or use `tsx`) for dev; extend `.gitignore`.

**Done well (keep):** the recovery/escalation design (`retrieval.py:456–528`) with bounded retries and an inspectable `attempts` trail, pinned invariant-by-invariant in `test_recovery.py`; degraded-mode honesty everywhere (capability reporting, authoritative per-connection sqlite-vec check, explicit failure logging); index-format versioning that self-verifies the schema (`store.py:122–160`); dependency-free `identifiers.py` solving camelCase↔natural-language recall; comments documenting rejected alternatives *with reasons*; `tests/parallel.js` measuring real concurrency with a live gauge.

---

## 7. Cross-Cutting Themes

1. **The trust boundary is declared but not enforced.** The renderer is sandboxed, but every privileged handler (fs, delete, terminal `cd`, model health, retrieval HTTP) trusts renderer input completely. One shared validation layer in the main process (workspace jail + id regex + provider URL allowlist + service auth token) closes most of the practical attack surface.
2. **Immutability and cancellation are aspirational.** Both the React reducers (F1/F2) and the orchestrator cancellation (O2) *look* correct but fail under exactly the conditions they were designed for (re-renders, parallel dispatch). These are cheap, high-value fixes.
3. **Comments are the best documentation - and a liability.** Decision-site comments are excellent, but several describe superseded architectures (dead `DiffReview.tsx`, "frontend-only" notes, drifted preload types). A dead-code/accuracy pass protects future readers.
4. **Great test culture, missing test infrastructure.** The existing suites are thoughtful and invariant-focused; they just don't run automatically, and the most invariant-dense code (the orchestrator pipeline) is unreachable without one injection point (`callModel`).

## 8. Prioritized Roadmap

### P0 - This week (correctness & security, small diffs)
1. Workspace jail for `fs:*` handlers; `shell.trashItem` for deletes (S1).
2. `Set<AbortController>` cancellation in the orchestrator (O2).
3. Immutability fixes in `trace.ts` and `ChatPanel.tsx` (F1, F2).
4. Shared `assertValidTaskId()` helper (S2).
5. Fix `test:retrieval` masking + `python3` on Windows (T2); add GitHub Actions CI (T1).

### P1 - Next 2–4 weeks (robustness)
6. Approval-request timeout (O3); retrieval service auth token (P1); per-request/per-locked DB connections (P2).
7. Error boundaries around the four renderer islands (F3).
8. Delete dead `DiffReview.tsx`; unify diff types in `lib/review-buffer.ts` (F4).
9. Validate model output at the parse boundary; add snapshot schema versioning (§4.3).
10. Extract shared `runToolCalls`; pin `requirements.txt` (P6).

### P2 - Next quarter (structure & scale)
11. Split `TaskRunner` into Scheduler / ApprovalGate / Backtracker / Executor / Verifier (O1); split `main.ts` into IPC modules (§3.3).
12. Make `callModel` injectable; add orchestrator pipeline unit tests (§4.5).
13. Extract `useWorkspaceFiles` / `useElectronShellEvents` / WorkspaceProvider; memoize FileTree; split `globals.css` (§5.2–5.3).
14. Async indexing jobs with progress (P3); unify ignore systems (P5).
15. Accessibility pass (Tabs/FileTree ARIA + keyboard, focus trapping, §5.4); installer size audit (B1–B2).

---

## 9. Full Findings Index (by severity)

| Severity | ID | One-line summary | Where |
|----------|----|------------------|-------|
| Critical | O2 | Cancel misses parallel in-flight model calls | orchestrator.ts:107 |
| High | S1 | Unscoped fs IPC incl. recursive-force delete | main.ts:625–694 |
| High | O1 | God-class TaskRunner (~1,670 lines) | orchestrator.ts:100–1869 |
| High | O3 | Approval round-trip has no timeout | orchestrator.ts:378 |
| High | §4.3 | `extractJson(): any`; unchecked wire/persist casts; no snapshot versioning | agents.ts:42; store/providers/protocol |
| High | F1 | `applyEvent` mutates previous state (StrictMode double-apply) | trace.ts:269–445 |
| High | F2 | Routing-row collapsing mutates previous state | ChatPanel.tsx:186–204 |
| High | F3 | No error boundaries - white-screen failure mode | src/ |
| High | P1 | Unauthenticated retrieval API + caller-controlled `root_path` | server.py:138–196 |
| High | P2 | SQLite connection shared across threads without locking | store.py:104 |
| High | P6 | Unpinned Python deps, no lock | requirements.txt |
| High | T1 | No CI for 19 test suites | - |
| High | T2 | Retrieval test failures masked; `python3` nonexistent on Windows | package.json |
| Medium | S2 | `taskId` path traversal | main.ts:949 |
| Medium | S3 | Renderer-controlled URLs with plaintext keys; Gemini key in query string | model-health.ts:203 |
| Medium | S4 | Shell-quoting injection in terminal `changeDir` | main.ts:817 |
| Medium | S5 | No will-navigate / window-open guards | main.ts:24–50 |
| Medium | R1/R2 | Preload type drift; no retrieval watchdog | preload.ts / main.ts:183 |
| Medium | O4–O9 | Backtrack cross-subtask restore; budget reserve gap; non-abortable tools; snapshot EPERM; implicit state transitions | orchestrator.ts / store.ts / tools.ts |
| Medium | §4.4 | Duplicated tool loop (drifted `ms: 0`); 6� -  routing-signals construction | orchestrator.ts |
| Medium | O-test | `callModel` not injectable; pipeline untested | orchestrator.ts:42 |
| Medium | F4–F7 | Dead `DiffReview.tsx`; monolithic `page.tsx`; 2,810-line CSS | src/ |
| Medium | F-perf | FileTree full re-render; per-event trace rebuild | FileTree / trace |
| Medium | F-a11y | Tabs/FileTree ARIA; unreachable diff-zone buttons; no focus trap | src/components |
| Medium | P3–P5 | Blocking index/model download; 500-handler opacity; divergent ignore systems | retrieval-service |
| Medium | T3–T5 | Hand-rolled harness; coverage gaps; calibration never runs | tests/ |
| Medium | B1–B2 | `nodemon` in prod deps; bloated installer `files` globs | package.json |
| Low | ~20 items | Sender validation, timer leaks, dead branches, stale comments, a11y, gitignore, constants centralization, etc. | §3–§6 |

---

*Generated by a full end-to-end review of the repository. Line numbers refer to the working tree at the time of review and may shift as files change.*






