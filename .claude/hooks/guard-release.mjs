#!/usr/bin/env node
// PreToolUse hook (Bash): make Claude Code ask before anything that changes the public site or
// rewrites shared history. Pushing to `main` deploys production on Vercel, so it counts as a release.
//
// Asks for:
//   - git push that targets main (explicitly, or implicitly from the main branch)
//   - git push with --force / --force-with-lease / -f / a +refspec
//   - vercel --prod / --target production, and vercel promote / rollback / alias / remove / rm
//
// Permission rules only match command text as written (`git -c x push` slips past `Bash(git push *)`),
// so this reads the whole command. It never blocks on its own: "ask" puts the call in front of a human,
// including in auto mode. On any internal error it stays silent and lets the normal permission flow decide.

import { execFileSync } from 'node:child_process';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

/**
 * Minimal shell lexer: splits into simple commands on && || ; | & and newlines outside quotes, and each
 * command into words with quotes and backslashes resolved. Not a full shell parser, but it keeps
 * `-c 'a b c'` as one word, so `git -c 'x=y z' push` and `sh -c '…'` read correctly.
 */
function commands(src) {
  const out = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote = '';
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < src.length) word += src[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < src.length) {
      word += src[++i];
      inWord = true;
    } else if (/\s/.test(c) && c !== '\n') {
      endWord();
    } else if (c === '\n' || c === ';' || c === '&' || c === '|') {
      endCommand();
      if ((c === '&' || c === '|') && src[i + 1] === c) i++;
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return out;
}

const WRAPPERS = new Set(['sudo', 'env', 'command', 'builtin', 'nohup', 'nice', 'time', 'noglob', 'stdbuf', 'xargs', 'exec']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

/** The words of the program actually being run, after VAR=x prefixes and wrappers like `timeout 60`. */
function program(t) {
  let i = 0;
  while (i < t.length) {
    const w = t[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w)) i++;
    else if (w === 'timeout') i += 2;
    else break;
  }
  return t.slice(i);
}

const named = (w, name) => w === name || w.endsWith('/' + name);

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function gitPushReason(t, cwd) {
  if (!t.length || !named(t[0], 'git')) return null;
  // `push` is the first non-option word after git's own options (`-c key=val`, `-C dir` take a value)
  let push = 1;
  while (push < t.length && t[push].startsWith('-')) push += ['-c', '-C', '--git-dir', '--work-tree', '--namespace'].includes(t[push]) ? 2 : 1;
  if (t[push] !== 'push') return null;
  const args = t.slice(push + 1);
  if (args.some((a) => a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || a.startsWith('+'))) {
    return 'force-push rewrites history on GitHub';
  }
  const positional = args.filter((a) => !a.startsWith('-'));
  const refs = positional.slice(1); // first positional is the remote
  const hitsMain = (r) => /(^|:|\/)(main|master)$/.test(r) || r === 'HEAD:main';
  if (refs.some(hitsMain) || args.includes('--all') || args.includes('--mirror')) {
    return 'pushing main deploys the public site (Vercel production)';
  }
  if (refs.length === 0 && ['main', 'master'].includes(currentBranch(cwd))) {
    return 'pushing from main deploys the public site (Vercel production)';
  }
  return null;
}

function vercelReason(t) {
  // also `npx vercel …`
  const v = named(t[0] ?? '', 'vercel') ? 0 : t[0] === 'npx' && named(t[1] ?? '', 'vercel') ? 1 : -1;
  if (v < 0) return null;
  const args = t.slice(v + 1);
  if (args.includes('--prod') || args.includes('--production') || args.some((a, i) => a === '--target=production' || (a === '--target' && args[i + 1] === 'production'))) {
    return 'vercel production deploy';
  }
  const sub = args.find((a) => !a.startsWith('-'));
  if (['promote', 'rollback', 'alias', 'remove', 'rm'].includes(sub)) return `vercel ${sub} changes what the public site serves`;
  return null;
}

/** Reasons to ask, for every simple command in `src`, recursing into `sh -c '…'`. */
function reasonsFor(src, cwd, depth = 0) {
  const found = [];
  for (const words of commands(src)) {
    const t = program(words);
    if (t.length > 2 && SHELLS.has(t[0].split('/').pop()) && t[1] === '-c') {
      if (depth < 3) found.push(...reasonsFor(t[2], cwd, depth + 1));
      continue;
    }
    const r = gitPushReason(t, cwd) ?? vercelReason(t);
    if (r) found.push(r);
  }
  return found;
}

try {
  const input = JSON.parse(await readStdin());
  const command = String(input?.tool_input?.command ?? '');
  const cwd = input?.cwd || process.cwd();
  const reasons = reasonsFor(command, cwd);
  if (reasons.length) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `Release guard: ${reasons[0]}. Confirm only if the owner asked for it.`,
        },
      }),
    );
  }
} catch (e) {
  process.stderr.write(`guard-release: ${e?.message ?? e}\n`);
}
process.exit(0);
