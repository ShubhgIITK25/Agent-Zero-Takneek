"""
Tests for weak-retrieval detection and recovery (retrieval.py stages 4).

    python3 retrieval-service/test_recovery.py

`store` and `embeddings` are stubbed, so this runs with no tree-sitter, no
fastembed, no model download, and no index on disk. That is deliberate: the
thing under test is the ESCALATION CONTROL FLOW - detect a weak first attempt,
reformulate, widen, keep whichever attempt was actually better - and stubbing
the search primitives is what makes that flow testable at all. The primitives
themselves (BM25, vector, graph) are unchanged by this feature and are covered
by verify.py against a real index.
"""
import sys
import types

# --- stub the heavy dependencies before importing retrieval -----------------
_store = types.ModuleType("store")
_embeddings = types.ModuleType("embeddings")

# Programmed per-test: query string -> (bm25 ids, vector ids)
RESPONSES = {}
CHUNKS = {}
GRAPH = {}
QUERIES_SEEN = []


def _bm25_search(db, query_text, limit=25):
    QUERIES_SEEN.append(query_text)
    ids = RESPONSES.get(query_text, ([], []))[0]
    return [(i, 1.0) for i in ids[:limit]]


def _vector_search(db, query_vec, limit=25):
    ids = RESPONSES.get(query_vec, ([], []))[1]
    return [(i, 1.0) for i in ids[:limit]]


_store.get_db = lambda data_dir, cid: object()
# Big enough that the pool-size signal only fires on a genuinely thin match,
# mirroring a real index rather than the 4-chunk toy the e2e test uses.
_store.stats = lambda db: {"chunks_indexed": 500}
_store.bm25_search = _bm25_search
_store.vector_search = _vector_search
_store.graph_neighbors = lambda db, ids: [n for i in ids for n in GRAPH.get(i, [])]
_store.get_chunk = lambda db, cid: CHUNKS.get(cid)
_store.vec_enabled = lambda db: True
# `embed_query` returns the query text itself so the vector stub can key off it.
_embeddings.embed_query = lambda q: q
_embeddings.rerank = lambda q, docs: None  # reranker unavailable -> heuristic path

sys.modules["store"] = _store
sys.modules["embeddings"] = _embeddings

import retrieval as R  # noqa: E402

_pass = _fail = 0


def t(name, fn):
    global _pass, _fail
    try:
        fn()
        print(f"  ok   {name}")
        _pass += 1
    except AssertionError as e:
        print(f"  FAIL {name}\n         {e}")
        _fail += 1


def chunk(cid, symbol, path="a.py"):
    return {
        "file_path": path, "symbol": symbol, "kind": "function",
        "line_start": 1, "line_end": 5, "code": f"def {symbol}(): pass",
        "mtime": 0,
    }


def reset():
    RESPONSES.clear(); CHUNKS.clear(); GRAPH.clear(); QUERIES_SEEN.clear()


def _assert(cond, msg="assertion failed"):
    if not cond:
        raise AssertionError(msg)


# ---------------------------------------------------------------- reformulate
print("\n== reformulation bridges English questions and identifier corpora ==")


def test_strips_filler():
    """A rambling question narrows to its nouns."""
    v = R.reformulate("how long is the grace window for a delinquent account")
    _assert(v, "expected a narrowed variant")
    _assert("how" not in v[0].lower() and "the" not in v[0].lower(),
            f"filler survived: {v[0]!r}")
    for keep in ("grace", "window", "delinquent", "account"):
        _assert(keep in v[0].lower(), f"{keep!r} dropped from {v[0]!r}")


def test_keeps_core_nouns():
    """A long query also gets a variant of just its most distinctive words."""
    v = R.reformulate("show me the code that reconciles the append only ledger journal")
    joined = " | ".join(v)
    _assert("reconciles" in joined or "ledger" in joined, f"core nouns missing: {v}")


def test_terse_query_has_no_variant():
    """Already-terse queries produce nothing - the index + query split already
    handle identifier<->word matching on the first attempt."""
    _assert(R.reformulate("reconcile ledger") == [],
            f"got {R.reformulate('reconcile ledger')!r}")
    _assert(R.reformulate("createUserSession") == [],
            f"got {R.reformulate('createUserSession')!r}")


def test_never_reissues_original():
    for v in R.reformulate("delinquent account grace window period"):
        _assert(v.strip().lower() != "delinquent account grace window period",
                "reformulate returned the original query")


t("a rambling question narrows to its nouns", test_strips_filler)
t("a long query also yields a core-nouns-only variant", test_keeps_core_nouns)
t("an already-terse query produces no variant (index split handles it)", test_terse_query_has_no_variant)
t("the original query is never re-issued as its own variant", test_never_reissues_original)


# ------------------------------------------------------------------- assess
print("\n== weak detection uses interpretable signals, never the RRF score ==")


def sig(*names):
    return {"_signals": set(names)}


t("a set both retrievers corroborate is strong", lambda: _assert(
    R.assess([sig("keyword", "semantic")] * 8, 8, 40, 6.0, 500)[1] is False))

t("semantic-only is NOT weak by itself (a conceptual query legitimately is)",
  lambda: _assert(R.assess([sig("semantic")] * 8, 8, 40, 3.0, 500)[1] is False))

t("graph-only padding with no agreement IS weak (two contributing signals)",
  lambda: _assert(R.assess([sig("graph")] * 8, 8, 40, 1.0, 500)[1] is True))

t("a tiny candidate pool alone is decisive - recall failed, not ranking",
  lambda: _assert(R.assess([sig("keyword", "semantic")] * 3, 8, 3, 1.0, 500)[1] is True))

def test_rerank_lukewarm_band():
    """Between RERANK_WEAK_BELOW and RERANK_IRRELEVANT_BELOW (-6..-8) the model
    is merely being pessimistic about code - decisive only if nothing agrees."""
    _assert(R.assess([sig("semantic")] * 8, 8, 40, -7.0, 500)[1] is True,
            "no agreement + lukewarm reranker -> weak")
    _assert(R.assess([sig("keyword", "semantic")] * 8, 8, 40, -7.0, 500)[1] is False,
            "agreement present -> a lukewarm reranker is only contributing")


def test_rerank_irrelevant_band():
    """Below RERANK_IRRELEVANT_BELOW the reranker is saying nothing retrieved is
    on topic. Measured: no answerable query ever scored this low, so it
    outranks even full agreement (which can be a lexical coincidence)."""
    _assert(R.assess([sig("keyword", "semantic")] * 8, 8, 40, -11.0, 500)[1] is True,
            "reranker at -11 must be weak even with full agreement")


def test_agreement_needs_a_majority():
    """One corroborated result out of three is a coincidence on a common token,
    not evidence. This is the exact false negative found on the real index."""
    considered = [sig("keyword", "semantic")] + [sig("semantic")] * 7
    _assert(R.assess(considered, 8, 40, -7.0, 500)[1] is True,
            "1-of-3 agreement must not count as corroboration")


t("a lukewarm reranker (-6..-8) is decisive only without agreement", test_rerank_lukewarm_band)
t("a reranker below the measured relevance floor is always decisive", test_rerank_irrelevant_band)
t("agreement requires a majority of top results, not a single coincidence", test_agreement_needs_a_majority)

t("empty results are weak with confidence 0", lambda: _assert(
    R.assess([], 8, 0, None, 500) == (0.0, True, ["nothing in the index matched the query at all"])))

t("every weak verdict carries a human-readable reason", lambda: _assert(
    len(R.assess([sig("graph")] * 8, 8, 40, 1.0, 500)[2]) > 0))


# ---------------------------------------------------------------- escalation
print("\n== escalation: a weak first attempt is retried widened + reformulated ==")


def test_recovers():
    reset()
    # The English query finds almost nothing; the identifier spelling finds
    # plenty. This is the exact failure reformulation exists to fix.
    CHUNKS.update({i: chunk(i, f"sym{i}") for i in range(1, 12)})
    q = "please show me how the delinquency grace window is computed for an account"
    RESPONSES[q] = ([1], [1])                               # rambling query: thin
    for variant in R.reformulate(q):
        RESPONSES[variant] = (list(range(1, 10)), list(range(1, 10)))  # narrowed: rich
    _assert(R.reformulate(q), "test needs a query that produces a variant")
    out = R.retrieve_context("d", "cb", q, k=8)
    _assert(out["escalated"] is True, "did not escalate")
    _assert(len(out["attempts"]) >= 2, f"attempts={out['attempts']}")
    _assert(out["attempts"][0]["strategy"] == "initial")
    _assert(out["attempts"][1]["strategy"] == "widened+reformulated")
    _assert(out["query_used"] != q,
            "reported the original query despite recovering on a variant")
    _assert(out["weak"] is False, f"still weak: {out['weak_reasons']}")
    _assert(len(out["results"]) > 1, f"only {len(out['results'])} results")


t("a weak first attempt recovers on a reformulated variant", test_recovers)


def test_no_escalation_when_strong():
    reset()
    CHUNKS.update({i: chunk(i, f"sym{i}") for i in range(1, 12)})
    RESPONSES["parse the config"] = (list(range(1, 10)), list(range(1, 10)))
    out = R.retrieve_context("d", "cb", "parse the config", k=8)
    _assert(out["escalated"] is False, "escalated a perfectly good result")
    _assert(len(out["attempts"]) == 1, f"attempts={len(out['attempts'])}")
    _assert(out["query_used"] == "parse the config")


t("a strong first attempt does NOT escalate - no wasted second search",
  test_no_escalation_when_strong)


def test_never_worse():
    reset()
    # Attempt 1 is mediocre but real; every variant is worse. The result must
    # be attempt 1's, not the last one tried.
    CHUNKS.update({i: chunk(i, f"sym{i}") for i in range(1, 12)})
    RESPONSES["auth token validated"] = ([1, 2, 3], [1, 2, 3])
    for variant in R.reformulate("auth token validated"):
        RESPONSES[variant] = ([], [])
    out = R.retrieve_context("d", "cb", "auth token validated", k=8)
    _assert(len(out["results"]) == 3, f"lost the good results: {len(out['results'])}")
    _assert(out["query_used"] == "auth token validated",
            f"kept a worse variant: {out['query_used']!r}")


t("escalating can never return a WORSE set than not escalating", test_never_worse)


def test_widens_k():
    reset()
    CHUNKS.update({i: chunk(i, f"sym{i}") for i in range(1, 30)})
    RESPONSES["auth token validated"] = ([1], [1])
    for variant in R.reformulate("auth token validated"):
        RESPONSES[variant] = (list(range(1, 25)), list(range(1, 25)))
    out = R.retrieve_context("d", "cb", "auth token validated", k=4)
    widened = [a for a in out["attempts"] if a["strategy"] != "initial"]
    _assert(widened and widened[0]["k"] > 4, f"k was not widened: {widened}")
    _assert(widened[0]["k"] <= R.MAX_WIDE_K, "k widened past its cap")


t("the retry widens k, but never past MAX_WIDE_K", test_widens_k)


def test_bounded_variants():
    reset()
    CHUNKS.update({i: chunk(i, f"sym{i}") for i in range(1, 12)})
    # Nothing matches anything, so every variant stays weak and the loop has
    # no early exit - this is the case a bound has to stop.
    out = R.retrieve_context("d", "cb", "how are user sessions created safely", k=8)
    _assert(len(out["attempts"]) <= 1 + R.MAX_VARIANTS_TRIED,
            f"tried {len(out['attempts'])} attempts, cap is {1 + R.MAX_VARIANTS_TRIED}")


t("a hopeless query is bounded by MAX_VARIANTS_TRIED, not retried forever",
  test_bounded_variants)


def test_reports_honestly():
    reset()
    out = R.retrieve_context("d", "cb", "nothing here at all", k=8)
    _assert(out["results"] == [], "invented results")
    _assert(out["weak"] is True and out["confidence"] == 0.0)
    _assert(out["weak_reasons"], "failed without saying why")


t("an unrecoverable query reports weak honestly instead of padding results",
  test_reports_honestly)


def test_attempts_are_inspectable():
    reset()
    CHUNKS.update({i: chunk(i, f"sym{i}") for i in range(1, 12)})
    RESPONSES["how are user sessions created"] = ([1], [1])
    out = R.retrieve_context("d", "cb", "how are user sessions created", k=8)
    for a in out["attempts"]:
        for field in ("strategy", "query", "k", "results", "confidence", "weak", "reasons"):
            _assert(field in a, f"attempt missing {field}: {a}")


t("every attempt is recorded with its query, k, confidence and reasons",
  test_attempts_are_inspectable)

print(f"\n{_pass} passed, {_fail} failed\n")
sys.exit(1 if _fail else 0)
