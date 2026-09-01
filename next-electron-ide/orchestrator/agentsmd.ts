/**
 * ============================================================================
 *  AGENTS.md - per-project rules that must survive compaction
 * ============================================================================
 * The file is free-form markdown by convention, so "parsing" it into a rigid
 * schema would be inventing a format nobody writes. Instead we do two things:
 *   1. Pass the whole file to the agent as a system message (it is prose
 *      instructions; models follow prose instructions).
 *   2. Extract individual imperative lines as `pinnedFacts`, which compaction
 *      re-injects VERBATIM after every compression. That is what makes the
 *      rules survive a compaction event rather than being summarised into
 *      "the user had some style preferences".
 *
 * Lookup order matches the convention other agentic tools use: the project
 * root, then .github/, then a CLAUDE.md fallback since many repos already
 * have one and duplicating it helps nobody.
 */

import * as fs from 'fs';
import * as path from 'path';

const CANDIDATES = ['AGENTS.md', '.github/AGENTS.md', 'CLAUDE.md', '.agents/AGENTS.md'];

export type AgentsMd = { path: string; content: string; rules: string[] } | null;

export function loadAgentsMd(rootPath: string): AgentsMd {
  for (const rel of CANDIDATES) {
    const full = path.join(rootPath, rel);
    try {
      const content = fs.readFileSync(full, 'utf8');
      if (content.trim()) return { path: rel, content, rules: extractRules(content) };
    } catch {
      // not present, try the next candidate
    }
  }
  return null;
}

/**
 * Pull out the lines that read as rules - bullets and numbered items - and
 * keep them short enough to re-inject cheaply on every compaction. Headings
 * and prose paragraphs stay in the full content but are not pinned, because
 * pinning everything would defeat the point of compacting at all.
 */
function extractRules(content: string): string[] {
  const rules: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const m = /^(?:[-*+]|\d+\.)\s+(.{4,240})$/.exec(line);
    if (m) {
      const text = m[1].replace(/\*\*/g, '').trim();
      if (text) rules.push(text);
    }
  }
  // A very long rule list would blow up every compacted prompt. Keep the first
  // 25 - projects that need more should be putting them in prose sections.
  return rules.slice(0, 25);
}

export function agentsMdSystemMessage(a: AgentsMd): string | null {
  if (!a) return null;
  return (
    `Project rules from ${a.path}. These are binding for every change you make in this repository:\n\n` +
    a.content.slice(0, 8000)
  );
}
