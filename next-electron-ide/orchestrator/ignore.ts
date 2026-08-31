/**
 * ============================================================================
 *  CONTEXT IGNORE - files that must never be pulled into agent context
 * ============================================================================
 * `.nexideignore` in the project root (falling back to a plain `.ignore` if
 * that's the name already in use - either works), one pattern per line, in
 * gitignore syntax:
 *   - blank lines and `#` comments are skipped
 *   - `*` matches within one path segment, `**` matches across segments
 *   - a trailing `/` marks a directory (and everything under it)
 *   - a leading `/` anchors the pattern to the project root; otherwise it
 *     matches at any depth, exactly like .gitignore
 *   - a leading `!` re-includes something an earlier pattern excluded
 *
 * SCOPE, DELIBERATELY: this gates the AUTOMATIC paths only -
 * `retrieve_context`, `read_file` and `list_dir` as called by an agent. It
 * does NOT gate a file the user explicitly pins in the chat panel (`@path`,
 * or "+ current file"). An explicit pin is a direct instruction; a blanket
 * ignore rule silently overriding it would be surprising. .gitignore has the
 * same asymmetry - `git add -f` still works on an ignored path.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Paths excluded unconditionally, ignore file or not - noise, not signal. */
const ALWAYS_IGNORED_SEGMENTS = ['.git'];

export type IgnoreRule = { re: RegExp; negate: boolean };

/**
 * One gitignore-style pattern -> one regex matching a project-relative,
 * forward-slash path. Kept separate from anything that touches disk so it
 * can be unit-tested with plain strings.
 */
function patternToRegExp(pattern: string): RegExp {
  let p = pattern;
  if (p.endsWith('/')) p = p.slice(0, -1); // dir-only marker: matches the dir and everything under it either way
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);

  let out = '';
  for (let i = 0; i < p.length; i++) {
    if (p.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 2;
      continue;
    }
    if (p.startsWith('/**', i)) {
      out += '(?:/.*)?';
      i += 2;
      continue;
    }
    const c = p[i];
    if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const body = anchored ? `^${out}` : `(?:^|.*/)${out}`;
  // Match the segment itself, or that segment as a directory prefix of a
  // longer path - so `dist/` (or `dist`) also excludes `dist/foo/bar.js`.
  return new RegExp(`${body}(?:/.*)?$`);
}

/** Pure: turns raw ignore-file text into compiled rules. No filesystem. */
export function compileIgnoreRules(raw: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const negate = trimmed.startsWith('!');
    const pat = negate ? trimmed.slice(1).trim() : trimmed;
    if (!pat) continue;
    rules.push({ re: patternToRegExp(pat), negate });
  }
  return rules;
}

/**
 * Pure: is this path ignored? Later rules win over earlier ones (gitignore
 * semantics), so a `!keep/me.ts` after a broad exclude re-includes it.
 */
export function matchIgnored(rules: IgnoreRule[], relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  for (const seg of ALWAYS_IGNORED_SEGMENTS) {
    if (segments.includes(seg)) return true;
  }
  let ignored = false;
  for (const rule of rules) {
    if (rule.re.test(normalized)) ignored = !rule.negate;
  }
  return ignored;
}

export type IgnoreMatcher = {
  isIgnored: (relPath: string) => boolean;
  /** `.nexideignore`, `.ignore`, or null if neither exists (nothing is ignored beyond ALWAYS_IGNORED_SEGMENTS). */
  sourceFile: string | null;
  patternCount: number;
};

const CANDIDATE_FILENAMES = ['.nexideignore', '.ignore'];

export function loadIgnoreMatcher(rootPath: string): IgnoreMatcher {
  let sourceFile: string | null = null;
  let raw = '';
  for (const name of CANDIDATE_FILENAMES) {
    try {
      raw = fs.readFileSync(path.join(rootPath, name), 'utf8');
      sourceFile = name;
      break;
    } catch {
      // try the next candidate name
    }
  }
  const rules = compileIgnoreRules(raw);
  return {
    isIgnored: (relPath: string) => matchIgnored(rules, relPath),
    sourceFile,
    patternCount: rules.length,
  };
}
