# server for retrieval service, which is a separate process from the main Electron IDE.
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

    These are import-level checks on purpose — cheap, and the "deps not
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


def _lock_for(codebase_id: str) -> threading.Lock:
    return _index_locks.setdefault(codebase_id, threading.Lock())


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
        print(codebase_id)
        with _lock_for(codebase_id):
            result = indexer.full_index(DATA_DIR, root_path, codebase_id)
        self._send_json({"codebase_id": codebase_id, **result})

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
            f"[retrieval-service] DEGRADED — missing: {', '.join(missing)}. "
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
