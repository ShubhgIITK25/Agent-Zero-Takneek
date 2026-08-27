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

Every result carries a `why_relevant` tag naming the signal that surfaced
it, so this is legible in the observability dashboard later, not a black
box.
"""
import time
import store
from store import vec_enabled
import embeddings

RECALL_K = 25
GRAPH_EXPAND_TOP_N = 8
MAX_SNIPPET_LINES = 60


def _snippet(code: str, max_lines=MAX_SNIPPET_LINES):
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


def retrieve_context(data_dir: str, codebase_id: str, query_text: str, k: int = 8):
    db = store.get_db(data_dir, codebase_id)

    # --- Stage 1: recall ---
    bm25_hits = dict(store.bm25_search(db, query_text, limit=RECALL_K))
    query_vec = embeddings.embed_query(query_text)
    vec_hits = dict(store.vector_search(db, query_vec, limit=RECALL_K))

    candidate_ids = set(bm25_hits) | set(vec_hits)
    signal = {cid: ("keyword" if cid in bm25_hits else "") + ("+semantic" if cid in vec_hits else "")
              for cid in candidate_ids}

    # --- Stage 2: graph expansion off the strongest vector hits ---
    top_vec_ids = [cid for cid, _ in sorted(vec_hits.items(), key=lambda kv: -kv[1])[:GRAPH_EXPAND_TOP_N]]
    neighbor_ids = store.graph_neighbors(db, top_vec_ids)
    for nid in neighbor_ids:
        if nid not in candidate_ids:
            candidate_ids.add(nid)
            signal[nid] = "graph"

    if not candidate_ids:
        return {"results": [], "candidates_considered": 0, "vector_search": bool(vec_enabled(db))}

    chunks = {cid: store.get_chunk(db, cid) for cid in candidate_ids}
    chunks = {cid: c for cid, c in chunks.items() if c is not None}

    # --- Stage 3: rerank ---
    ordered_ids = list(chunks.keys())
    reranked = embeddings.rerank(query_text, [chunks[cid]["code"][:1500] for cid in ordered_ids])

    now = time.time()
    if reranked is not None:
        scored = list(zip(ordered_ids, reranked))
        scored.sort(key=lambda kv: -kv[1])
        rerank_used = True
    else:
        query_words = set(w.lower() for w in query_text.split())
        base = {cid: max(bm25_hits.get(cid, 0), vec_hits.get(cid, 0), 0.1) for cid in ordered_ids}
        scored = [(cid, _heuristic_score(chunks[cid], query_words, base[cid], now)) for cid in ordered_ids]
        scored.sort(key=lambda kv: -kv[1])
        rerank_used = False

    top = scored[:k]
    results = []
    for cid, score in top:
        c = chunks[cid]
        sig = signal.get(cid, "")
        why = {
            "keyword": "matched search terms directly",
            "semantic": "semantically similar to the query",
            "keyword+semantic": "matched both keyword search and semantic similarity",
            "graph": "structurally connected (1 call/import hop) to a top semantic match",
        }.get(sig, "matched the query")
        results.append({
            "file": c["file_path"],
            "symbol": c["symbol"],
            "kind": c["kind"],
            "line_start": c["line_start"],
            "line_end": c["line_end"],
            "snippet": _snippet(c["code"]),
            "why_relevant": why,
            "score": round(float(score), 4),
        })

    return {
        "results": results,
        "candidates_considered": len(candidate_ids),
        "vector_search": bool(vec_enabled(db)),
        "reranked": rerank_used,
    }
