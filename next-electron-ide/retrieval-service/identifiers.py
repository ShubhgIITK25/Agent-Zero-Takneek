"""
Identifier <-> word-list conversion, shared by the indexer and the query path.

The problem this solves is concrete: SQLite's FTS5 tokeniser treats
`computeDelinquencyGraceWindow` as ONE token. A user asking "delinquency grace
window" — or any natural-language phrasing — cannot match it through BM25, no
matter how the query is worded, because the *indexed* form is atomic.

So at index time every identifier in a chunk's symbol and code is ALSO stored
split into its sub-words (`compute delinquency grace window`), in a dedicated
FTS column. The raw code is still indexed verbatim, so an exact-identifier
search is unchanged; the split column is pure additional recall.

At query time the same split is applied to the query, so a pasted symbol name
(`getUserById`) also searches as `get user by id`.

WHY NOT a custom FTS5 tokeniser. That is the "correct" answer and it needs a C
extension compiled per platform — the exact dependency this service was built
to avoid (see requirements.txt on why sqlite-vec was chosen over a vector DB).
A pre-split column is pure Python, costs one pass over each chunk at index
time, and is transparent in the DB browser.
"""
import re

# camelCase / PascalCase / snake_case / SCREAMING_CASE / digits, one pass.
_SUBWORD_RE = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+")
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")


def split_identifier(word: str) -> list:
    """`createUserSession` -> [create, user, session]; `user_session` -> [user, session].

    Words of one sub-token (`retry`, `parse`) return [] — there is nothing to
    split, and returning the word itself would just duplicate what the raw
    index already has.
    """
    parts = []
    for piece in word.split("_"):
        parts.extend(m.group(0).lower() for m in _SUBWORD_RE.finditer(piece))
    parts = [p for p in parts if p]
    return parts if len(parts) > 1 else []


def expand_text(text: str, max_chars: int = 20000) -> str:
    """Every multi-part identifier in `text`, replaced by its sub-words.

    Deduplicated per call so a symbol used 40 times in a function body does not
    dominate the BM25 term frequency. Bounded so a huge generated file cannot
    blow up the FTS row.
    """
    seen = set()
    out = []
    for m in _IDENT_RE.finditer(text[:max_chars]):
        parts = split_identifier(m.group(0))
        for p in parts:
            if p not in seen:
                seen.add(p)
                out.append(p)
    return " ".join(out)
