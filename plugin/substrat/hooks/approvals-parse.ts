/**
 * The approvals mod's reading of the world (#3146): which Bash calls run the `substrat` CLI,
 * which of those pass a person's approval, and what a design gate or a refused promote
 * printed. Pure, so it is tested without a session; `approvals.tsx` wires it to the hooks.
 *
 * It reads the CLI's own words and runs the CLI's own lines. It decides nothing the CLI
 * does not: the digest, the acknowledgements a refusal needs and its `--review` token are
 * all read off what the CLI printed, and the control plane still refuses a stale token.
 */

/** One `substrat` invocation inside a Bash command: its launcher, its arguments, and the
 *  directory a `cd` earlier in the same command moved to, if one did. */
export type SubstratCall = { readonly launcher: readonly string[]; readonly args: readonly string[]; readonly cd?: string };

/** A refused promote, as the pane needs it to answer. */
export type PromoteRefusal = {
  readonly slug: string;
  readonly versionId: string;
  /** The `--ack-*` flags the refusal names, and no others. */
  readonly acks: readonly string[];
  /** The `--review` token the diffs were read with; null when the control plane gives none. */
  readonly review: string | null;
  /** What the CLI printed, from the refusal on. */
  readonly text: string;
};

const SEPARATORS = new Set(['&&', '||', ';', '|', '\n']);

/**
 * A shell command as its simple commands, each a list of words: quotes joined and removed,
 * split at `&&`, `||`, `;`, `|` and newlines. Not a shell parser: enough to find a
 * `substrat` call and its flags, which is all a tripwire needs.
 */
export function segments(command: string): string[][] {
  const out: string[][] = [[]];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  const end = () => {
    if (inWord) out[out.length - 1]!.push(word);
    word = '';
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (c === ' ' || c === '\t') {
      end();
    } else if (SEPARATORS.has(c) || (c === '&' && command[i + 1] === '&')) {
      end();
      if (c === '&' || (c === '|' && command[i + 1] === '|')) i++;
      out.push([]);
    } else {
      word += c;
      inWord = true;
    }
  }
  end();
  return out.filter((s) => s.length > 0);
}

/** `substrat`, `./node_modules/.bin/substrat`, `@substrat-run/cli`, `@substrat-run/cli@0.9`. */
function isCli(word: string): boolean {
  const base = word.slice(word.lastIndexOf('/') + 1);
  return base === 'substrat' || /^@substrat-run\/cli(@.*)?$/.test(word);
}

/** What may start a segment before the CLI: a package runner, its flags, `env` and assignments. */
const LAUNCHER_WORD = /^(npx|pnpm|npm|yarn|bunx|bun|exec|dlx|x|env|-{1,2}[\w-]+(=.*)?|[A-Za-z_][A-Za-z0-9_]*=.*)$/;

/** Every `substrat` call in a Bash command, in order. The CLI must start its segment, after
 *  nothing but launcher words (`npx`, `pnpm exec`, `env X=1`), so an `echo` or a commit message
 *  that mentions a flag is not a call. */
export function substratCalls(command: string): SubstratCall[] {
  const calls: SubstratCall[] = [];
  let cd: string | undefined;
  for (const words of segments(command)) {
    if (words[0] === 'cd' && words[1] !== undefined) {
      cd = cd !== undefined && !words[1].startsWith('/') ? `${cd}/${words[1]}` : words[1];
      continue;
    }
    const at = words.findIndex(isCli);
    if (at === -1 || !words.slice(0, at).every((w) => LAUNCHER_WORD.test(w))) continue;
    calls.push({ launcher: words.slice(0, at + 1), args: words.slice(at + 1), ...(cd !== undefined ? { cd } : {}) });
  }
  return calls;
}

/** The approval flags in one call's arguments: every `--ack-*`, and `--approve` on `plan`. */
export function approvalFlags(args: readonly string[]): string[] {
  const flags = args.filter((a) => a.startsWith('--ack-')).map((a) => a.split('=')[0]!);
  if (args[0] === 'plan' && args.some((a) => a === '--approve' || a.startsWith('--approve='))) flags.unshift('--approve');
  return [...new Set(flags)];
}

/** Why the agent may not run this command, or undefined when it may. */
export function refusalFor(command: string): string | undefined {
  const flags = substratCalls(command).flatMap((c) => approvalFlags(c.args));
  if (flags.length === 0) return undefined;
  return (
    `${flags.join(', ')} ${flags.length === 1 ? 'is' : 'are'} the person's approval, not yours. ` +
    'The Substrat approvals pane shows what is being approved, with a button only they can press. ' +
    'Run the same command without the approval flags so the pane has it to show, then ask them to approve it there.'
  );
}

/** Flags of `substrat plan` that take a value, so the directory is not mistaken for one. */
const PLAN_VALUED = new Set(['--base', '--why', '--by', '--approve']);

/** The arguments that re-render a design gate the agent asked for: its directory and base,
 *  never `--json` (the pane shows the Markdown) and never an approval. */
export function planArgs(args: readonly string[]): string[] | undefined {
  if (args[0] !== 'plan') return undefined;
  const out = ['plan'];
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (PLAN_VALUED.has(a)) {
      if (a === '--base' && args[i + 1] !== undefined) out.push(a, args[i + 1]!);
      i++;
    } else if (a.startsWith('--base=')) {
      out.push(a);
    } else if (!a.startsWith('-')) {
      out.push(a);
    }
  }
  return out;
}

/** The digest a rendered concept delta names (`Digest \`…\``), or undefined for an empty one. */
export function digestIn(markdown: string): string | undefined {
  if (markdown.includes('_Nothing to approve')) return undefined;
  return /Digest `([0-9a-f]+)`/.exec(markdown)?.[1];
}

/** What both digest refusals say; the export-break refusal names its own flag. */
const NEEDS_ACK = 'acknowledge it explicitly';

const unquote = (s: string) => s.replace(/^["'`]|["'`.,;]+$/g, '');

/**
 * A promote the control plane refused for want of a person's acknowledgement, read off the
 * call that asked for it and what the CLI printed. Undefined for anything else: a promote
 * that went through, one refused for another reason, or a call that was not a promote.
 */
export function promoteRefusalIn(call: SubstratCall, printed: string): PromoteRefusal | undefined {
  const { args } = call;
  const isPromote = args[0] === 'promote' || (args[0] === 'push' && args.includes('--promote'));
  if (!isPromote) return undefined;
  const exportBreak = printed.includes('re-run with --ack-export-break');
  if (!printed.includes(NEEDS_ACK) && !exportBreak && !printed.includes('and --review ')) return undefined;

  const acks: string[] = [];
  if (printed.includes('changes the permission surface')) acks.push('--ack-permissions');
  if (printed.includes('changes migrations')) acks.push('--ack-migrations');
  if (exportBreak) acks.push('--ack-export-break');

  // The version: the diffs' header names it; else the promote's own `--version`; else the push.
  const versionId =
    /; promoting (\S+)\./.exec(printed)?.[1] ??
    (args[0] === 'promote' ? args[args.indexOf('--version') + 1] : undefined) ??
    /version (\S+) \(/.exec(printed)?.[1];
  const slug = args[0] === 'promote' && args[1] && !args[1].startsWith('-') ? args[1] : /✓ pushed (\S+?)\. version/.exec(printed)?.[1];
  if (!versionId || !slug) return undefined;

  const token = /and --review (\S+)/.exec(printed)?.[1];
  const from = printed.indexOf('promote failed');
  return {
    slug: unquote(slug),
    versionId: unquote(versionId),
    acks,
    review: token ? unquote(token) : null,
    text: (from === -1 ? printed : printed.slice(from)).trim(),
  };
}

/** The line the person's acknowledgement runs: exactly the flags the refusal named, and its token. */
export function promoteArgs(r: PromoteRefusal): string[] {
  return ['promote', r.slug, '--version', r.versionId, ...r.acks, ...(r.review ? ['--review', r.review] : [])];
}

/** The line the person's design-gate approval runs. */
export function approveArgs(plan: readonly string[], digest: string, by: string, why: string): string[] {
  return [...plan, '--approve', digest, '--by', by, '--why', why];
}

/** Where a call runs: the session's directory, moved by a `cd` in the same command. */
export function cwdFor(sessionCwd: string, cd: string | undefined): string {
  if (cd === undefined) return sessionCwd;
  return cd.startsWith('/') ? cd : `${sessionCwd.replace(/\/$/, '')}/${cd}`;
}
