"""
Local embedding + reranking via fastembed (ONNX runtime, no torch).

Both models are lazy-loaded singletons - nothing downloads or loads into
memory until the first real request, so opening the IDE doesn't pay this
cost, and a machine with no network access at first run only pays it once
(fastembed caches the ONNX weights under its own cache dir after first
download).

Failure is graceful and explicit everywhere: if the embedding model can't
load (no network for the first-run download, disk full, etc.) the service
still runs - vector search is just disabled and retrieval falls back to
BM25 + graph expansion only. Same story for the reranker: if it's
unavailable, Stage 3 falls back to a heuristic score instead of failing
the whole query.
"""

EMBED_MODEL = "BAAI/bge-small-en-v1.5"          # 33M params, 384-dim
RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2"  # ~23M params

_embedder = None
_embedder_failed = False
_reranker = None
_reranker_failed = False


def get_embedder():
    global _embedder, _embedder_failed
    if _embedder is not None or _embedder_failed:
        return _embedder
    try:
        from fastembed import TextEmbedding
        _embedder = TextEmbedding(model_name=EMBED_MODEL)
    except Exception as e:
        print(f"[embeddings] embedding model unavailable, vector search disabled: {e}")
        _embedder_failed = True
        _embedder = None
    return _embedder


def get_reranker():
    global _reranker, _reranker_failed
    if _reranker is not None or _reranker_failed:
        return _reranker
    try:
        from fastembed.rerank.cross_encoder import TextCrossEncoder
        _reranker = TextCrossEncoder(model_name=RERANK_MODEL)
    except Exception as e:
        print(f"[embeddings] reranker unavailable, falling back to heuristic scoring: {e}")
        _reranker_failed = True
        _reranker = None
    return _reranker


def embed_texts(texts):
    """Returns list[list[float]] or None if the embedder is unavailable."""
    if not texts:
        return []
    embedder = get_embedder()
    if embedder is None:
        return None
    return [list(v) for v in embedder.embed(texts)]


def embed_query(text: str):
    vecs = embed_texts([text])
    return vecs[0] if vecs else None


def rerank(query: str, documents: list):
    """Returns list[float] scores aligned with `documents`, or None if the
    reranker is unavailable (caller should use a heuristic fallback)."""
    if not documents:
        return []
    reranker = get_reranker()
    if reranker is None:
        return None
    return list(reranker.rerank(query, documents))
