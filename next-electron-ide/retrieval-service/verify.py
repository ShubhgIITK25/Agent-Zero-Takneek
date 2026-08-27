"""
Standalone verification for the retrieval pipeline — no Electron needed.

Run this to answer "is retrieval actually working, and what did it index?"
without going through the IDE at all. Because it imports the same modules
server.py does, a pass here means the pipeline itself is sound and any
remaining problem is in the Electron wiring (see the runbook), which is a
much smaller place to look.

Usage:
    python verify.py                      # index+query THIS project
    python verify.py /path/to/codebase    # index+query some other codebase
    python verify.py . -q "how are sessions created"     # your own query
    python verify.py --inspect <file.db>  # dump an index the IDE already built

The --inspect mode is the one to reach for when the IDE says "Index ready"
but the agent still can't find something: point it at the real .db from
app.getPath('userData')/retrieval-index/ and look at what actually got
chunked.
"""
import argparse
import os
import sys
import tempfile
import time


def _fail(message: str, hint: str = "") -> None:
    print(f"\n  FAIL  {message}")
    if hint:
        print(f"        {hint}")
    sys.exit(1)


def check_dependencies() -> dict:
    """Every dependency is checked separately, because the pipeline
    degrades per-component rather than all-or-nothing — knowing WHICH
    piece is missing tells you which capability you lost."""
    print("=" * 68)
    print("  DEPENDENCIES")
    print("=" * 68)
    status = {}

    try:
        import tree_sitter  # noqa: F401
        print("  ok    tree-sitter          (AST chunking)")
        status["tree_sitter"] = True
    except ImportError as e:
        status["tree_sitter"] = False
        _fail(f"tree-sitter missing: {e}", "pip install -r requirements.txt")

    grammars = []
    for lang, (module_name, _) in _grammar_modules().items():
        try:
            __import__(module_name)
            grammars.append(lang)
        except ImportError:
            pass
    if grammars:
        print(f"  ok    grammars             ({', '.join(grammars)})")
    else:
        _fail("no tree-sitter grammars installed", "pip install -r requirements.txt")
    status["grammars"] = grammars

    try:
        import sqlite_vec  # noqa: F401
        print("  ok    sqlite-vec           (vector search)")
        status["sqlite_vec"] = True
    except ImportError:
        print("  WARN  sqlite-vec missing   -> vector search disabled, BM25 + graph only")
        status["sqlite_vec"] = False

    try:
        import pathspec  # noqa: F401
        print("  ok    pathspec             (.gitignore handling)")
        status["pathspec"] = True
    except ImportError:
        status["pathspec"] = False
        _fail("pathspec missing", "pip install -r requirements.txt")

    try:
        import fastembed  # noqa: F401
        print("  ok    fastembed            (local embeddings + rerank)")
        status["fastembed"] = True
    except ImportError:
        print("  WARN  fastembed missing    -> BM25 + graph only, heuristic rerank")
        status["fastembed"] = False

    return status


def _grammar_modules():
    from languages import GRAMMAR_MODULES
    return GRAMMAR_MODULES


def check_grammars() -> bool:
    """Compile every language's query against its real grammar.

    This exists because a query that fails to compile does NOT crash the
    indexer — chunker.py catches it and falls back to line-window chunks,
    so those files stay searchable but lose their symbol names and
    call-graph edges. That degradation is easy to miss unless something
    checks for it explicitly. This is that something.
    """
    import importlib
    from tree_sitter import Language, Query, QueryCursor
    from languages import DEF_QUERIES

    print()
    print("=" * 68)
    print("  GRAMMAR QUERIES  (a failure here = that language loses symbols)")
    print("=" * 68)

    all_ok = True
    for lang, (module_name, accessor) in _grammar_modules().items():
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            print(f"  skip  {lang:<12} grammar package not installed")
            continue
        try:
            language = Language(getattr(module, accessor)())
            query = Query(language, DEF_QUERIES[lang])
            QueryCursor(query)
            print(f"  ok    {lang:<12} query compiles")
        except Exception as e:
            all_ok = False
            print(f"  FAIL  {lang:<12} {type(e).__name__}: {e}")
            print(f"        -> every .{lang} file will fall back to line-window chunking")

    if not all_ok:
        print()
        print("  Fix the pattern in languages.py DEF_QUERIES before trusting the index.")
        print("  Tip: node names differ between grammars — TypeScript names classes")
        print("  with 'type_identifier' where JavaScript uses 'identifier'.")

    return all_ok


def check_models() -> None:
    """The models download on first use. This forces that download now so
    a demo doesn't stall on it — and reports clearly if there's no network,
    since the pipeline stays usable without them."""
    print()
    print("=" * 68)
    print("  LOCAL MODELS  (first run downloads ~60MB, then cached)")
    print("=" * 68)
    import embeddings

    t0 = time.time()
    vec = embeddings.embed_query("does the embedder load")
    if vec is None:
        print("  WARN  embedder unavailable -> vector search will be skipped at query time")
        print("        Usually no network on first run. BM25 + graph expansion still work.")
    else:
        print(f"  ok    embedder loaded      ({len(vec)}-dim vector, {time.time() - t0:.1f}s)")

    t0 = time.time()
    scores = embeddings.rerank("test query", ["def foo(): pass", "class Bar: pass"])
    if scores is None:
        print("  WARN  reranker unavailable -> falling back to heuristic scoring")
    else:
        print(f"  ok    reranker loaded      ({time.time() - t0:.1f}s)")


def run_index(root_path: str, data_dir: str) -> str:
    import store
    import indexer

    print()
    print("=" * 68)
    print("  INDEXING")
    print("=" * 68)
    print(f"  codebase   {root_path}")
    print(f"  index dir  {data_dir}")

    codebase_id = store.codebase_id_for(root_path)
    print(f"  id         {codebase_id}   (sha256 of the absolute path, first 16 hex)")

    t0 = time.time()
    result = indexer.full_index(data_dir, root_path, codebase_id)
    elapsed = time.time() - t0

    print()
    print(f"  scanned    {result.get('files_scanned', 0)} files in {elapsed:.1f}s")
    print(f"  indexed    {result['files_indexed']} files -> {result['chunks_indexed']} chunks")

    # Two separate things, and conflating them is exactly what makes this
    # confusing to debug: sqlite-vec can be loaded (so the vector TABLE
    # exists) while the embedder failed (so nothing was ever written into
    # it). Report the row count, not just the extension flag.
    print(f"  vec table  {'loaded' if result.get('vector_search') else 'unavailable'}")
    print(f"  vectors    {_vector_count(data_dir, codebase_id)}")

    if result["chunks_indexed"] == 0:
        _fail(
            "nothing was indexed",
            "Everything was filtered out. Check .gitignore, and that the folder "
            "contains files with extensions in indexer.TEXT_EXTENSIONS.",
        )

    # Re-running must be a no-op — that's the hash check doing its job, and
    # it's what makes the file-watcher's incremental updates cheap.
    again = indexer.full_index(data_dir, root_path, codebase_id)
    if again.get("files_updated", 0) == 0:
        print("  ok         re-index touched 0 files (hash check working)")
    else:
        print(f"  WARN       re-index touched {again['files_updated']} files — expected 0")

    return codebase_id


def _vector_count(data_dir: str, codebase_id: str) -> str:
    """How many embeddings actually made it into the index. 0 with chunks
    present means the embedder failed and retrieval is running on BM25 +
    graph expansion alone — degraded, but working."""
    import store

    db = store.get_db(data_dir, codebase_id)
    if not store.vec_enabled(db):
        return "0 (no vector table)"
    try:
        n = db.execute("SELECT COUNT(*) c FROM chunks_vec").fetchone()["c"]
    except Exception:
        return "unknown"
    return f"{n} stored" if n else "0 stored  <- embedder unavailable, BM25 + graph only"


def show_breakdown(data_dir: str, codebase_id: str) -> None:
    """What actually landed in the index. This is the view that answers
    'why can't the agent find X' — if X isn't a row here, retrieval was
    never going to surface it."""
    import store

    db = store.get_db(data_dir, codebase_id)

    print()
    print("=" * 68)
    print("  WHAT GOT INDEXED")
    print("=" * 68)

    rows = db.execute(
        "SELECT kind, COUNT(*) c FROM chunks GROUP BY kind ORDER BY c DESC"
    ).fetchall()
    print("  by chunk kind:")
    for r in rows:
        marker = "   <- line-window fallback, no grammar for these" if r["kind"] == "block" else ""
        print(f"     {r['c']:>5}  {r['kind']}{marker}")

    rows = db.execute(
        "SELECT file_path, COUNT(*) c FROM chunks GROUP BY file_path ORDER BY c DESC LIMIT 8"
    ).fetchall()
    print("\n  densest files:")
    for r in rows:
        print(f"     {r['c']:>5}  {r['file_path']}")

    edges = db.execute("SELECT COUNT(*) c FROM edges").fetchone()["c"]
    resolved = db.execute(
        "SELECT COUNT(DISTINCT e.dst_symbol) c FROM edges e "
        "JOIN chunks ch ON ch.symbol = e.dst_symbol"
    ).fetchone()["c"]
    print(f"\n  call graph: {edges} edges, {resolved} distinct callee names resolve to an indexed chunk")
    print("     (unresolved names are calls into stdlib/third-party code — expected)")


def run_queries(data_dir: str, codebase_id: str, queries: list) -> None:
    import retrieval
    import store

    db = store.get_db(data_dir, codebase_id)
    vectors_live = False
    if store.vec_enabled(db):
        try:
            vectors_live = db.execute("SELECT COUNT(*) c FROM chunks_vec").fetchone()["c"] > 0
        except Exception:
            vectors_live = False

    print()
    print("=" * 68)
    print("  QUERIES")
    print("=" * 68)

    for q in queries:
        print(f'\n  "{q}"')
        t0 = time.time()
        result = retrieval.retrieve_context(data_dir, codebase_id, q, k=5)
        elapsed = (time.time() - t0) * 1000

        if not result["results"]:
            print("     (no results — try a query using words that appear in this codebase)")
            continue

        print(
            f"     {result['candidates_considered']} candidates -> top {len(result['results'])}"
            f"   |  vectors: {'on' if vectors_live else 'off'}"
            f"  rerank: {'cross-encoder' if result.get('reranked') else 'heuristic'}"
            f"  |  {elapsed:.0f}ms"
        )
        for r in result["results"]:
            print(f"     {r['score']:>7.3f}  {r['file']}:{r['line_start']}-{r['line_end']}")
            print(f"              {r['kind']} {r['symbol']}  —  {r['why_relevant']}")


def dump_vectors(db_path: str, limit: int = 5) -> None:
    """Print the actual stored embeddings.

    sqlite-vec keeps them as raw float32 blobs in the `chunks_vec` virtual
    table (4 bytes per dimension, 384 dims = 1536 bytes per chunk), so a
    generic SQLite browser shows only an unreadable BLOB. vec_to_json()
    turns one back into numbers.
    """
    import math
    import store

    if not os.path.isfile(db_path):
        _fail(f"no such file: {db_path}")

    data_dir = os.path.dirname(os.path.abspath(db_path))
    codebase_id = os.path.splitext(os.path.basename(db_path))[0]
    db = store.get_db(data_dir, codebase_id)

    if not store.vec_enabled(db):
        _fail("sqlite-vec did not load for this index — no vectors to show")

    total = db.execute("SELECT COUNT(*) c FROM chunks_vec").fetchone()["c"]
    print("=" * 68)
    print("  STORED EMBEDDINGS")
    print("=" * 68)
    print(f"  file    {db_path}")
    print(f"  table   chunks_vec   ({total} vectors)")

    if total == 0:
        print("\n  Empty. The embedder was unavailable when this index was built —")
        print("  reindex with a working model download to populate it.")
        return

    size = db.execute("SELECT length(embedding) n FROM chunks_vec LIMIT 1").fetchone()["n"]
    print(f"  layout  {size} bytes/vector = {size // 4} float32 dimensions")
    print()

    rows = db.execute(
        "SELECT v.rowid AS id, vec_to_json(v.embedding) AS vec, "
        "       c.symbol, c.kind, c.file_path, c.line_start "
        "FROM chunks_vec v JOIN chunks c ON c.id = v.rowid LIMIT ?",
        (limit,),
    ).fetchall()

    for r in rows:
        values = [float(x) for x in r["vec"].strip("[]").split(",")]
        norm = math.sqrt(sum(v * v for v in values))
        head = ", ".join(f"{v:+.4f}" for v in values[:8])
        print(f"  rowid {r['id']}  {r['kind']} {r['symbol']}")
        print(f"     {r['file_path']}:{r['line_start']}")
        print(f"     [{head}, ... {len(values) - 8} more]   |v| = {norm:.4f}")
        print()

    print("  Read them yourself with:")
    print("     SELECT rowid, vec_to_json(embedding) FROM chunks_vec;")
    print("  (needs the sqlite-vec extension loaded — a plain SQLite browser")
    print("   shows only the raw BLOB, which is why this mode exists.)")


def inspect_existing(db_path: str) -> None:
    """Point this at the .db the running IDE built, to see the real index
    rather than a fresh one built by this script."""
    import store

    if not os.path.isfile(db_path):
        _fail(f"no such file: {db_path}")

    data_dir = os.path.dirname(os.path.abspath(db_path))
    codebase_id = os.path.splitext(os.path.basename(db_path))[0]

    print("=" * 68)
    print("  INSPECTING EXISTING INDEX")
    print("=" * 68)
    print(f"  file  {db_path}")
    print(f"  id    {codebase_id}")

    db = store.get_db(data_dir, codebase_id)
    stats = store.stats(db)
    print(f"  {stats['files_indexed']} files, {stats['chunks_indexed']} chunks, "
          f"vector search {'on' if stats['vector_search'] else 'off'}")

    if stats["chunks_indexed"] == 0:
        print("\n  This index is empty — the IDE reported 'ready' without indexing anything.")
        return

    show_breakdown(data_dir, codebase_id)
    print()
    print("  Run a query against this index with:")
    print(f'     python verify.py --inspect "{db_path}" -q "your question"')


def main():
    parser = argparse.ArgumentParser(description="Verify the retrieval pipeline end to end.")
    parser.add_argument("path", nargs="?", default=None,
                        help="codebase to index (default: the project this service lives in)")
    parser.add_argument("-q", "--query", action="append", default=None,
                        help="query to run (repeatable; defaults to a few generic ones)")
    parser.add_argument("--inspect", metavar="DB",
                        help="inspect an existing .db instead of building a fresh index")
    parser.add_argument("--keep", action="store_true",
                        help="keep the temp index dir instead of using a throwaway one")
    parser.add_argument("--grammars", action="store_true",
                        help="only compile every language query and exit")
    parser.add_argument("--vectors", nargs="?", type=int, const=5, default=None,
                        metavar="N",
                        help="with --inspect: print N stored embeddings as numbers (default 5)")
    args = parser.parse_args()

    # Import from this script's own directory regardless of where it's run from.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

    if args.grammars:
        sys.exit(0 if check_grammars() else 1)

    if args.inspect:
        if args.vectors is not None:
            dump_vectors(args.inspect, args.vectors)
        elif args.query:
            import store
            data_dir = os.path.dirname(os.path.abspath(args.inspect))
            codebase_id = os.path.splitext(os.path.basename(args.inspect))[0]
            run_queries(data_dir, codebase_id, args.query)
        else:
            inspect_existing(args.inspect)
        return

    check_dependencies()
    check_grammars()
    check_models()

    root_path = os.path.abspath(args.path or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    if not os.path.isdir(root_path):
        _fail(f"not a directory: {root_path}")

    import shutil
    import store

    if args.keep:
        data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".verify-index")
        codebase_id = run_index(root_path, data_dir)
        show_breakdown(data_dir, codebase_id)
        run_queries(data_dir, codebase_id, args.query or _default_queries())
        store.evict_all()
        print(f"\n  index kept at {data_dir}")
    else:
        # NOT tempfile.TemporaryDirectory as a context manager: store.py
        # caches an open SQLite connection per codebase, and Windows refuses
        # to delete a file that's still open — the cleanup raises
        # PermissionError (WinError 32) after a completely successful run.
        # Close the connections first, then delete, tolerating leftovers.
        data_dir = tempfile.mkdtemp(prefix="nexide-verify-")
        try:
            codebase_id = run_index(root_path, data_dir)
            show_breakdown(data_dir, codebase_id)
            run_queries(data_dir, codebase_id, args.query or _default_queries())
        finally:
            store.evict_all()
            shutil.rmtree(data_dir, ignore_errors=True)

    print()
    print("=" * 68)
    print("  PIPELINE OK")
    print("=" * 68)
    print("  Retrieval itself works. If the IDE still can't search, the problem is")
    print("  in the Electron wiring, not here — check the npm run dev console for")
    print("  [retrieval] and [retrieval-service] lines.")


def _default_queries():
    return [
        "where are files read from disk",
        "how does the agent decide to call a tool",
        "error handling",
    ]


if __name__ == "__main__":
    main()
