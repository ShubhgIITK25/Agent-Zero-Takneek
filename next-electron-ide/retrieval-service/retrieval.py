"""
Phase 2: query. This is what `retrieve_context` (the tool exposed to the
model) actually runs.

Stage 1 (recall)   — BM25 and vector search run in parallel-ish (both are
                      fast local SQLite calls), candidates unioned.
Stage 2 (expand)    — 1-hop graph neighbors of the strongest vector hits
                      are pulled in, so a structurally-relevant chunk that
                      just doesn't *sound* like the query still surfaces.
Stage 3 (rerank)    — a small local cross-encoder (or, if it's not
                      available, a cheap heuristic) cuts the combined
                      candidate pool down to the k chunks actually worth
                      spending the calling model's tokens on.
Stage 4 (recover)  — a first attempt can come back thin or weak. That is not
                      a rare edge case: it is the normal outcome when the user
                      asks in English ("how are user sessions created") about
                      a corpus written in identifiers (`createUserSession`).
                      So a weak attempt is DETECTED (`assess`) and retried with
                      a widened recall pool and a reformulated query
                      (`reformulate`) before the caller ever sees it.

Every result carries a `why_relevant` tag naming the signal that surfaced
it, and every escalation is recorded in `attempts`, so this is legible in
the observability dashboard later, not a black box.
"""
import re
import time
import store
from store import vec_enabled
import embeddings

RECALL_K = 25
GRAPH_EXPAND_TOP_N = 8
MAX_SNIPPET_LINES = 60
# RRF deliberately combines ranks, not raw BM25/vector/cross-encoder scores:
# those scores have different scales and cannot safely be compared directly.
RRF_K = 60
GRAPH_RRF_WEIGHT = 0.5
RERANK_RRF_WEIGHT = 2.0

# --- escalation ---------------------------------------------------------
# What a widened retry widens to. Deliberately one step, not a ramp: a second
# attempt 2.4x wider either finds the thing or the thing is not in the index,
# and a third and fourth pass mostly cost latency.
WIDE_RECALL_K = 60
WIDE_GRAPH_EXPAND_TOP_N = 16
# Cap on how many extra results a widened attempt may hand back, so "recover
# from a weak result" never turns into "dump the codebase into the context".
WIDE_K_MULTIPLIER = 2
MAX_WIDE_K = 16
# Reformulation can produce several spellings; trying all of them on a query
# that is simply not in the index is latency for nothing.
MAX_VARIANTS_TRIED = 2


def _snippet(code, max_lines=MAX_SNIPPET_LINES):
    lines = code.splitlines()
    if len(lines) <= max_lines:
        return code
    head = lines[: max_lines - 5]
    return "\n".join(head) + f"\n... ({len(lines) - len(head)} more lines — use open_file to see all of it)"


def _heuristic_score(chunk: dict, query_words: set, base_rank_score: float, now: float):
    score = base_rank_score
    symbol_lower = chunk["symbol"].lower()
    if any(w in symbol_lower for w in query_words):
        score += 2.0  # exact-ish symbol match is a strong signal
    age_days = max(0.0, (now - chunk.get("mtime", now)) / 86400)
    score += max(0.0, 1.0 - age_days / 30) * 0.3  # mild recency boost, decays over ~30 days
    return score


def _rrf_fuse(rank_lists: list, weights: list = None) -> dict:
    """Fuse ordered candidate lists with Reciprocal Rank Fusion.

    RRF score is weight / (RRF_K + rank), with ranks starting at 1.  This
    makes keyword, vector, graph, and reranker results comparable without
    pretending their raw scores share a scale.  Duplicate ids in one list
    are counted only at their first occurrence.
    """
    weights = weights or [1.0] * len(rank_lists)
    scores = {}
    for candidates, weight in zip(rank_lists, weights):
        seen = set()
        for rank, cid in enumerate(candidates, start=1):
            if cid in seen:
                continue
            seen.add(cid)
            scores[cid] = scores.get(cid, 0.0) + weight / (RRF_K + rank)
    return scores


# ---------------------------------------------------------------------------
# Query reformulation
# ---------------------------------------------------------------------------
# Natural-language questions and source code are two different vocabularies.
# "how are user sessions created" and `createUserSession` share no BM25 token:
# the tokeniser sees {how, are, user, sessions, created} on one side and
# {createusersession} on the other. The strongest lexical evidence in the
# codebase is invisible to the query that should have found it.
#
# So reformulation bridges the two directions, deterministically:
#   query -> code   join adjacent content words into identifier spellings
#                   ("user sessions" -> userSession, user_session, usersession)
#   code -> query   split identifiers in the query into their sub-words
#                   ("createUserSession" -> create, user, session)
#
# WHY NOT ASK A MODEL TO REWRITE THE QUERY. That is the obvious move and we
# rejected it. It puts a model round-trip inside a tool an agent calls several
# times per subtask, on the cost term weighted ~2x time — and retrieval is the
# single most-called tool in the system. This gets most of the benefit for zero
# marginal cost and zero latency variance, and it is reproducible: the same
# weak query always escalates the same way, which a rewrite model could not
# guarantee and which would make the dashboard's trace unrepeatable.
#
# If the deterministic pass still comes back weak, the tool hands the problem
# UP to the agent, which is already a model in a loop and can rephrase
# semantically at no extra call (see tools.ts). Cheap mechanism first; the
# expensive one only when it fails, and paid for by a call we were making
# anyway.

# Words that carry intent in a question but never appear in an identifier.
_STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "do", "does", "did", "doing", "how", "what", "where", "when", "why",
    "which", "who", "whom", "this", "that", "these", "those", "of", "to",
    "in", "on", "at", "by", "for", "with", "about", "from", "into", "and",
    "or", "but", "if", "then", "than", "so", "it", "its", "i", "we", "you",
    "can", "could", "should", "would", "may", "might", "will", "shall",
    "there", "here", "code", "codebase", "file", "files", "find", "show",
    "me", "please", "any", "all", "some", "handle", "handled", "work",
    "works", "used", "use", "uses", "using", "get", "gets", "long",
}

_WORD_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def content_words(query_text):
    """Query words with stopwords and duplicates removed, order preserved."""
    out, seen = [], set()
    for w in _WORD_RE.findall(query_text):
        lw = w.lower()
        if lw in _STOPWORDS or lw in seen or len(lw) < 2:
            continue
        seen.add(lw)
        out.append(w)
    return out


def reformulate(query_text):
    """Alternate phrasings of a query that retrieved poorly, best-first.

    Deliberately conservative. The *index* already stores every identifier
    split into sub-words (identifiers.py), and `sanitize_fts_query` splits the
    query the same way, so "user balance" already matches `getUserBalance` on
    the FIRST attempt without any reformulation. The earlier, aggressive
    version of this function synthesised identifier spellings
    (`userBalance`, `user_balance`, ...) and ORed a dozen of them into the FTS
    query — which, post-index-fix, bought nothing and started matching noise:
    a query with no real answer would OR enough guesses together to look
    corroborated. So this now does exactly two safe things:

      1. strip filler words, so a rambling question narrows to its nouns
         ("how long is the grace window for a delinquent account"
          -> "grace window delinquent account")
      2. keep only the least common half of those, so the strongest terms are
         not diluted by generic ones

    Returns [] when neither produces something genuinely different from the
    query as asked, so the caller can skip a pointless second search.
    """
    content = content_words(query_text)
    if not content:
        return []

    variants = []
    original = query_text.strip().lower()

    narrowed = " ".join(content)
    if narrowed.lower() != original and len(content) < len(_WORD_RE.findall(query_text)):
        variants.append(narrowed)

    # The nouns most likely to be distinctive are the longer ones; generic
    # short words ("data", "list", "run") tend to match everywhere.
    if len(content) >= 4:
        core = sorted(content, key=len, reverse=True)[: max(2, len(content) // 2)]
        # keep source order among the chosen words
        core = [w for w in content if w in core]
        core_str = " ".join(core)
        if core_str.lower() not in (original, narrowed.lower()):
            variants.append(core_str)

    # Deduplicate, preserve order, never re-issue the original.
    out, seen = [], {original}
    for v in variants:
        key = v.strip().lower()
        if key and key not in seen:
            seen.add(key)
            out.append(v)
    return out[:MAX_VARIANTS_TRIED]


# ---------------------------------------------------------------------------
# Confidence assessment
# ---------------------------------------------------------------------------
# WHAT WE DELIBERATELY DO NOT USE AS CONFIDENCE: the `score` field. It is an
# RRF score — a fused *rank* score whose theoretical maximum here is about
# 0.074 and whose absolute value carries no semantic meaning. Thresholding on
# it would look like a confidence measure and be numerology. The signals below
# were chosen because each is independently interpretable:
#
#   agreement    BM25 and vector search are independent retrievers over
#                different representations. A chunk both surfaced is real
#                evidence; a result set where nothing has both is a set that
#                nothing corroborated.
#   graph-only   a result ONLY graph expansion produced means nothing matched
#                the query itself — we are showing a neighbour of a weak hit
#                and calling it a result.
#   pool size    how many distinct chunks matched anything at all. A pool of
#                three in a large index means recall failed, not ranking.
#   shortfall    fewer results than asked for: the index does not have it.
#   reranker     the one genuinely calibrated number in the pipeline, when the
#                cross-encoder loaded. It is a trained relevance model, so its
#                score IS comparable across queries — unlike RRF.

MIN_CANDIDATE_POOL = 6
WEAK_CONFIDENCE = 0.5

# Two cross-encoder thresholds, not one, because the model's usable range on
# code is not its nominal range. ms-marco MiniLM's nominal decision boundary is
# 0, but it was trained on web passages and systematically under-scores code.
# Measured on this project's own orchestrator source (161 chunks, 11 queries —
# see the table in the README):
#
#   answerable queries   top score  -4.1 .. +4.5   agreement 3/3 every time
#   absent queries       top score -11.2 .. -9.0   agreement 0-1/3
#
# So there is a wide empty band between about -9 and -4 that separates "the
# model is grumpy about code" from "nothing here is even topically related".
# Both thresholds sit inside it:
RERANK_WEAK_BELOW = -6.0        # lukewarm: contributing, or decisive if nothing agrees
RERANK_IRRELEVANT_BELOW = -8.0  # decisive ALWAYS — no answerable query measured this low

# The anchor signal is RETRIEVER AGREEMENT. BM25 and vector search are
# independent — different representation, different algorithm — so a chunk both
# of them rank at the top is corroborated by two methods that fail differently.
# That is the strongest evidence available here, stronger than a web-trained
# cross-encoder's absolute score. So:
#
#   * With agreement on the top result, a result set is NOT weak on the
#     reranker's say-so alone. The reranker and pool-size drop to contributing.
#   * Without agreement, the reranker and a thin pool are each decisive on
#     their own — there is nothing else holding the result up.
#
# This is why the penalties are assigned in code below rather than as fixed
# constants per signal: the same signal means different things depending on
# whether anything corroborates it.
DECISIVE_PENALTY = 0.55
CONTRIBUTING_PENALTY = 0.3
SHORTFALL_PENALTY = 0.2


def assess(results, k_requested, candidates_considered, top_rerank, total_chunks):
    """Judge a result set. Returns (confidence 0..1, weak, reasons).

    `total_chunks` is the size of the whole index: a pool of four candidates is
    a failed retrieval in a 5000-chunk repo and a complete one in a repo that
    only has four chunks, and an absolute floor gets that backwards.
    """
    if not results:
        return 0.0, True, ["nothing in the index matched the query at all"]

    reasons = []
    considered = results[: max(3, k_requested // 2)]
    agreeing = sum(1 for r in considered if {"keyword", "semantic"} <= r["_signals"])
    graph_only = sum(1 for r in considered if r["_signals"] == {"graph"})
    # A MAJORITY of the top results must be corroborated, not just one. A
    # single result matching both retrievers is routinely a coincidence on a
    # common token: "kubernetes ingress controller helm values" scored 1/3
    # agreement against this codebase purely on the word "values", and that one
    # spurious agreement was enough to suppress every other weak signal.
    has_agreement = agreeing >= max(1, (len(considered) + 1) // 2)

    pool_is_thin = (
        candidates_considered < MIN_CANDIDATE_POOL
        and candidates_considered < max(1, total_chunks) * 0.5
    )
    rerank_says_no = top_rerank is not None and top_rerank < RERANK_WEAK_BELOW

    score = 1.0

    # Decisive regardless of agreement: at this level the cross-encoder is not
    # being pessimistic about code, it is saying nothing retrieved is on topic.
    if top_rerank is not None and top_rerank < RERANK_IRRELEVANT_BELOW:
        score -= DECISIVE_PENALTY
        reasons.append(
            f"the reranker scored the best hit at {top_rerank:.1f} — below the level "
            f"any relevant code result has been measured at")
    elif not has_agreement:
        # Nothing corroborated by two independent methods — the reranker and
        # the pool size are now the only things holding a verdict up, so each
        # is decisive.
        score -= CONTRIBUTING_PENALTY
        reasons.append("no result was found by both keyword and semantic search independently")
        if rerank_says_no:
            score -= DECISIVE_PENALTY
            reasons.append(f"the reranker scored even the best hit at {top_rerank:.1f}, below its relevance boundary")
        if pool_is_thin:
            score -= DECISIVE_PENALTY
            reasons.append(f"only {candidates_considered} of {total_chunks} indexed chunk(s) matched anything")
    else:
        # Two independent retrievers agree. A pessimistic cross-encoder or a
        # modest pool is a contributing concern, not a verdict.
        if rerank_says_no:
            score -= CONTRIBUTING_PENALTY
            reasons.append(f"the reranker was lukewarm (best hit {top_rerank:.1f}), though keyword and semantic search agree")
        if pool_is_thin:
            score -= CONTRIBUTING_PENALTY
            reasons.append(f"only {candidates_considered} of {total_chunks} indexed chunk(s) matched")

    if graph_only >= max(1, len(considered) // 2):
        score -= CONTRIBUTING_PENALTY
        reasons.append("most results came only from graph expansion, not from matching the query")
    if len(results) < k_requested:
        score -= SHORTFALL_PENALTY
        reasons.append(f"returned {len(results)} of the {k_requested} requested")

    score = max(0.0, min(1.0, score))
    return score, score < WEAK_CONFIDENCE, reasons


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def _search_once(db, query_text: str, k: int, recall_k: int, graph_top_n: int):
    """One full recall -> expand -> rerank pass. No escalation logic here."""
    # --- Stage 1: recall ---
    bm25_hits = dict(store.bm25_search(db, query_text, limit=recall_k))
    query_vec = embeddings.embed_query(query_text)
    vec_hits = dict(store.vector_search(db, query_vec, limit=recall_k))

    # Keep the source ranking intact.  Converting these to a set too early
    # loses rank information and makes ties depend on hash iteration order.
    bm25_order = list(bm25_hits.keys())
    vec_order = list(vec_hits.keys())
    candidate_ids = set(bm25_order) | set(vec_order)
    signal = {cid: set() for cid in candidate_ids}
    for cid in bm25_order:
        signal[cid].add("keyword")
    for cid in vec_order:
        signal[cid].add("semantic")

    # --- Stage 2: graph expansion off the strongest vector hits ---
    top_vec_ids = [cid for cid, _ in sorted(vec_hits.items(), key=lambda kv: -kv[1])[:graph_top_n]]
    neighbor_ids = store.graph_neighbors(db, top_vec_ids)
    for nid in neighbor_ids:
        candidate_ids.add(nid)
        signal.setdefault(nid, set()).add("graph")

    empty_meta = {"candidates_considered": 0, "reranked": False, "top_rerank": None}
    if not candidate_ids:
        return [], empty_meta

    chunks = {cid: store.get_chunk(db, cid) for cid in candidate_ids}
    chunks = {cid: c for cid, c in chunks.items() if c is not None}
    if not chunks:
        return [], empty_meta

    # --- Stage 3: rerank ---
    # The union is ordered by recall evidence, then by id as a stable tie
    # breaker.  This keeps query results reproducible when SQLite returns
    # equal scores.
    graph_order = sorted(neighbor_ids)
    recall_scores = _rrf_fuse(
        [bm25_order, vec_order, graph_order],
        [1.0, 1.0, GRAPH_RRF_WEIGHT],
    )
    ordered_ids = sorted(chunks, key=lambda cid: (-recall_scores.get(cid, 0.0), cid))
    reranked = embeddings.rerank(query_text, [chunks[cid]["code"][:1500] for cid in ordered_ids])

    now = time.time()
    top_rerank = None
    if reranked is not None:
        # Retained, not just used for ordering: this is the only calibrated
        # relevance number in the pipeline, so `assess` needs to see it.
        top_rerank = max(reranked) if len(reranked) else None
        rerank_order = [cid for cid, _ in sorted(zip(ordered_ids, reranked), key=lambda kv: (-kv[1], kv[0]))]
        # Keep the cross-encoder's judgment important, but retain independent
        # recall evidence.  A reranker can score a weakly-recalled candidate
        # highly; RRF prevents it from completely erasing keyword/vector
        # agreement and graph evidence.
        final_scores = _rrf_fuse(
            [bm25_order, vec_order, graph_order, rerank_order],
            [1.0, 1.0, GRAPH_RRF_WEIGHT, RERANK_RRF_WEIGHT],
        )
        scored = [(cid, final_scores.get(cid, 0.0)) for cid in chunks]
        scored.sort(key=lambda kv: (-kv[1], kv[0]))
        rerank_used = True
    else:
        query_words = set(w.lower() for w in query_text.split())
        # The heuristic is now a small tie-breaker over the RRF result, rather
        # than a max() over incomparable BM25 and vector score scales.
        scored = [
            (
                cid,
                recall_scores.get(cid, 0.0) + 0.001 * _heuristic_score(
                    chunks[cid], query_words, 0.0, now
                ),
            )
            for cid in chunks
        ]
        scored.sort(key=lambda kv: -kv[1])
        rerank_used = False

    results = []
    for cid, score in scored[:k]:
        c = chunks[cid]
        sig = signal.get(cid, set())
        if "graph" in sig and ("keyword" in sig or "semantic" in sig):
            why = "matched retrieval and is structurally connected (1 call/import hop)"
        elif "graph" in sig:
            why = "structurally connected (1 call/import hop) to a top semantic match"
        elif "keyword" in sig and "semantic" in sig:
            why = "matched both keyword search and semantic similarity"
        elif "keyword" in sig:
            why = "matched search terms directly"
        elif "semantic" in sig:
            why = "semantically similar to the query"
        else:
            why = "matched the query"
        results.append({
            "file": c["file_path"],
            "symbol": c["symbol"],
            "kind": c["kind"],
            "line_start": c["line_start"],
            "line_end": c["line_end"],
            "snippet": _snippet(c["code"]),
            "why_relevant": why,
            "score": round(float(score), 4),
            "_signals": sig,
        })

    return results, {
        "candidates_considered": len(candidate_ids),
        "reranked": rerank_used,
        "top_rerank": top_rerank,
    }


def _strip_private(results):
    return [{kk: vv for kk, vv in r.items() if not kk.startswith("_")} for r in results]


def retrieve_context(data_dir: str, codebase_id: str, query_text: str, k: int = 8):
    """Retrieve, assess, and — if the first attempt was weak — recover.

    Recovery is one widened + reformulated retry per variant, not an open
    ramp. Every attempt is recorded in `attempts`, so an escalation is
    inspectable in the dashboard rather than being an invisible "it just
    worked the second time".

    The best attempt wins on confidence, so escalating can never make the
    answer worse than not escalating: if widening surfaces only noise, the
    original result set is returned and the low confidence is reported
    honestly rather than being papered over with more results.
    """
    db = store.get_db(data_dir, codebase_id)
    total_chunks = store.stats(db).get("chunks_indexed", 0)
    attempts = []

    def record(strategy, query, kk, results, meta, confidence, weak, reasons):
        attempts.append({
            "strategy": strategy,
            "query": query,
            "k": kk,
            "results": len(results),
            "candidates_considered": meta["candidates_considered"],
            "confidence": round(confidence, 2),
            "weak": weak,
            "reasons": reasons,
        })

    # --- attempt 1: the query as asked -----------------------------------
    results, meta = _search_once(db, query_text, k, RECALL_K, GRAPH_EXPAND_TOP_N)
    confidence, weak, reasons = assess(results, k, meta["candidates_considered"], meta["top_rerank"], total_chunks)
    record("initial", query_text, k, results, meta, confidence, weak, reasons)
    best = (confidence, results, meta, query_text, k)

    # --- attempt 2+: widen the pool AND rewrite the query -----------------
    # Both levers at once, on purpose. They fix different failures — widening
    # fixes "the right chunk ranked 30th", reformulation fixes "the right chunk
    # shares no token with the query" — and separating them into two attempts
    # would double the latency to fix either one.
    if weak:
        wide_k = min(MAX_WIDE_K, k * WIDE_K_MULTIPLIER)
        variants = reformulate(query_text)
        if not variants:
            # Nothing to rewrite (a single opaque token, say), so widening
            # alone is still worth one attempt.
            variants = [query_text]
        for variant in variants:
            r2, m2 = _search_once(db, variant, wide_k, WIDE_RECALL_K, WIDE_GRAPH_EXPAND_TOP_N)
            c2, w2, reasons2 = assess(r2, wide_k, m2["candidates_considered"], m2["top_rerank"], total_chunks)
            record("widened+reformulated", variant, wide_k, r2, m2, c2, w2, reasons2)
            if c2 > best[0]:
                best = (c2, r2, m2, variant, wide_k)
            # Stop at the first variant that clears the bar: trying the rest
            # spends latency to maybe improve an already-acceptable answer.
            if not w2:
                break

    confidence, results, meta, used_query, used_k = best
    _, weak, reasons = assess(results, used_k, meta["candidates_considered"], meta["top_rerank"], total_chunks)

    return {
        "results": _strip_private(results),
        "candidates_considered": meta["candidates_considered"],
        "vector_search": bool(vec_enabled(db)),
        "reranked": meta["reranked"],
        "confidence": round(confidence, 2),
        "weak": weak,
        "weak_reasons": reasons,
        "query_used": used_query,
        "escalated": len(attempts) > 1,
        "attempts": attempts,
    }
