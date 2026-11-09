#!/usr/bin/env node
// One Claude Code session, as a person runs it: the claude_code system prompt and tools, auto
// mode, no CLAUDE.md, plugins, hooks or MCP from this machine (settingSources: []), and the
// subscription login rather than an API key. Usage is counted the way apps/builder/src/claude-code.ts
// counts it (one step per request id, input = uncached + cache reads + cache writes), so the ledger's
// cost estimate applies unchanged. Subagent requests are counted too.
//
//   node run-agent.mjs --cwd <dir> --prompt <file> --out <dir> [--model sonnet] [--max-turns 300] [--minutes 60]
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { denied, guard, GUARD_VERSION } from './guard.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i === -1 ? d : process.argv[i + 1];
};
const cwd = arg('cwd');
const out = arg('out');
const model = arg('model', 'sonnet');
const maxTurns = Number(arg('max-turns', 300));
const minutes = Number(arg('minutes', 60));
const prompt = readFileSync(arg('prompt'), 'utf8');
mkdirSync(cwd, { recursive: true });
mkdirSync(out, { recursive: true });

const { ANTHROPIC_API_KEY: _key, CLAUDECODE: _cc, ...env } = process.env;
const log = createWriteStream(`${out}/transcript.jsonl`);
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), minutes * 60_000);
const hook = guard(cwd, String(arg('allow', '')).split(':').filter(Boolean));

const stepUsage = [];
const seen = new Map();
let subSteps = 0;
let result = null;
let error = null;
const started = Date.now();
try {
  for await (const msg of query({
    prompt,
    options: {
      model,
      cwd,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      // Auto mode: Claude Code's own classifier approves or refuses each action, as for a person
      // who lets it run unattended. The guard below refuses what would harm other sessions.
      permissionMode: 'auto',
      persistSession: false,
      maxTurns,
      abortController: abort,
      env,
      hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [hook] }] },
    },
  })) {
    log.write(JSON.stringify(msg) + '\n');
    if (msg.type === 'assistant') {
      const u = msg.message.usage;
      const at = seen.get(msg.message.id);
      if (at !== undefined) {
        stepUsage[at].outputTokens = Math.max(stepUsage[at].outputTokens, u.output_tokens);
      } else {
        seen.set(msg.message.id, stepUsage.length);
        if (msg.parent_tool_use_id !== null) subSteps += 1;
        stepUsage.push({
          inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens,
          cachedInputTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        });
      }
    }
    if (msg.type === 'result') result = msg;
  }
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
}
clearTimeout(timer);
const durationMs = Date.now() - started;
const sum = (k) => stepUsage.reduce((n, s) => n + s[k], 0);
const usage = {
  steps: stepUsage.length,
  inputTokens: sum('inputTokens'),
  cachedInputTokens: sum('cachedInputTokens'),
  cacheWriteTokens: sum('cacheWriteTokens'),
  outputTokens: Math.max(sum('outputTokens'), result?.usage?.output_tokens ?? 0),
  stepUsage,
};
const report = {
  results: [
    {
      eval: 'todo',
      passed: null,
      turns: result?.num_turns ?? null,
      repairs: null,
      questions: 0,
      usage,
      subagentSteps: subSteps,
      stages: {
        build: {
          durationMs,
          gateMs: 0,
          steps: usage.steps,
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
        },
      },
      result: result && {
        subtype: result.subtype,
        isError: result.is_error,
        numTurns: result.num_turns,
        durationMs: result.duration_ms,
        reportedCostUsd: result.total_cost_usd,
        text: typeof result.result === 'string' ? result.result.slice(0, 4000) : null,
      },
      aborted: abort.signal.aborted,
      error,
      denied,
      guardVersion: GUARD_VERSION,
    },
  ],
};
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));

// Stop anything the session left running in its folder (servers started in the background).
try {
  const lines = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { maxBuffer: 64 << 20 }).toString().split('\n');
  let pid = 0;
  for (const l of lines) {
    if (l.startsWith('p')) pid = Number(l.slice(1));
    else if (l.startsWith('n') && (l.slice(1) === cwd || l.slice(1).startsWith(cwd + '/')) && pid !== process.pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
  }
} catch {}
console.log(JSON.stringify({ out, seconds: Math.round(durationMs / 1000), steps: usage.steps, subSteps, turns: result?.num_turns, subtype: result?.subtype, error, denied: denied.length }));
process.exit(0);
