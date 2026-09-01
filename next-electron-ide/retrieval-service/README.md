# Retrieval service

The code retrieval pipeline for CodéNawabs' agent: a real AST-based codebase
index (not naive keyword or vector search alone), with per-project
isolation. Runs as a separate local Python process, spawned by Electron's
main process (`electron/main.ts`) and talked to over
`http://127.0.0.1:<port>`.

## Setup

```bash
cd retrieval-service
python3 -m venv .venv          # or however you prefer to isolate it
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

That's it  -  `npm run dev` spawns `server.py` automatically once the
dependencies are installed (see `startRetrievalService()` in
`electron/main.ts`). Interpreter resolution
(`electron/python-interpreter.ts`) tries, in order: `$CODENAWABS_PYTHON`, then
this `.venv`, then an activated `$VIRTUAL_ENV`, then `python3` (`python`
on Windows) on `PATH`. So a `.venv` created at `retrieval-service/.venv`
is picked up with no configuration; set `CODENAWABS_PYTHON` only if your
interpreter lives elsewhere.

If the service fails to start, the status bar shows "retrieval
unavailable" instead of the app crashing. If it starts but on a Python
without the dependencies, it runs **degraded** (BM25 over line-window
chunks, no vector search or reranking)  -  the startup log says `DEGRADED  - 
missing: …` and the status bar reads `keyword-only`, and `GET /health`
reports `embeddings` / `sqlite_vec` / `ast_chunking` booleans plus the
`python` path in use. Check the Electron devtools console for the
`[retrieval-service]` / `[retrieval]` log lines.

**First run downloads two small ONNX models** (the embedder and reranker,
~35MB and ~25MB respectively) from Hugging Face via `fastembed`, then
caches them locally. If you're demoing somewhere offline, run an indexed
query once beforehand to warm that cache. If the download fails (no
network), the service does not crash  -  it logs a warning and falls back
to BM25 keyword search + graph expansion only, with a heuristic reranker
instead of the cross-encoder. See `embeddings.py`.

## Why this design (for the presentation / Q&A)

**Separate process, not inline in the orchestrator.** Embeddings and
tree-sitter parsing are most mature in Python; the orchestrator/IDE side
is Node/TS for Electron IPC reasons. Splitting them means the index
survives independently of any single agent task  -  built once per project,
reused across every orchestrator run, updated incrementally  -  instead of
being rebuilt every session. It also gives a real isolation boundary: this
process is the *only* thing that touches on-disk indexes, and every
endpoint requires `codebase_id`.

**AST-boundary chunking, not fixed-size windows.** Every chunk is exactly
one function, method, or class (`chunker.py`, via `tree-sitter` + the
official per-language grammar packages)  -  never an arbitrary N-token
slice that might start mid-function. A chunk carries its own signature,
docstring, and body together, plus metadata (parent class, imports,
`calls`) extracted from the same parse. Languages without a wired-up
grammar fall back to overlapping line-windows rather than being excluded
from search entirely (`fallback_chunks`).

**Three retrieval signals in one file, not a vector-DB-only approach.**
`store.py` puts a keyword index (SQLite FTS5, real BM25 ranking), a vector
index (the `sqlite-vec` extension), and a symbol/call graph (plain tables)
into one SQLite file per project. This was chosen over a standalone vector
DB (LanceDB/Chroma/Qdrant) deliberately: it's one dependency instead of a
server/service to run and trust, isolation between projects is just "which
file is open" instead of "which collection am I trusting not to leak,"
and BM25 alone already catches what pure embedding similarity is bad at
(exact identifiers, error strings, config keys).

**Why not vector search alone: the graph-expansion step.** Two functions
can be nowhere near each other in embedding space but be one call away in
actual execution flow  -  e.g. `create_session` calling `get_user_by_id` in
a completely different file, with no words in common. Stage 2 of
`retrieval.py` pulls in the 1-hop call/import neighbors of the strongest
vector hits specifically to catch that case  -  this is the concrete answer
to "semantic understanding, not just keyword/vector match."

**Two-tier `retrieve_context`/`open_file`, not "always send the whole
file."** The scoring formula weights cost 2x harder than time
(`w_C=0.65` vs `w_T=0.35`). Sending full files into a small model's
context by default is the single fastest way to blow the $0.5 hard
ceiling. `retrieve_context` returns a handful of relevant snippets;
`open_file` is a distinct, deliberate follow-up step the model has to
choose to take.

**Per-project isolation, enforced at the API layer, not by convention.**
Every endpoint (`server.py`) requires `codebase_id`; there is no code path
that answers a query without one. `codebase_id` is a hash of the absolute
project root path, computed in `electron/main.ts`  -  the same project
always maps to the same id, and switching projects triggers `/evict` to
drop the previous project's cached DB handle from the service's memory,
so nothing lingers that a later-opened project could accidentally see.

**Graceful degradation everywhere, not a hard dependency chain.** Every
stage that can fail independently, does so without taking the rest down:
unsupported language -> line-window fallback chunking; embedder unavailable
(no network, first-run download failed) -> BM25 + graph only, vector
search silently skipped; reranker unavailable -> heuristic scoring
(exact-symbol-match + recency) instead of the cross-encoder;
`sqlite-vec` extension fails to load on some platform -> vector search
disabled for that project, everything else still works. None of these are
hypothetical  -  they were exercised while building this (this sandbox's
network is restricted, so the embedder/reranker fallback path is what
actually ran during development and testing).

## Architecture

```
electron/main.ts (spawns + talks HTTP)
        |
        v
server.py  --------------------------  one HTTP endpoint per operation
        |
        +-- indexer.py   -- walk (respects .gitignore) + hash-check + orchestrate chunk/embed/store
        +-- chunker.py   -- tree-sitter AST-boundary chunking, per-language queries (languages.py)
        +-- embeddings.py -- fastembed: local embed + rerank, lazy-loaded, graceful fallback
        +-- store.py     -- one SQLite file per codebase_id: chunks, FTS5 (BM25), sqlite-vec, call graph
        +-- retrieval.py -- Stage 1 recall (BM25 + vector) -> Stage 2 graph expansion -> Stage 3 rerank
```

## API

All requests are `POST` with a JSON body (except `/health`).

| Endpoint   | Body                                                          | Use                                        |
|------------|----------------------------------------------------------------|---------------------------------------------|
| `/health`  | (GET, no body)                                                 | readiness + `{embeddings, sqlite_vec, ast_chunking, reranker, python}` capability flags |
| `/index`   | `{root_path, codebase_id?}`                                     | full index build (first open of a project)   |
| `/update`  | `{root_path, codebase_id, changed_paths}`                       | incremental reindex (file watcher-driven)    |
| `/query`   | `{codebase_id, query, k?}`                                      | `retrieve_context` tool backing              |
| `/file`    | `{root_path, path, line_start?, line_end?}`                     | `open_file` tool backing                     |
| `/evict`   | `{codebase_id}`                                                 | drop a project's cached DB handle            |

## Known limitations (be ready to name these  -  they're deliberate scope
cuts, not oversights)

- Grammars wired up: Python, JS/JSX, TS/TSX, Go, Rust, Java, C, C++.
  Anything else falls back to line-window chunking.
- Per-chunk import extraction is file-level, not scope-precise (every
  chunk in a file gets that file's full import list).
- No cross-file symbol resolution beyond name matching  -  the call graph
  matches on identifier text, so two different `validate()` functions in
  unrelated files would both show up as "1-hop neighbors" of a caller
  named `validate`. Good enough for the recall step (it's feeding a
  reranker/heuristic anyway), not a real language-server-grade resolver.
- The service holds one open SQLite connection per codebase it's seen
  since last `/evict`  -  fine for a single-user desktop IDE, would need an
  actual LRU cap for anything with many concurrently open projects.
