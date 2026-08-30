/**
 * ============================================================================
 *  AGENT ROLES — prompts and output parsing for each role in the pipeline
 * ============================================================================
 * Roles, and why each exists as a separate call rather than one big agent:
 *
 *   PLANNER      Decomposes the prompt into a dependency-ordered subtask list.
 *                Separate because planning wants a capable model ONCE, while
 *                execution wants cheap models MANY times. Merging them means
 *                paying planner-grade prices on every execution turn.
 *   IMPLEMENTER  Does one subtask with tools. Gets only that subtask's context,
 *                which is the whole point of decomposing: a small model with a
 *                narrow, complete context beats the same model with a wide,
 *                noisy one.
 *   VERIFIER     Independently checks the implementer's claim of success. It
 *                is a DIFFERENT call with a DIFFERENT context and no memory of
 *                the implementer's reasoning — an agent asked "are you sure?"
 *                in its own conversation almost always says yes.
 *   TIEBREAK     Third opinion when implementer and verifier disagree.
 *   COMPACTOR    Cheap summariser (see compaction.ts).
 *
 * TRIAGE: not every prompt deserves this machinery. "What does this function
 * do?" routed through plan -> execute -> verify costs three calls to answer a
 * one-call question, and cost is the heaviest term in the score. The planner
 * is therefore allowed to return a single-subtask plan, and the orchestrator
 * short-circuits verification for trivial read-only work.
 *
 * OUTPUT PARSING is defensive on purpose. Small open-weight models emit JSON
 * wrapped in prose, in fenced blocks, with trailing commas. Every parser here
 * degrades to something usable rather than throwing, because a parse failure
 * that kills a task is a self-inflicted accuracy loss.
 */

import { ChatMessage } from './providers';
import { Subtask } from './protocol';

// ---------------------------------------------------------------------------
// Shared JSON extraction
// ---------------------------------------------------------------------------

/** Pull the first balanced JSON object/array out of a model reply. */
export function extractJson(text: string): any | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text].filter(Boolean) as string[];
  for (const c of candidates) {
    const startObj = c.indexOf('{');
    const startArr = c.indexOf('[');
    const start = startArr >= 0 && (startObj < 0 || startArr < startObj) ? startArr : startObj;
    if (start < 0) continue;
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const raw = c.slice(start, i + 1).replace(/,(\s*[}\]])/g, '$1'); // tolerate trailing commas
          try {
            return JSON.parse(raw);
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export function plannerMessages(prompt: string, repoOverview: string, agentsMd: string | null): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are the planner for a multi-agent coding system. You do not write code. You break a request into ' +
        'the smallest set of subtasks that each fit comfortably in a small model\'s context.\n\n' +
        'Rules:\n' +
        '- If the request is simple enough for one agent in one pass (a question, a one-file edit, an ' +
        'explanation), return EXACTLY ONE subtask and set "trivial": true. Do not manufacture steps.\n' +
        '- Otherwise produce 2-6 subtasks. Fewer, well-scoped subtasks beat many tiny ones: each subtask ' +
        'costs a full model round-trip.\n' +
        '- DEPENDENCIES ARE A COST, NOT DOCUMENTATION. "dependsOn" defaults to EMPTY. List B as depending ' +
        'on A only if B literally cannot start until A finishes — because B reads a file A writes, or B ' +
        'builds on a decision A makes. Two subtasks that touch different files, or that are merely both ' +
        'part of the same request, are INDEPENDENT and must BOTH have "dependsOn": []. Independent ' +
        'subtasks are handed to separate agents and run at the same time, so a dependency you did not ' +
        'need makes the whole job slower for no benefit. Before you write a dependency, ask: "would this ' +
        'subtask fail if the other one had not run yet?" If no, leave dependsOn empty.\n' +
        '- A subtask may only depend on EARLIER ones — never forward, never circular.\n' +
        '- Each subtask must be independently checkable — state what "done" looks like.\n' +
        '- category: "analysis" (read/understand), "codegen" (write substantial code), "simple_edit" ' +
        '(small mechanical change), "verification" (run tests/checks).\n\n' +
        'Reply with ONLY this JSON:\n' +
        '{"trivial": boolean, "restated_goal": "one sentence", "subtasks": [' +
        '{"id":"s1","title":"short","detail":"what to do and what done looks like","category":"codegen","dependsOn":[]}]}',
    },
    ...(agentsMd ? [{ role: 'system' as const, content: agentsMd }] : []),
    { role: 'user', content: `Repository overview:\n${repoOverview}\n\n---\n\nRequest:\n${prompt}` },
  ];
}

export type Plan = { trivial: boolean; restatedGoal: string; subtasks: Subtask[] };

export function parsePlan(text: string, fallbackPrompt: string): Plan {
  const parsed = extractJson(text);
  const raw = Array.isArray(parsed?.subtasks) ? parsed.subtasks : null;

  if (!raw || raw.length === 0) {
    // Planner produced nothing parseable. Rather than fail the task, fall back
    // to treating the whole prompt as one subtask — degraded but still useful,
    // and the intervention is recorded so it is visible in the dashboard.
    return {
      trivial: true,
      restatedGoal: fallbackPrompt.slice(0, 200),
      subtasks: [
        {
          id: 's1',
          title: 'Complete the request',
          detail: fallbackPrompt,
          dependsOn: [],
          category: 'codegen',
          status: 'pending',
          attempts: 0,
          costSpent: 0,
          tokensSpent: 0,
        },
      ],
    };
  }

  const valid = new Set<string>();
  const subtasks: Subtask[] = raw.slice(0, 8).map((s: any, i: number) => {
    const id = typeof s.id === 'string' && s.id ? s.id : `s${i + 1}`;
    valid.add(id);
    const category: Subtask['category'] = ['analysis', 'codegen', 'simple_edit', 'verification'].includes(s.category)
      ? s.category
      : 'codegen';
    return {
      id,
      title: String(s.title ?? `Step ${i + 1}`).slice(0, 120),
      detail: String(s.detail ?? s.title ?? '').slice(0, 2000),
      // Drop dependencies on ids the planner invented or that come later —
      // a cyclic or forward dependency would deadlock the scheduler.
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d: any) => typeof d === 'string' && valid.has(d)) : [],
      category,
      status: 'pending',
      attempts: 0,
      costSpent: 0,
      tokensSpent: 0,
    };
  });

  return {
    trivial: parsed?.trivial === true || subtasks.length === 1,
    restatedGoal: String(parsed?.restated_goal ?? fallbackPrompt).slice(0, 400),
    subtasks,
  };
}

// ---------------------------------------------------------------------------
// Re-planner
// ---------------------------------------------------------------------------

/**
 * Asked exactly once per failed subtask, after every retry is spent.
 *
 * WHY A SEPARATE ROLE AND NOT JUST ANOTHER RETRY. The retry ladder already
 * re-runs the same subtask on a stronger model with the verifier's complaint
 * fed back in. If three of those failed, the thing that is wrong is not the
 * model — it is the subtask. Retrying a fourth time is the "blindly retrying
 * the same action" the PS explicitly penalises. This call changes the PLAN,
 * which is the only lever left.
 *
 * WHY IT IS ALLOWED TO SAY NO. A re-planner that always produces a new
 * decomposition is a re-planner that spends the remaining budget dressing the
 * same impossible subtask in new words. Making `abandon` a first-class answer,
 * and asking for a diagnosis before a decomposition, is what makes the output
 * a diagnosis rather than a paraphrase.
 */
export function replannerMessages(
  goal: string,
  failed: Subtask,
  failureReason: string,
  completed: Subtask[],
  changedFiles: string[],
  maxReplacements: number
): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are the re-planner in a multi-agent coding system. One subtask has failed every retry it was ' +
        'allowed. Decide WHY, then decide what to do about it.\n\n' +
        'It failed for one of two reasons:\n' +
        '1. It was badly scoped — too large for one agent, ambiguous, or it assumed something that was never ' +
        'established. This is fixable: replace it with smaller subtasks that route around the specific failure.\n' +
        '2. It is genuinely not achievable — a dependency that cannot be installed, a file that does not exist, ' +
        'a contradiction in the request. This is not fixable, and pretending otherwise wastes the budget the ' +
        'remaining subtasks need.\n\n' +
        'Rules:\n' +
        `- At most ${maxReplacements} replacement subtasks. Fewer is better; each one costs a full round-trip.\n` +
        '- Do NOT restate the failed subtask in different words. That exact work already failed every attempt. ' +
        'If you cannot decompose it into genuinely different steps, abandon it instead.\n' +
        '- Do not redo work listed as already completed.\n' +
        '- Each replacement must be independently checkable — state what "done" looks like.\n' +
        '- Replacements run in the order you give them, each after the previous one.\n\n' +
        'Reply with ONLY one of these two JSON shapes:\n' +
        '{"abandon":false,"diagnosis":"one sentence on why it really failed",' +
        '"subtasks":[{"title":"short","detail":"what to do and what done looks like","category":"codegen"}]}\n' +
        '{"abandon":true,"diagnosis":"one sentence on why it really failed","reason":"why no decomposition helps"}',
    },
    {
      role: 'user',
      content:
        `Overall goal: ${goal}\n\n` +
        `FAILED SUBTASK (${failed.attempts} attempts, all failed):\n${failed.title}\n${failed.detail}\n\n` +
        `Why it failed: ${failureReason}\n\n` +
        `Already completed (do not redo):\n${
          completed.length ? completed.map((s) => `- ${s.title}`).join('\n') : '- (nothing yet)'
        }\n\n` +
        `Files touched so far: ${changedFiles.join(', ') || '(none)'}\n\n` +
        'Note: any edits the failed subtask made have already been rolled back. The repository is in the state ' +
        'it was in before that subtask started.',
    },
  ];
}

export type ReplanResult =
  | { abandon: true; diagnosis: string; reason: string }
  | { abandon: false; diagnosis: string; subtasks: { title: string; detail: string; category: Subtask['category'] }[] };

/**
 * Parses the re-planner reply. Unparseable output abandons rather than
 * inventing a decomposition: a re-plan built from a hallucinated parse would
 * spend real budget on subtasks nobody asked for, whereas abandoning simply
 * leaves the original failure standing, which is the honest outcome.
 */
export function parseReplan(text: string, maxReplacements: number): ReplanResult {
  const parsed = extractJson(text);
  const diagnosis = String(parsed?.diagnosis ?? '').slice(0, 400) || 'No diagnosis given.';

  if (!parsed || parsed.abandon === true) {
    return {
      abandon: true,
      diagnosis,
      reason: String(parsed?.reason ?? (parsed ? 'Re-planner chose to abandon.' : 'Re-planner reply was not parseable JSON.')).slice(0, 400),
    };
  }

  const raw = Array.isArray(parsed.subtasks) ? parsed.subtasks : [];
  const subtasks = raw
    .filter((s: any) => s && (typeof s.title === 'string' || typeof s.detail === 'string'))
    .slice(0, maxReplacements)
    .map((s: any) => ({
      title: String(s.title ?? 'Step').slice(0, 120),
      detail: String(s.detail ?? s.title ?? '').slice(0, 2000),
      category: (['analysis', 'codegen', 'simple_edit', 'verification'].includes(s.category)
        ? s.category
        : 'codegen') as Subtask['category'],
    }));

  if (subtasks.length === 0) {
    return { abandon: true, diagnosis, reason: 'Re-planner returned no usable replacement subtasks.' };
  }
  return { abandon: false, diagnosis, subtasks };
}

// ---------------------------------------------------------------------------
// Implementer
// ---------------------------------------------------------------------------

export function implementerSystemPrompt(goal: string, subtask: Subtask, pinnedFacts: string[]): string {
  return (
    'You are an implementer agent in a multi-agent coding system. You have been given ONE subtask. ' +
    'Do that subtask and nothing else — another agent owns the rest.\n\n' +
    `Overall goal (context only): ${goal}\n` +
    `YOUR SUBTASK: ${subtask.title}\n${subtask.detail}\n\n` +
    'How to work:\n' +
    '- Call retrieve_context first to find relevant code. It returns snippets, not whole files. Reading whole ' +
    'files by default wastes budget that is strictly limited.\n' +
    '- Propose file changes with propose_edit. It shows the user a diff; they may accept only SOME blocks. ' +
    'Read the result carefully — it tells you what actually landed on disk — and continue from that reality.\n' +
    '- Verify your own work where you can: run the project\'s tests or a linter with run_command.\n' +
    '- When the subtask is complete, reply with plain text starting "DONE:" and one or two sentences on what ' +
    'you changed. If you cannot complete it, reply starting "BLOCKED:" and say precisely what stopped you.\n' +
    (pinnedFacts.length ? `\nBinding project rules:\n${pinnedFacts.map((f) => `- ${f}`).join('\n')}\n` : '')
  );
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

export function verifierMessages(goal: string, subtask: Subtask, claim: string, changedFiles: string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are an independent verifier. Another agent claims it completed a subtask. You did not see its ' +
        'reasoning and you should not assume it is correct.\n\n' +
        'Check the actual state of the repository with your read-only tools, and run the project\'s tests or ' +
        'linter with run_command if that is the fastest way to be sure.\n\n' +
        'Be concrete. "Looks fine" is not a verification. If tests exist and pass, say so. If the change is ' +
        'incomplete, syntactically broken, or does not do what the subtask asked, fail it.\n\n' +
        'Reply with ONLY this JSON:\n' +
        '{"verdict":"pass"|"fail","confidence":0.0-1.0,"reason":"one or two sentences","evidence":"what you checked"}',
    },
    {
      role: 'user',
      content:
        `Overall goal: ${goal}\n\nSubtask: ${subtask.title}\n${subtask.detail}\n\n` +
        `Implementer's claim: ${claim}\n\nFiles it reports touching: ${changedFiles.join(', ') || '(none reported)'}`,
    },
  ];
}

export type Verdict = { verdict: 'pass' | 'fail'; confidence: number; reason: string; evidence: string };

export function parseVerdict(text: string): Verdict {
  const parsed = extractJson(text);
  if (parsed && (parsed.verdict === 'pass' || parsed.verdict === 'fail')) {
    return {
      verdict: parsed.verdict,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      reason: String(parsed.reason ?? '').slice(0, 600),
      evidence: String(parsed.evidence ?? '').slice(0, 600),
    };
  }
  // Unparseable verifier output. Reading it as a pass would let broken work
  // through, which is the expensive direction to be wrong in; but reading it
  // as a hard fail burns a retry on a formatting problem. Low-confidence fail
  // is the honest middle: it triggers the tie-break rather than a blind retry.
  const looksPositive = /\b(pass|passes|passed|correct|looks good|lgtm)\b/i.test(text);
  return {
    verdict: looksPositive ? 'pass' : 'fail',
    confidence: 0.25,
    reason: `Verifier reply could not be parsed as JSON; inferred "${looksPositive ? 'pass' : 'fail'}" from its wording.`,
    evidence: text.slice(0, 400),
  };
}

// ---------------------------------------------------------------------------
// Tie-break
// ---------------------------------------------------------------------------

export function tiebreakMessages(subtask: Subtask, claim: string, verdict: Verdict): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'Two agents disagree about whether a subtask was completed correctly. You are the deciding third ' +
        'opinion, on a different model from both. Inspect the repository yourself and decide.\n\n' +
        'Do not split the difference or defer to either party. Reply with ONLY this JSON:\n' +
        '{"verdict":"pass"|"fail","reason":"why, citing what you checked"}',
    },
    {
      role: 'user',
      content:
        `Subtask: ${subtask.title}\n${subtask.detail}\n\n` +
        `Implementer says it is done: ${claim}\n\n` +
        `Verifier says ${verdict.verdict} (confidence ${verdict.confidence}): ${verdict.reason}\n` +
        `Verifier's evidence: ${verdict.evidence}`,
    },
  ];
}

export function parseTiebreak(text: string): { verdict: 'pass' | 'fail'; reason: string } {
  const parsed = extractJson(text);
  if (parsed && (parsed.verdict === 'pass' || parsed.verdict === 'fail')) {
    return { verdict: parsed.verdict, reason: String(parsed.reason ?? '').slice(0, 600) };
  }
  return { verdict: 'fail', reason: `Tie-break reply unparseable; defaulting to fail. Raw: ${text.slice(0, 300)}` };
}

// ---------------------------------------------------------------------------
// Final aggregation
// ---------------------------------------------------------------------------

export function summariserMessages(goal: string, subtasks: Subtask[], notes: string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'Summarise for the user what the system just did, in 2-5 sentences of plain prose. Mention what ' +
        'changed and anything left incomplete or rejected.\n\n' +
        'Reply with ONLY this JSON:\n' +
        '{"summary": "your 2-5 sentences of plain prose here"}',
    },
    {
      role: 'user',
      content:
        `Goal: ${goal}\n\nSubtasks:\n` +
        subtasks.map((s) => `- [${s.status}] ${s.title}${s.lastError ? ` (${s.lastError})` : ''}`).join('\n') +
        `\n\nNotes from execution:\n${notes.join('\n')}`,
    },
  ];
}
