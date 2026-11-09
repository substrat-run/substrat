// A PreToolUse hook for the plain-Claude runs and the tester. This machine is shared with other
// sessions and their servers (port 3000 is taken), so a run may not kill what it did not start,
// install globally, or write outside its own folder. Everything else is allowed: the arm is
// "Claude Code with every permission", and this only keeps it from harming its neighbours.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

const KILLERS = [
  /\b(pkill|killall|kill-port)\b/,
  /\bfuser\b[^\n]*-k/,
  /\blsof\b[^\n]*\|\s*(xargs\s+)?(-\S+\s+)*kill\b/,
  // `kill $(cat server.pid)` is a process the run started; a lookup by port or name is not.
  /\bkill\b[^\n;&|]*(\$\(|`)[^)`]*\b(lsof|fuser|pgrep|ps|netstat|ss)\b/,
  /\bkill\s+(-\S+\s+)*-1\b/,
];
const GLOBAL = /\b(npm|pnpm|yarn)\s+(i|install|add)\b[^\n]*\s(-g|--global)\b|\bbrew\s+install\b|\bsudo\b/;

function parentOf(pid) {
  try {
    return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim());
  } catch {
    return 0;
  }
}

function cwdOf(pid) {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).toString();
    return out.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '';
  } catch {
    return '';
  }
}

/**
 * True when `pid` descends from this harness, or works in the run's folder: a server a run starts
 * with `&` outlives the shell that started it and is re-parented, but keeps the folder it ran in.
 */
function ours(pid, cwd) {
  let p = pid;
  for (let i = 0; i < 64 && p > 1; i++) {
    if (p === process.pid) return true;
    p = parentOf(p);
  }
  const c = real(cwdOf(pid));
  return !!c && (c === real(cwd) || c.startsWith(real(cwd) + '/'));
}

/** A heredoc's body is file content, not a command: `cat > test.js <<'EOF' … EOF`. */
const withoutHeredocs = (c) => c.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, '<<heredoc');

export const GUARD_VERSION = 4;
export const denied = [];

// A plain run must not read Substrat, which sits next to it on this machine: an absolute path into
// the home folders or the sessions' scratch tree (/tmp/claude-<uid>) is refused unless it is inside the
// run's own folder (or a prefix the caller allows, such as a cached browser), and so is climbing
// out with `../..`. Other temp paths are the run's own scratch and stay allowed.
// Where /tmp really is (a link on macOS, so a path may name it either way), and where homes live.
const TMP = '/tmp';
const TMP_REAL = (() => {
  try {
    return realpathSync(TMP);
  } catch {
    return TMP;
  }
})();
const SESSIONS = `${TMP_REAL}/claude-${process.getuid()}`;
const HOMES = dirname(homedir()) === '/' ? homedir() : dirname(homedir());
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TMP_PREFIX = TMP_REAL.endsWith(TMP) && TMP_REAL !== TMP ? `(?:${esc(TMP_REAL.slice(0, -TMP.length))})?` : '';
const ABSOLUTE = new RegExp(`(?:^|[\\s'"=:(])(${TMP_PREFIX}${esc(TMP)}\\/claude-\\d+[^\\s'"\`;|&)<>]*|${esc(HOMES)}\\/[^\\s'"\`;|&)<>]*)`, 'g');
const CLIMB = /\.\.\/\.\.|(?:^|[\s;&|(])cd\s+\.\.(?:\s|$|\/|;)/;
const real = (p) => (p.startsWith(TMP_REAL + '/') ? TMP + p.slice(TMP_REAL.length) : p);

export function guard(cwd, extra = []) {
  // Claude Code gives every session a scratch folder named after its working folder; that one is the run's own.
  const scratch = `${SESSIONS}/${cwd.replace(/\//g, '-')}`;
  const under = (p, roots) => {
    const r = real(p);
    return roots.some((root) => r === real(root) || r.startsWith(real(root) + '/'));
  };
  const inside = (p) => under(p, [cwd, scratch, ...extra]);
  const deny = (why, what) => {
    denied.push({ at: new Date().toISOString(), what: String(what).slice(0, 300), why });
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } };
  };
  return async (input) => {
    const tool = input.tool_name;
    const x = input.tool_input ?? {};
    if (tool === 'Bash') {
      const c = withoutHeredocs(String(x.command ?? ''));
      if (KILLERS.some((re) => re.test(c)) || (/\blsof\b[^\n]*\s-\w*t/.test(c) && /\bkill\b/.test(c))) {
        return deny('This machine is shared with other people\'s servers: pkill, killall, kill-port and killing by port are not available. Stop a process you started by its PID, or use another port.', c);
      }
      if (GLOBAL.test(c)) return deny('Global installs and sudo are not available here. Install into the project instead.', c);
      for (const m of c.matchAll(ABSOLUTE)) {
        if (!inside(m[1])) return deny(`Stay inside ${cwd}: other folders on this machine belong to other work.`, c);
      }
      if (CLIMB.test(c)) return deny(`Stay inside ${cwd}: other folders on this machine belong to other work.`, c);
      for (const m of c.matchAll(/\bkill\s+((?:-\S+\s+)*)(\d[\d\s]*)/g)) {
        for (const pid of m[2].trim().split(/\s+/).map(Number)) {
          if (pid >= 1 && !ours(pid, cwd)) return deny(`Process ${pid} was not started by this session, and this machine is shared. Use another port.`, c);
        }
      }
    }
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
      const f = String(x.file_path ?? x.notebook_path ?? '');
      const abs = isAbsolute(f) ? f : resolve(cwd, f);
      if (!under(abs, [cwd, scratch])) return deny(`Write inside ${cwd} only.`, f);
    }
    if (['Read', 'Glob', 'Grep', 'LS'].includes(tool)) {
      const f = String(x.file_path ?? x.path ?? '');
      if (f && !inside(isAbsolute(f) ? f : resolve(cwd, f))) return deny(`Stay inside ${cwd}: other folders on this machine belong to other work.`, f);
    }
    return {};
  };
}
