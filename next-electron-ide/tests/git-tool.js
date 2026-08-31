/**
 * The `git` tool's read-only gate (orchestrator/tools.ts).
 *
 *   npm run build:orchestrator && node tests/git-tool.js
 *
 * PS constraint #8: the agent may run git autonomously, but "any side-effect
 * action (write/delete file, git push, install, state-changing terminal cmd)
 * needs human approval". So the `git` tool runs genuinely read-only
 * subcommands directly and refuses anything that writes to the repo, pointing
 * the agent at the approval-gated `run_command` instead.
 *
 * The subtle case this pins: `git branch` LISTS branches (read-only) but
 * `git branch <name>` CREATES one and `git branch -d <name>` deletes one —
 * both write to `.git/refs`. The subcommand name alone ("branch") is on the
 * allow-list, so the gate has to inspect the arguments too.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const { findTool } = require(path.join(__dirname, '..', 'orchestrator-dist', 'tools'));

let pass = 0;
let fail = 0;
const ok = (name) => { console.log('  ok  ', name); pass++; };
const bad = (name, msg) => { console.log('  FAIL', name, '\n       ', msg); fail++; };

async function main() {
  const git = findTool('git');
  assert.ok(git, 'no `git` tool in the registry');
  assert.strictEqual(git.sideEffecting, false, 'the git tool must not be side-effecting — the write path is run_command');

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nexide-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo }).toString();
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  g('add', '-A');
  g('commit', '-qm', 'init');

  const ctx = { rootPath: repo };
  const call = (args) => git.run({ args }, ctx);
  const refused = (r) => /run_command|approval|changes.*state|creates or changes/i.test(r.content);

  try {
    console.log('\n== read-only subcommands run directly ==');
    for (const args of [
      ['status', '--porcelain'], ['log', '--oneline', '-n', '1'], ['diff'],
      ['branch'], ['branch', '--list'], ['rev-parse', 'HEAD'], ['show', '--stat', 'HEAD'],
    ]) {
      const r = await call(args);
      if (refused(r)) { bad(`git ${args.join(' ')} runs`, r.content); }
      else ok(`git ${args.join(' ')}`);
    }

    console.log('\n== state-changing subcommands are refused ==');
    for (const args of [
      ['commit', '-m', 'x'], ['push'], ['merge', 'other'], ['checkout', '-b', 'feature'],
      ['reset', '--hard'], ['add', '-A'], ['rm', 'a.txt'], ['stash'],
    ]) {
      const r = await call(args);
      if (refused(r)) ok(`git ${args.join(' ')} refused`);
      else bad(`git ${args.join(' ')} refused`, r.content);
    }

    console.log('\n== `git branch` that writes to refs is refused; `branch` that reads is not ==');
    for (const [label, args] of [
      ['create', ['branch', 'new-feature']],
      ['delete', ['branch', '-D', 'main']],
      ['rename', ['branch', '-m', 'renamed']],
    ]) {
      const r = await call(args);
      if (refused(r)) ok(`git branch ${label} (${args.join(' ')}) refused`);
      else bad(`git branch ${label} refused`, r.content);
    }

    const branches = g('branch', '--format=%(refname:short)').trim().split('\n');
    if (branches.includes('new-feature')) bad('refusal held', 'a branch was created despite the refusal');
    else ok('the refusal held — no branch was actually created on disk');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
