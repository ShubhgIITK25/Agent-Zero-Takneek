# Each language maps to the module that provides its compiled grammar and
# the accessor function to call on that module (tree_sitter_typescript
# bundles two grammars — typescript and tsx — under two different
# functions, everything else exposes a single `language()`).
GRAMMAR_MODULES = {
    "python": ("tree_sitter_python", "language"),
    "javascript": ("tree_sitter_javascript", "language"),
    "typescript": ("tree_sitter_typescript", "language_typescript"),
    "tsx": ("tree_sitter_typescript", "language_tsx"),
    "go": ("tree_sitter_go", "language"),
    "rust": ("tree_sitter_rust", "language"),
    "java": ("tree_sitter_java", "language"),
    "c": ("tree_sitter_c", "language"),
    "cpp": ("tree_sitter_cpp", "language"),
}

EXT_TO_LANG = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cc": "cpp",
}

# Definition queries: capture @name (the symbol's identifier) and @def
# (the whole definition node, used for the chunk's line range + body).
DEF_QUERIES = {
    "python": """
        (function_definition name: (identifier) @name) @def
        (class_definition name: (identifier) @name) @def
    """,
    "javascript": """
        (function_declaration name: (identifier) @name) @def
        (class_declaration name: (identifier) @name) @def
        (method_definition name: (property_identifier) @name) @def
        (lexical_declaration
          (variable_declarator
            name: (identifier) @name
            value: [(arrow_function) (function_expression)])) @def
    """,
    # NOTE: TypeScript names classes/interfaces with `type_identifier`, NOT
    # `identifier` the way JavaScript does. Using `identifier` here compiles
    # to an "Impossible pattern" error that fails the WHOLE query, which
    # silently drops every .ts file to line-window fallback chunking.
    # `verify.py --grammars` compiles all of these so that can't hide again.
    "typescript": """
        (function_declaration name: (identifier) @name) @def
        (class_declaration name: (type_identifier) @name) @def
        (method_definition name: (property_identifier) @name) @def
        (interface_declaration name: (type_identifier) @name) @def
        (type_alias_declaration name: (type_identifier) @name) @def
        (lexical_declaration
          (variable_declarator
            name: (identifier) @name
            value: [(arrow_function) (function_expression)])) @def
    """,
    "tsx": """
        (function_declaration name: (identifier) @name) @def
        (class_declaration name: (type_identifier) @name) @def
        (method_definition name: (property_identifier) @name) @def
        (interface_declaration name: (type_identifier) @name) @def
        (type_alias_declaration name: (type_identifier) @name) @def
        (lexical_declaration
          (variable_declarator
            name: (identifier) @name
            value: [(arrow_function) (function_expression)])) @def
    """,
    "go": """
        (function_declaration name: (identifier) @name) @def
        (method_declaration name: (field_identifier) @name) @def
        (type_declaration (type_spec name: (type_identifier) @name)) @def
    """,
    "rust": """
        (function_item name: (identifier) @name) @def
        (impl_item type: (type_identifier) @name) @def
        (struct_item name: (type_identifier) @name) @def
    """,
    "java": """
        (method_declaration name: (identifier) @name) @def
        (class_declaration name: (identifier) @name) @def
    """,
    "c": """
        (function_definition declarator: (function_declarator declarator: (identifier) @name)) @def
    """,
    "cpp": """
        (function_definition declarator: (function_declarator declarator: (identifier) @name)) @def
        (class_specifier name: (type_identifier) @name) @def
    """,
}

# Node type names that represent "calling something" in each language, so
# the chunker can scan a definition's subtree for callees.
CALL_NODE_TYPES = {
    "python": {"call"},
    "javascript": {"call_expression"},
    "typescript": {"call_expression"},
    "tsx": {"call_expression"},
    "go": {"call_expression"},
    "rust": {"call_expression", "macro_invocation"},
    "java": {"method_invocation"},
    "c": {"call_expression"},
    "cpp": {"call_expression"},
}

IGNORED_DIR_NAMES = {
    "node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv",
    ".next", "electron-dist", ".turbo", "target", ".mypy_cache", ".pytest_cache",
}


def language_for(path: str):
    for ext, lang in EXT_TO_LANG.items():
        if path.endswith(ext):
            return lang
    return None
