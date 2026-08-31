# creates sqlite table and stoes everything in it. also provides search functions (bm25, vector, graph) and some utility functions for managing the index.
import os
import re
import sqlite3
import hashlib

import identifiers

INDEX_FORMAT_VERSION = 2

_connections = {} 
_vec_enabled = {} 

VEC_DIM = 384  # must match embeddings.EMBED_MODEL's output dimension

_SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    mtime REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    parent TEXT,
    docstring TEXT,
    code TEXT NOT NULL,
    imports TEXT,
    mtime REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_symbol ON chunks(symbol);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED, symbol, docstring, code,
    -- Every identifier in `symbol`/`code`, pre-split into sub-words. FTS5's
    -- tokeniser treats `computeUserBalance` as one atomic token, so a natural
    -- query ("user balance") can never match it via BM25 without this. See
    -- identifiers.py.
    tokens
);

CREATE TABLE IF NOT EXISTS edges (
    src_chunk_id INTEGER NOT NULL,
    dst_symbol TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'calls'
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_chunk_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_symbol);
"""


def codebase_id_for(root_path: str) -> str:
    return hashlib.sha256(root_path.encode("utf-8")).hexdigest()[:16]


def _db_path(data_dir: str, codebase_id: str) -> str:
    os.makedirs(data_dir, exist_ok=True)
    return os.path.join(data_dir, f"{codebase_id}.db")


def _fts_has_tokens(db: sqlite3.Connection) -> bool:
    """True if chunks_fts carries the v2 `tokens` column. A missing table counts
    as v2 because _SCHEMA is about to create it in the current format."""
    try:
        cols = [r[1] for r in db.execute("PRAGMA table_info(chunks_fts)")]
    except sqlite3.OperationalError:
        return True
    return not cols or "tokens" in cols


def get_db(data_dir: str, codebase_id: str, vec_enabled_hint=True) -> sqlite3.Connection:
    if codebase_id in _connections:
        return _connections[codebase_id]

    path = _db_path(data_dir, codebase_id)
    fresh = not os.path.exists(path)
    db = sqlite3.connect(path, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")

    vec_ok = False
    if vec_enabled_hint:
        try:
            import sqlite_vec
            db.enable_load_extension(True)
            sqlite_vec.load(db)
            db.enable_load_extension(False)
            db.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[{VEC_DIM}])"
            )
            vec_ok = True
        except Exception as e:
            print(f"[store] sqlite-vec unavailable for {codebase_id}, vector search disabled: {e}")

    # An index written by an older format is not migrated in place — the
    # cheapest correct thing is to drop its tables and let the next index pass
    # rebuild from source, which is fast and cannot leave a half-migrated file.
    #
    # This runs AFTER the sqlite-vec block above on purpose: `chunks_vec` is a
    # vec0 VIRTUAL TABLE, and DROP TABLE on it fails with "no such module: vec0"
    # unless the extension is loaded first.
    if not fresh:
        have = db.execute("PRAGMA user_version").fetchone()[0]
        # `have == 0` is the *most* stale an index can be: it predates
        # versioning entirely. Guarding this with `if have and ...` read 0 as
        # "no version recorded, leave it alone", which is exactly backwards and
        # let a v1 file through to be written by v2 code.
        stale = have < INDEX_FORMAT_VERSION
        if stale:
            print(f"[store] index for {codebase_id} is format v{have}, rebuilding at v{INDEX_FORMAT_VERSION}")
        # The stamp below is unconditional, so any index opened by a build that
        # had that bug is now labelled v2 while still carrying the v1 schema.
        # Its version can never be trusted again, so confirm the format against
        # the one column that actually distinguishes v1 from v2.
        elif not _fts_has_tokens(db):
            print(f"[store] index for {codebase_id} claims v{have} but has a v1 FTS table, rebuilding")
            stale = True
        if stale:
            for tbl in ("chunks_fts", "chunks_vec", "edges", "chunks", "files"):
                try:
                    db.execute(f"DROP TABLE IF EXISTS {tbl}")
                except sqlite3.OperationalError as e:
                    # e.g. vec0 unavailable in this process — the table is then
                    # unusable anyway and _SCHEMA will not recreate it.
                    print(f"[store] could not drop {tbl} during rebuild: {e}")
            # _SCHEMA below recreates the plain tables, but chunks_vec is a
            # virtual table created in the sqlite-vec block above, which has
            # already run — so it has to be put back explicitly here.
            if vec_ok:
                db.execute(
                    f"CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[{VEC_DIM}])"
                )
            db.commit()

    db.executescript(_SCHEMA)
    db.execute(f"PRAGMA user_version = {INDEX_FORMAT_VERSION}")
    db.commit()
    _vec_enabled[id(db)] = vec_ok
    _connections[codebase_id] = db
    return db


def evict(codebase_id: str):
    db = _connections.pop(codebase_id, None)
    if db is not None:
        try:
            db.close()
        except Exception:
            pass


def evict_all():
    for cid in list(_connections.keys()):
        evict(cid)


def vec_enabled(db) -> bool:
    return _vec_enabled.get(id(db), False)


def file_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def get_file_hash(db, path: str):
    row = db.execute("SELECT hash FROM files WHERE path = ?", (path,)).fetchone()
    return row["hash"] if row else None


def delete_file(db, path: str):
    ids = [r["id"] for r in db.execute("SELECT id FROM chunks WHERE file_path = ?", (path,))]
    if ids:
        qmarks = ",".join("?" * len(ids))
        db.execute(f"DELETE FROM chunks WHERE id IN ({qmarks})", ids)
        db.execute(f"DELETE FROM chunks_fts WHERE chunk_id IN ({qmarks})", ids)
        db.execute(f"DELETE FROM edges WHERE src_chunk_id IN ({qmarks})", ids)
        if vec_enabled(db):
            db.execute(f"DELETE FROM chunks_vec WHERE rowid IN ({qmarks})", ids)
    db.execute("DELETE FROM files WHERE path = ?", (path,))


_WORD_RE = re.compile(r"[A-Za-z0-9_]+")


def sanitize_fts_query(text: str) -> str:
    words = _WORD_RE.findall(text)
    expanded = identifiers.expand_text(text)
    terms = list(dict.fromkeys(words + expanded.split()))[:20]
    if not terms:
        return '""'
    return " OR ".join(f'"{w}"' for w in terms)


def insert_file_chunks(db, path: str, text: str, chunks: list, embeddings, mtime: float):
    delete_file(db, path)
    db.execute(
        "INSERT INTO files(path, hash, mtime) VALUES (?, ?, ?)",
        (path, file_hash(text), mtime),
    )

    chunk_ids = []
    for i, ch in enumerate(chunks):
        cur = db.execute(
            "INSERT INTO chunks(file_path, symbol, kind, line_start, line_end, parent, docstring, code, imports, mtime) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                ch["file_path"], ch["symbol"], ch["kind"], ch["line_start"], ch["line_end"],
                ch.get("parent"), ch.get("docstring", ""), ch["code"],
                ",".join(ch.get("imports") or []), mtime,
            ),
        )
        cid = cur.lastrowid
        chunk_ids.append(cid)

        db.execute(
            "INSERT INTO chunks_fts(chunk_id, symbol, docstring, code, tokens) VALUES (?,?,?,?,?)",
            (
                cid, ch["symbol"], ch.get("docstring", ""), ch["code"],
                identifiers.expand_text(ch["symbol"] + " " + ch["code"]),
            ),
        )

        for callee in ch.get("calls") or []:
            db.execute(
                "INSERT INTO edges(src_chunk_id, dst_symbol, kind) VALUES (?,?,?)",
                (cid, callee, "calls"),
            )

    if embeddings and vec_enabled(db):
        import sqlite_vec
        for cid, vec in zip(chunk_ids, embeddings):
            if vec is None:
                continue
            db.execute(
                "INSERT OR REPLACE INTO chunks_vec(rowid, embedding) VALUES (?, ?)",
                (cid, sqlite_vec.serialize_float32(vec)),
            )

    db.commit()
    return chunk_ids


def get_chunk(db, chunk_id: int):
    row = db.execute("SELECT * FROM chunks WHERE id = ?", (chunk_id,)).fetchone()
    return dict(row) if row else None


def bm25_search(db, query_text: str, limit=25):
    q = sanitize_fts_query(query_text)
    try:
        rows = db.execute(
            "SELECT chunk_id, bm25(chunks_fts) AS score FROM chunks_fts "
            "WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?",
            (q, limit),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    # bm25() is a cost (lower = better match) — normalize to "higher is better"
    return [(r["chunk_id"], -r["score"]) for r in rows]


def vector_search(db, query_vec, limit=25):
    if query_vec is None or not vec_enabled(db):
        return []
    import sqlite_vec
    rows = db.execute(
        "SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance",
        (sqlite_vec.serialize_float32(query_vec), limit),
    ).fetchall()
    # cosine/L2 distance — lower = better; convert to a similarity-ish score
    return [(r["rowid"], 1.0 / (1.0 + r["distance"])) for r in rows]


def graph_neighbors(db, chunk_ids: list, limit_per_chunk=6):
    neighbor_ids = set()
    if not chunk_ids:
        return neighbor_ids
    qmarks = ",".join("?" * len(chunk_ids))

    callee_symbols = {
        r["dst_symbol"]
        for r in db.execute(f"SELECT DISTINCT dst_symbol FROM edges WHERE src_chunk_id IN ({qmarks})", chunk_ids)
    }
    if callee_symbols:
        sym_qmarks = ",".join("?" * len(callee_symbols))
        for r in db.execute(f"SELECT id FROM chunks WHERE symbol IN ({sym_qmarks}) LIMIT ?",
                             (*callee_symbols, limit_per_chunk * max(1, len(chunk_ids)))):
            neighbor_ids.add(r["id"])

    own_symbols = {
        r["symbol"] for r in db.execute(f"SELECT symbol FROM chunks WHERE id IN ({qmarks})", chunk_ids)
    }
    if own_symbols:
        sym_qmarks = ",".join("?" * len(own_symbols))
        for r in db.execute(
            f"SELECT DISTINCT src_chunk_id FROM edges WHERE dst_symbol IN ({sym_qmarks}) LIMIT ?",
            (*own_symbols, limit_per_chunk * max(1, len(chunk_ids))),
        ):
            neighbor_ids.add(r["src_chunk_id"])

    return neighbor_ids - set(chunk_ids)


def stats(db):
    files = db.execute("SELECT COUNT(*) c FROM files").fetchone()["c"]
    chunks = db.execute("SELECT COUNT(*) c FROM chunks").fetchone()["c"]
    return {"files_indexed": files, "chunks_indexed": chunks, "vector_search": bool(vec_enabled(db))}
