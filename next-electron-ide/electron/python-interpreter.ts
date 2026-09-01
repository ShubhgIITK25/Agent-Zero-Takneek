/**
 * ============================================================================
 *  PYTHON INTERPRETER RESOLUTION for the retrieval service
 * ============================================================================
 * The retrieval service needs tree-sitter, fastembed and sqlite-vec. None of
 * those are on a stock `python3`. Spawning bare `python3` - which is what this
 * used to do - is how the service ends up running in permanent keyword-only
 * degraded mode on every machine that did not `pip install` the requirements
 * globally, which is very nearly all of them. It does not error; it just
 * quietly stops doing AST chunking, vector search and reranking, and nothing
 * on screen says so.
 *
 * So before falling back to PATH we look for the virtualenv the setup docs
 * (README §2.3) tell you to create. Resolution order, first hit wins:
 *
 *   1. NEXIDE_PYTHON             explicit override, always respected. If it
 *                               looks like a path it must exist; a bare
 *                               command name (e.g. "python3.12") is trusted.
 *   2. retrieval-service/.venv  the project-local venv - the common case in
 *                               development and the one the docs describe.
 *   3. $VIRTUAL_ENV             a venv the user activated in the shell that
 *                               launched the app.
 *   4. python3 / python on PATH last resort. `isFallback` is set so the
 *                               caller can warn - this is the path that
 *                               silently loses half the pipeline.
 *
 * This module is deliberately free of any `electron` or `fs` import so it can
 * be unit-tested as a pure function; the real filesystem check and the real
 * paths are injected by the caller (see electron/main.ts).
 */

export type InterpreterResolution = {
  /** What to pass to child_process.spawn. */
  command: string;
  /** Human-readable provenance, for the startup log. */
  source: string;
  /** True when this is the bare-PATH last resort - caller should warn. */
  isFallback: boolean;
};

export type ResolveOptions = {
  /** Absolute path to the retrieval-service directory. */
  serviceDir: string;
  /** Environment to read NEXIDE_PYTHON / VIRTUAL_ENV from. */
  env: NodeJS.ProcessEnv;
  /** `process.platform`. */
  platform: NodeJS.Platform;
  /** Synchronous "does this path exist" check (normally fs.existsSync). */
  exists: (p: string) => boolean;
  /**
   * Path join. Defaults to a POSIX/Windows-aware join so tests need not pass
   * one, but the caller passes `path.join` so separators match the real OS.
   */
  join?: (...parts: string[]) => string;
};

function defaultJoin(platform: NodeJS.Platform) {
  const sep = platform === "win32" ? "\\" : "/";
  return (...parts: string[]) =>
    parts
      .filter((p) => p.length > 0)
      .join(sep)
      .replace(/[/\\]+/g, sep);
}

/** The interpreter path inside a virtualenv root, per platform. */
export function venvInterpreter(
  venvRoot: string,
  platform: NodeJS.Platform,
  join: (...parts: string[]) => string,
): string {
  return platform === "win32"
    ? join(venvRoot, "Scripts", "python.exe")
    : join(venvRoot, "bin", "python");
}

export function resolvePythonInterpreter(
  opts: ResolveOptions,
): InterpreterResolution {
  const { serviceDir, env, platform, exists } = opts;
  const join = opts.join ?? defaultJoin(platform);
  const sep = platform === "win32" ? "\\" : "/";

  // 1. Explicit override.
  const override = env.NEXIDE_PYTHON?.trim();
  if (override) {
    const looksLikePath =
      override.includes("/") || override.includes("\\") || override.includes(sep);
    if (looksLikePath && !exists(override)) {
      // Misconfigured - fall through rather than spawn a path that isn't there.
      // The caller logs the whole resolution, so this stays visible.
    } else {
      return { command: override, source: "NEXIDE_PYTHON", isFallback: false };
    }
  }

  // 2. Project-local venv (README §2.3).
  const localVenv = venvInterpreter(join(serviceDir, ".venv"), platform, join);
  if (exists(localVenv)) {
    return {
      command: localVenv,
      source: "retrieval-service/.venv",
      isFallback: false,
    };
  }

  // 3. A venv the user activated before launching.
  const activeVenv = env.VIRTUAL_ENV?.trim();
  if (activeVenv) {
    const activated = venvInterpreter(activeVenv, platform, join);
    if (exists(activated)) {
      return { command: activated, source: "$VIRTUAL_ENV", isFallback: false };
    }
  }

  // 4. Last resort.
  return {
    command: platform === "win32" ? "python" : "python3",
    source: "PATH (no virtualenv found)",
    isFallback: true,
  };
}
