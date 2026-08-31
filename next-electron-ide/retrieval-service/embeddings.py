# creates embeddings for text and reranks search results using a cross-encoder
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
    if not documents:
        return []
    reranker = get_reranker()
    if reranker is None:
        return None
    return list(reranker.rerank(query, documents))
