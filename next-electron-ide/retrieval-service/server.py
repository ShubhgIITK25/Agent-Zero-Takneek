"""
Local HTTP server for the retrieval service. Spawned as a child process by
Electron's main process (electron/main.ts) and talked to over
http://127.0.0.1:<port> - a separate process on purpose:

  - embeddings/tree-sitter are easiest in Python; the orchestrator/IDE
    logic is Node/TS for Electron IPC. Keep them as separate processes
    talking over localhost HTTP instead of forcing one language to do
    both jobs badly.
  - the index has to survive independently of any single agent task -
    it's built once, reused across many orchestrator runs, and updated
    incrementally by a file watcher. Coupling it to an agent task's
    lifecycle would mean rebuilding it every session.
  - it gives a clean isolation boundary: this process is the ONLY thing
    that touches the on-disk indexes, and every endpoint below requires
    codebase_id - there's no code path in this service that can answer a
    query without knowing which project it's for.

Every route is deliberately tiny; the real logic lives in indexer.py /
retrieval.py / store.py so this file stays readable as "here's the API
shape" on its own.
"""
import argparse
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import store
import indexer
import retrieval

DATA_DIR = None


def _capabilities():
    """Which parts of the pipeline this interpreter can actually run.

    All three depend on packages that are NOT on a stock python3
    (see requirements.txt). Electron spawns whatever interpreter it resolved
    and reads this back to tell the user, in the status bar, when retrieval is
    running degraded rather than letting it silently serve worse results.

    These are import-level checks on purpose - cheap, and the "deps not
    installed" case is exactly what they need to catch. They do NOT download
    or load a model (fastembed does that lazily on first real use), and they
    do not prove sqlite was built with extension-loading enabled; store.py
    still does the authoritative sqlite-vec check per connection.
    """
    caps = {"python": sys.executable}

    try:
        import fastembed  # noqa: F401

        caps["embeddings"] = True
        caps["reranker"] = True
    except Exception:
        caps["embeddings"] = False
        caps["reranker"] = False

    try:
        import sqlite_vec  # noqa: F401

        caps["sqlite_vec"] = True
    except Exception:
        caps["sqlite_vec"] = False

    try:
        import tree_sitter  # noqa: F401
        import tree_sitter_python  # noqa: F401

        caps["ast_chunking"] = True
    except Exception:
        caps["ast_chunking"] = False

    return caps


CAPABILITIES = {}  # filled in main(), served from /health
_index_locks = {}  # codebase_id -> Lock, so concurrent /index and /update on
                    # the same project don't race each other's SQLite writes
_index_jobs = {}  # codebase_id -> latest background indexing status
_index_jobs_lock = threading.Lock()
_index_cancel_events = {}  # codebase_id -> cooperative cancellation Event


def _lock_for(codebase_id: str) -> threading.Lock:
    return _index_locks.setdefault(codebase_id, threading.Lock())


def _set_index_status(codebase_id: str, **patch):
    with _index_jobs_lock:
        current = _index_jobs.setdefault(codebase_id, {})
        current.update(patch)
        return dict(current)


def _run_index(codebase_id: str, root_path: str, cancel_event: threading.Event):
    def progress(update):
        _set_index_status(codebase_id, **update)
        if cancel_event.is_set():
            raise indexer.IndexCancelled()

    try:
        with _lock_for(codebase_id):
            result = indexer.full_index(
                DATA_DIR,
                root_path,
                codebase_id,
                progress_cb=progress,
                cancel_cb=cancel_event.is_set,
            )
        _set_index_status(codebase_id, state="ready", current_file=None, **result)
    except indexer.IndexCancelled:
        _set_index_status(codebase_id, state="cancelled", current_file=None)
        print(f"[retrieval-service] indexing cancelled for {codebase_id}", flush=True)
    except Exception as exc:
        _set_index_status(codebase_id, state="error", message=str(exc))
        print(f"[retrieval-service] indexing failed for {codebase_id}: {exc}", flush=True)
    finally:
        with _index_jobs_lock:
            if _index_cancel_events.get(codebase_id) is cancel_event:
                _index_cancel_events.pop(codebase_id, None)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[retrieval-service] " + (fmt % args) + "\n")

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return {}

    def do_GET(self):
        if self.path == "/health":
            self._send_json({"status": "ok", **CAPABILITIES})
            return
        self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        try:
            body = self._read_json()

            if self.path == "/index":
                self._handle_index(body)
            elif self.path == "/index-status":
                self._handle_index_status(body)
            elif self.path == "/cancel-index":
                self._handle_cancel_index(body)
            elif self.path == "/update":
                self._handle_update(body)
            elif self.path == "/query":
                self._handle_query(body)
            elif self.path == "/file":
                self._handle_file(body)
            elif self.path == "/evict":
                self._handle_evict(body)
            else:
                self._send_json({"error": "not found"}, 404)
        except Exception as e:  # a bad request should never take the service down
            self._send_json({"error": str(e)}, 500)

    # ---- handlers ----

    def _handle_index(self, body):
        root_path = body.get("root_path")
        if not root_path:
            self._send_json({"error": "root_path is required"}, 400)
            return
        codebase_id = body.get("codebase_id") or store.codebase_id_for(root_path)
        with _index_jobs_lock:
            current = _index_jobs.get(codebase_id)
            if current and current.get("state") in ("indexing", "cancelling"):
                self._send_json({"codebase_id": codebase_id, **current})
                return
            cancel_event = threading.Event()
            _index_cancel_events[codebase_id] = cancel_event
            _index_jobs[codebase_id] = {
                "state": "indexing",
                "files_scanned": 0,
                "files_total": 0,
                "files_updated": 0,
                "chunks_updated": 0,
                "current_file": None,
            }
            initial = dict(_index_jobs[codebase_id])

        # The HTTP handler returns immediately. The worker owns the index
        # lock, parses/embeds one file at a time, and commits every file.
        threading.Thread(
            target=_run_index,
            args=(codebase_id, root_path, cancel_event),
            name=f"index-{codebase_id}",
            daemon=True,
        ).start()
        self._send_json({"codebase_id": codebase_id, **initial})

    def _handle_cancel_index(self, body):
        codebase_id = body.get("codebase_id")
        if not codebase_id:
            self._send_json({"error": "codebase_id is required"}, 400)
            return
        with _index_jobs_lock:
            status = _index_jobs.get(codebase_id)
            event = _index_cancel_events.get(codebase_id)
            if (
                not status
                or status.get("state") not in ("indexing", "cancelling")
                or event is None
            ):
                state = status.get("state", "idle") if status else "idle"
                self._send_json({"codebase_id": codebase_id, "state": state})
                return
            event.set()
            status["state"] = "cancelling"
            response = dict(status)
        self._send_json({"codebase_id": codebase_id, **response})

    def _handle_index_status(self, body):
        codebase_id = body.get("codebase_id")
        if not codebase_id:
            self._send_json({"error": "codebase_id is required"}, 400)
            return
        with _index_jobs_lock:
            status = dict(_index_jobs.get(codebase_id, {"state": "idle"}))
        self._send_json({"codebase_id": codebase_id, **status})

    def _handle_update(self, body):
        root_path = body.get("root_path")
        changed = body.get("changed_paths") or []
        if not root_path:
            self._send_json({"error": "root_path is required"}, 400)
            return
        codebase_id = body.get("codebase_id") or store.codebase_id_for(root_path)
        with _lock_for(codebase_id):
            result = indexer.update_files(DATA_DIR, root_path, codebase_id, changed)
        self._send_json({"codebase_id": codebase_id, **result})

    def _handle_query(self, body):
        codebase_id = body.get("codebase_id")
        query_text = body.get("query")
        k = int(body.get("k") or 8)
        if not codebase_id or not query_text:
            self._send_json({"error": "codebase_id and query are required"}, 400)
            return
        result = retrieval.retrieve_context(DATA_DIR, codebase_id, query_text, k)
        self._send_json(result)

    def _handle_file(self, body):
        codebase_id = body.get("codebase_id")
        root_path = body.get("root_path")
        rel_path = body.get("path")
        if not root_path or not rel_path:
            self._send_json({"error": "root_path and path are required"}, 400)
            return
        # normalize + guard against escaping the project root
        abs_root = os.path.realpath(root_path)
        abs_path = os.path.realpath(os.path.join(abs_root, rel_path))
        if os.path.commonpath([abs_root, abs_path]) != abs_root:
            self._send_json({"error": "path escapes project root"}, 400)
            return
        if not os.path.isfile(abs_path):
            self._send_json({"error": "file not found"}, 404)
            return
        with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
        line_start = body.get("line_start")
        line_end = body.get("line_end")
        if line_start and line_end:
            lo, hi = max(1, int(line_start)), min(len(lines), int(line_end))
            content = "\n".join(lines[lo - 1: hi])
        else:
            content = "\n".join(lines)
            lo, hi = 1, len(lines)
        self._send_json({"path": rel_path, "line_start": lo, "line_end": hi, "content": content})

    def _handle_evict(self, body):
        codebase_id = body.get("codebase_id")
        if codebase_id:
            store.evict(codebase_id)
        self._send_json({"evicted": codebase_id})


def main():
    global DATA_DIR, CAPABILITIES
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data-dir", type=str, required=True)
    args = parser.parse_args()

    DATA_DIR = args.data_dir
    os.makedirs(DATA_DIR, exist_ok=True)

    CAPABILITIES = _capabilities()
    missing = [
        name
        for name, key in (
            ("vector-search", "sqlite_vec"),
            ("embeddings", "embeddings"),
            ("AST chunking", "ast_chunking"),
        )
        if not CAPABILITIES.get(key)
    ]
    if missing:
        print(
            f"[retrieval-service] DEGRADED - missing: {', '.join(missing)}. "
            f"Interpreter: {sys.executable}. "
            f"Install requirements.txt into it for the full pipeline.",
            flush=True,
        )
    else:
        print("[retrieval-service] full pipeline available", flush=True)

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[retrieval-service] listening on 127.0.0.1:{args.port}, data_dir={DATA_DIR}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        store.evict_all()


if __name__ == "__main__":
    main()
