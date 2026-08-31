# getUserById -> get, user, by, id; get_user_by_id -> get, user, by, id; get_user_by_id2 -> get, user, by, id2; getUserByID2 -> get, user, by, id2; getUserByID2AndName -> get, user, by, id2, and, name; getUserByID2AndName3 -> get, user, by, id2, and, name3
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
