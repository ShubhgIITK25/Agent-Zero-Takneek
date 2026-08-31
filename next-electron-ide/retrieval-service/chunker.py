# AST boundary chunking is implemented that chunks at function boundaries and preserves information about it. this is done using tree-sitter. for languages that don't have a grammar, we fall back to naive line-window chunking. the chunker also extracts docstrings, leading comments, imports and function calls for each chunk.
import importlib
import re
from languages import language_for, DEF_QUERIES, CALL_NODE_TYPES, GRAMMAR_MODULES

_language_cache = {}
_parser_cache = {}
_query_cache = {}
_reported_failures = set() 


def _get_language(lang: str):
    if lang not in _language_cache:
        from tree_sitter import Language
        module_name, accessor = GRAMMAR_MODULES[lang]
        module = importlib.import_module(module_name)
        _language_cache[lang] = Language(getattr(module, accessor)())
    return _language_cache[lang]

# files that have comment over the file are supposedly understood better
_LINE_COMMENT_RE = re.compile(r"^\s*(#|//)\s?(.*)$")
_IMPORT_LINE_RES = [
    re.compile(r"^\s*(import|from)\s+.+$"),
    re.compile(r"^\s*import\s+.*\bfrom\b.*$"),
    re.compile(r"^\s*(const|let|var)\s+.*require\(.*$"),
]


def _get_parser(lang: str):
    if lang not in _parser_cache:
        from tree_sitter import Parser
        _parser_cache[lang] = Parser(_get_language(lang))
    return _parser_cache[lang]


def _get_query(lang: str):
    if lang not in _query_cache:
        from tree_sitter import Query, QueryCursor
        query = Query(_get_language(lang), DEF_QUERIES[lang])
        _query_cache[lang] = (query, QueryCursor(query))
    return _query_cache[lang]


def _leading_comment(lines, start_line_idx):
    out = []
    i = start_line_idx - 1
    while i >= 0:
        m = _LINE_COMMENT_RE.match(lines[i])
        if not m:
            break
        out.insert(0, m.group(2))
        i -= 1
    return "\n".join(out).strip()


def _python_docstring(node, source: bytes) -> str:
    body = next((c for c in node.children if c.type == "block"), None)
    if not body or not body.children:
        return ""
    first = body.children[0]
    if first.type == "expression_statement" and first.children and first.children[0].type == "string":
        text = source[first.children[0].start_byte:first.children[0].end_byte].decode("utf-8", "replace")
        return text.strip("\"'").strip()
    return ""


def _find_calls(node, call_types, source: bytes, limit=40):
    calls = []

    def walk(n):
        if len(calls) >= limit:
            return
        if n.type in call_types:
            callee = n.children[0] if n.children else None
            if callee is not None:
                text = source[callee.start_byte:callee.end_byte].decode("utf-8", "replace")
                calls.append(text.split(".")[-1].split("::")[-1])
        for c in n.children:
            walk(c)

    walk(node)
    seen = set()
    result = []
    for c in calls:
        if c not in seen:
            seen.add(c)
            result.append(c)
    return result


def _enclosing_parent_name(node):
    p = node.parent
    while p is not None:
        if p.type in ("class_definition", "class_declaration", "class_specifier", "impl_item"):
            for c in p.children:
                if c.type in ("identifier", "type_identifier"):
                    return c.text.decode("utf-8", "replace")
        p = p.parent
    return None


def file_level_imports(text: str, limit=60) -> list:
    out = []
    for line in text.splitlines():
        if any(r.match(line) for r in _IMPORT_LINE_RES):
            out.append(line.strip())
        if len(out) >= limit:
            break
    return out


def ast_chunks(path: str, text: str):
    lang = language_for(path)
    if lang is None or lang not in DEF_QUERIES:
        return None, None

    try:
        parser = _get_parser(lang)
        query, cursor = _get_query(lang)
    except Exception as e:
        if lang not in _reported_failures:
            _reported_failures.add(lang)
            print(
                f"[chunker] GRAMMAR UNAVAILABLE for '{lang}': {type(e).__name__}: {e}\n"
                f"[chunker]   -> all .{lang} files fall back to line-window chunks "
                f"(no symbol names, no call-graph edges).\n"
                f"[chunker]   -> run 'python verify.py --grammars' to check every language."
            )
        return None, None

    source = text.encode("utf-8", "replace")
    tree = parser.parse(source)
    lines = text.splitlines()
    imports = file_level_imports(text)
    call_types = CALL_NODE_TYPES.get(lang, set())

    matches = cursor.matches(tree.root_node)
    chunks = []
    seen_ranges = set()
    for _, captures in matches:
        def_nodes = captures.get("def") or []
        name_nodes = captures.get("name") or []
        if not def_nodes or not name_nodes:
            continue
        def_node = def_nodes[0]
        name_node = name_nodes[0]

        key = (def_node.start_byte, def_node.end_byte)
        if key in seen_ranges:
            continue
        seen_ranges.add(key)

        symbol = name_node.text.decode("utf-8", "replace")
        kind = def_node.type.replace("_definition", "").replace("_declaration", "").replace("_item", "").replace("_specifier", "")
        code = source[def_node.start_byte:def_node.end_byte].decode("utf-8", "replace")
        line_start = def_node.start_point[0] + 1
        line_end = def_node.end_point[0] + 1

        docstring = ""
        if lang == "python":
            docstring = _python_docstring(def_node, source)
        if not docstring:
            docstring = _leading_comment(lines, def_node.start_point[0])

        chunks.append({
            "symbol": symbol,
            "kind": kind or "definition",
            "file_path": path,
            "line_start": line_start,
            "line_end": line_end,
            "parent": _enclosing_parent_name(def_node),
            "docstring": docstring[:500],
            "code": code,
            "imports": imports,
            "calls": _find_calls(def_node, call_types, source),
        })

    return chunks, lang


def fallback_chunks(path: str, text: str, window=60, overlap=10):
    lines = text.splitlines()
    if not lines:
        return []
    imports = file_level_imports(text)
    chunks = []
    i = 0
    idx = 0
    while i < len(lines):
        end = min(i + window, len(lines))
        code = "\n".join(lines[i:end])
        chunks.append({
            "symbol": f"{path.split('/')[-1]}#block{idx}",
            "kind": "block",
            "file_path": path,
            "line_start": i + 1,
            "line_end": end,
            "parent": None,
            "docstring": "",
            "code": code,
            "imports": imports,
            "calls": [],
        })
        idx += 1
        if end == len(lines):
            break
        i = end - overlap
    return chunks


def chunk_file(path: str, text: str):
    chunks, lang = ast_chunks(path, text)
    if chunks is None:
        return fallback_chunks(path, text)
    if not chunks:
        return fallback_chunks(path, text, window=200, overlap=0)
    return chunks
