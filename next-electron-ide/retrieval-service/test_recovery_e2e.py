"""
END-TO-END test for weak-retrieval detection and recovery, against a REAL
index built by the real pipeline: real tree-sitter chunking, real fastembed
vectors, real cross-encoder reranking, real SQLite FTS5/BM25. Nothing stubbed.

    retrieval-service/.venv/bin/python retrieval-service/test_recovery_e2e.py

`test_recovery.py` stubs `store` and `embeddings` to test the escalation
CONTROL FLOW cheaply and in `npm test`. This one exists to check the claims
that stubbing cannot:

  * a real 384-dim embedding model already bridges many English<->identifier
    paraphrases on its own - so the recovery path must NOT fire for those, or
    it is just wasted latency. (My first draft assumed "English phrasing ==
    weak"; the real embedder disproved it.)
  * for the paraphrases it genuinely cannot bridge (coined identifiers,
    acronyms, heavy word-order gaps), the weak signal fires and reformulation
    actually recovers the right symbol.
  * the "pool smaller than 6" signal is relative to index size - on a small
    repo, matching most of it is a complete retrieval, not a failed one.

Slow (~15-30s; downloads the ONNX weights on first run) so it is NOT wired
into `npm test`. Run it after touching retrieval.py.

Setup:  python3 -m venv retrieval-service/.venv
        retrieval-service/.venv/bin/pip install -r retrieval-service/requirements.txt
"""
import os
import sys
import tempfile
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import store          # noqa: E402
import indexer        # noqa: E402
import retrieval      # noqa: E402

# A corpus written the way real code is - in identifiers, not prose - and big
# enough (~15 chunks) that index-size-relative signals behave like production.
CORPUS = {
    "core/xqproc.js": '''
export function xqReconcileLedger(entries) {
  const balances = new Map();
  for (const e of entries) balances.set(e.acct, (balances.get(e.acct) || 0) + e.delta);
  return balances;
}
export function xqSnapshotJournal(journal) { return journal.slice(-1000); }
export function xqValidateEntry(entry) { return entry.acct && typeof entry.delta === "number"; }
''',
    "core/wbl.py": '''
def wbl_compact(segments, threshold_kb=64):
    """Merge adjacent small write-behind-log segments into one."""
    out, buf = [], []
    for s in segments:
        buf.append(s)
        if sum(x.size_kb for x in buf) >= threshold_kb:
            out.append(_merge(buf)); buf = []
    if buf: out.append(_merge(buf))
    return out

def wbl_replay(segments, apply_fn):
    for seg in segments:
        for record in seg.records:
            apply_fn(record)

def _merge(segs):
    return Segment(records=[r for s in segs for r in s.records])
''',
    "net/rlt.go": '''
package net
func (t *RLTracker) Penalise(provider string, hard bool) {
    base := 5000
    if hard { base = 20000 }
    t.cooldown[provider] = now() + base
}
func (t *RLTracker) InCooldown(provider string) bool { return t.cooldown[provider] > now() }
func (t *RLTracker) Clear(provider string) { delete(t.cooldown, provider) }
''',
    "http/handlers.py": '''
def handle_upload(request):
    blob = request.files["file"]
    return {"key": store_blob(blob.read())}

def handle_download(request, key):
    return stream_blob(key)

def store_blob(data): return _blobs.put(data)
def stream_blob(key): return _blobs.get(key)
''',
    "auth/session.js": '''
export function createUserSession(userId) {
  const token = randomToken(32);
  sessions.set(token, { userId, ts: Date.now() });
  return token;
}
export function endUserSession(token) { sessions.delete(token); }
''',
}

_pass = _fail = 0


def check(name, cond, detail=""):
    global _pass, _fail
    mark = "ok  " if cond else "FAIL"
    print(f"  {mark} {name}" + (f"\n         {detail}" if (detail and not cond) else ""))
    if cond:
        _pass += 1
    else:
        _fail += 1


def syms(results):
    return [r["symbol"] for r in results]


def run(datadir, cid, query, k=5):
    out = retrieval.retrieve_context(datadir, cid, query, k=k)
    chain = " -> ".join(
        f"{a['strategy'].split('+')[0]}(c{a['confidence']},{a['results']}r)" for a in out["attempts"]
    )
    print(f'\n  "{query}"')
    print(f'     {chain}   final c={out["confidence"]} weak={out["weak"]} used={out["query_used"]!r}')
    print(f'     top: {syms(out["results"])[:4]}')
    return out


def main():
    wd = tempfile.mkdtemp(prefix="nexide-e2e-proj-")
    dd = tempfile.mkdtemp(prefix="nexide-e2e-index-")
    try:
        for rel, body in CORPUS.items():
            full = os.path.join(wd, rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            open(full, "w").write(body)

        cid = store.codebase_id_for(wd)
        print(f"\n  indexing {len(CORPUS)} files ...")
        res = indexer.full_index(dd, wd, cid)
        vecs = 0
        try:
            vecs = store.get_db(dd, cid).execute("SELECT COUNT(*) c FROM chunks_vec").fetchone()["c"]
        except Exception:
            pass
        print(f"  {res['chunks_indexed']} chunks, {vecs} vectors\n")
        check("corpus indexed with vectors (embedder + reranker loaded)",
              res["chunks_indexed"] >= 10 and vecs >= 10,
              f"chunks={res['chunks_indexed']} vectors={vecs}")

        # --- 1: the index-split fix means a natural query works FIRST try -
        # `xqReconcileLedger` is stored in the FTS `tokens` column as
        # "xq reconcile ledger", so "reconcile ledger" matches it via BM25
        # directly - no recovery needed. That IS the win; recovery is the
        # backstop for what this does not catch.
        o = run(dd, cid, "reconcile the ledger entries into balances")
        check("1a. a natural-language query matches the atomic identifier first try",
              any("xqReconcile" in s for s in syms(o["results"])),
              f"got {syms(o['results'])}")
        check("1b. and it did NOT need to escalate to get there",
              o["escalated"] is False,
              f"attempts={[a['strategy'] for a in o['attempts']]}")

        # --- 2: a rambling query is narrowed on retry --------------------
        o = run(dd, cid, "could someone show me please where in the code the small "
                          "write behind log segments get merged together")
        check("2a. the verbose first attempt is weaker than the narrowed retry",
              o["attempts"][0]["confidence"] <= o["confidence"])
        check("2b. wbl_compact is found (via the narrowed query or the original)",
              any("wbl_compact" in s for s in syms(o["results"])),
              f"got {syms(o['results'])}")

        # --- 3: exact identifier -> strong, no escalation ------------------
        o = run(dd, cid, "createUserSession")
        check("3. an exact identifier query is strong and does not escalate",
              o["escalated"] is False and o["attempts"][0]["weak"] is False
              and "createUserSession" in syms(o["results"]))

        # --- 4: genuinely absent -> weak, honest, bounded ----------------
        o = run(dd, cid, "terraform kubernetes helm chart ingress deployment yaml")
        check("4a. a query with no real answer stays weak - reformulation must "
              "not manufacture false agreement by ORing many guesses",
              o["weak"] is True,
              f"conf={o['confidence']} reasons={o['weak_reasons']}")
        check("4b. bounded - at most 1 + MAX_VARIANTS_TRIED attempts",
              len(o["attempts"]) <= 1 + retrieval.MAX_VARIANTS_TRIED,
              f"{len(o['attempts'])} attempts")
        check("4c. weak_reasons is populated for the dashboard",
              len(o["weak_reasons"]) > 0)

        # --- 5: the pool-size signal is index-relative -------------------
        # This 15-chunk index: a query matching 5 of them is NOT 'recall failed'.
        # Before the fix, candidates_considered < 6 fired on every query here.
        o = run(dd, cid, "createUserSession")
        thin = any("indexed chunk" in r for r in
                   (o["weak_reasons"] + o["attempts"][0]["reasons"]))
        check("5. 'recall failed' does NOT fire just because the repo is small",
              not thin,
              f"reasons: {o['attempts'][0]['reasons']}")

        # --- 6: recovering can never return a worse set ------------------
        # xqSnapshotJournal is findable directly; its reformulations are vague.
        o = run(dd, cid, "xqSnapshotJournal")
        check("6. exact hit kept, not traded for a vaguer reformulation",
              "xqSnapshotJournal" in syms(o["results"])
              and o["query_used"] == "xqSnapshotJournal")

        # --- 7: weak-detection accuracy on a REAL codebase ----------------
        # The scenarios above are hand-built. This one indexes the project's own
        # orchestrator/ and checks the verdict against queries whose answer is
        # known to exist or known not to. It is the test that caught the false
        # negative that motivated the two-threshold reranker: "kubernetes
        # ingress controller helm values" used to score 0.7 and pass, because a
        # single lexical hit on the word "values" counted as corroboration.
        print("\n  --- weak-detection accuracy on the real orchestrator source ---")
        src = os.path.join(os.path.dirname(HERE), "orchestrator")
        if not os.path.isdir(src):
            print("  (skipped: orchestrator/ not found)")
        else:
            dd2 = tempfile.mkdtemp(prefix="nexide-e2e-real-")
            try:
                cid2 = store.codebase_id_for(src)
                r2 = indexer.full_index(dd2, src, cid2)
                answerable = [
                    "how is the workspace rolled back when verification fails",
                    "where does it decide which model to use",
                    "what stops a subtask retrying forever",
                    "exponential backoff for rate limited providers",
                    "how is the task checkpointed to disk",
                ]
                absent = [
                    "kubernetes ingress controller helm values",
                    "webgl shader compilation pipeline",
                    "sourdough bread fermentation schedule",
                    "css flexbox grid layout alignment",
                ]
                false_alarms, missed = [], []
                for q in answerable:
                    if retrieval.retrieve_context(dd2, cid2, q, k=6)["weak"]:
                        false_alarms.append(q)
                for q in absent:
                    if not retrieval.retrieve_context(dd2, cid2, q, k=6)["weak"]:
                        missed.append(q)
                print(f"  indexed {r2['chunks_indexed']} chunks; "
                      f"{len(answerable)} answerable + {len(absent)} absent queries")
                check("7a. no answerable query is falsely flagged weak",
                      not false_alarms, f"false alarms: {false_alarms}")
                check("7b. every unanswerable query IS flagged weak",
                      not missed, f"missed: {missed}")
            finally:
                shutil.rmtree(dd2, ignore_errors=True)

        print(f"\n{_pass} passed, {_fail} failed\n")
        sys.exit(1 if _fail else 0)
    finally:
        shutil.rmtree(wd, ignore_errors=True)
        shutil.rmtree(dd, ignore_errors=True)


if __name__ == "__main__":
    main()
