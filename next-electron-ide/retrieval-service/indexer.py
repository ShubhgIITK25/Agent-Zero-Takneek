"""
Phase 1: indexing. Walks a project root, respects .gitignore, chunks each
file at AST boundaries, embeds the chunks, and writes everything into that
project's SQLite file.

Runs in two modes:
  - full_index(): the first time a codebase is opened
  - update_files(): incremental — called by Electron's file watcher with
    just the paths that changed, so a single edited file doesn't trigger
    a full re-walk. Every path is still hash-checked against what's
    stored, so a no-op save (open + immediately save, or a watcher firing
    twice) costs nothing beyond a hash compare.
"""
import os
import time

import pathspec

import store
from chunker import chunk_file
import embeddings

TEXT_EXTENSIONS = {
    ".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".rs", ".java",
    ".c", ".h", ".cpp", ".hpp", ".cc", ".json", ".md", ".yml", ".yaml", ".toml",
    ".css", ".html", ".sh", ".rb", ".php", ".sql",
}
MAX_FILE_BYTES = 1_500_000  # skip anything absurdly large (generated bundles etc.)


def _load_gitignore(root: str):
    patterns = [
        "node_modules/", ".git/", "dist/", "build/", "__pycache__/",
        ".venv/", "venv/", ".next/", "electron-dist/", "*.lock",
    ]
    gi_path = os.path.join(root, ".gitignore")
    if os.path.isfile(gi_path):
        try:
            with open(gi_path, "r", encoding="utf-8", errors="replace") as f:
                patterns += f.read().splitlines()
        except OSError:
            pass
    return pathspec.PathSpec.from_lines("gitwildmatch", patterns)


def _iter_source_files(root: str, spec: pathspec.PathSpec):
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        # prune ignored directories in-place so os.walk doesn't descend into them
        def _dir_rel(d):
            return (d if rel_dir == "." else f"{rel_dir}/{d}") + "/"
        dirnames[:] = [d for d in dirnames if not spec.match_file(_dir_rel(d))]
        for name in filenames:
            ext = os.path.splitext(name)[1]
            if ext not in TEXT_EXTENSIONS:
                continue
            rel_path = os.path.join(rel_dir, name) if rel_dir != "." else name
            rel_path = rel_path.replace(os.sep, "/")
            if spec.match_file(rel_path):
                continue
            yield os.path.join(dirpath, name), rel_path


def _read_text(abs_path: str):
    try:
        if os.path.getsize(abs_path) > MAX_FILE_BYTES:
            return None
        with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def _index_one_file(db, abs_path: str, rel_path: str):
    text = _read_text(abs_path)
    if text is None:
        return 0
    if store.get_file_hash(db, rel_path) == store.file_hash(text):
        return 0  # unchanged, skip

    chunks = chunk_file(rel_path, text)
    if not chunks:
        return 0

    texts_to_embed = [f"{c['symbol']}\n{c.get('docstring', '')}\n{c['code'][:800]}" for c in chunks]
    vectors = embeddings.embed_texts(texts_to_embed)  # None if embedder unavailable
    if vectors is None:
        vectors = [None] * len(chunks)

    mtime = os.path.getmtime(abs_path)
    store.insert_file_chunks(db, rel_path, text, chunks, vectors, mtime)
    return len(chunks)


def full_index(data_dir: str, root_path: str, codebase_id: str, progress_cb=None):
    db = store.get_db(data_dir, codebase_id)
    spec = _load_gitignore(root_path)

    known = {r["path"] for r in db.execute("SELECT path FROM files")}
    seen = set()
    files_touched = 0
    chunks_indexed = 0
    files_scanned = 0

    for abs_path, rel_path in _iter_source_files(root_path, spec):
        seen.add(rel_path)
        n = _index_one_file(db, abs_path, rel_path)
        files_scanned += 1
        if n:
            files_touched += 1
            chunks_indexed += n
        if progress_cb and files_scanned % 25 == 0:
            progress_cb(files_scanned)

    # files that were indexed before but no longer exist / no longer match
    for stale in known - seen:
        store.delete_file(db, stale)
        db.commit()

    db.commit()
    return {**store.stats(db), "files_scanned": files_scanned, "files_updated": files_touched,
            "chunks_updated": chunks_indexed}


def update_files(data_dir: str, root_path: str, codebase_id: str, changed_rel_paths: list):
    db = store.get_db(data_dir, codebase_id)
    spec = _load_gitignore(root_path)
    files_touched = 0
    chunks_indexed = 0

    for rel_path in changed_rel_paths:
        rel_path = rel_path.replace(os.sep, "/")
        abs_path = os.path.join(root_path, rel_path)
        if spec.match_file(rel_path):
            continue
        if not os.path.exists(abs_path):
            store.delete_file(db, rel_path)
            continue
        ext = os.path.splitext(rel_path)[1]
        if ext not in TEXT_EXTENSIONS:
            continue
        n = _index_one_file(db, abs_path, rel_path)
        if n:
            files_touched += 1
            chunks_indexed += n

    db.commit()
    return {**store.stats(db), "files_updated": files_touched, "chunks_updated": chunks_indexed}
