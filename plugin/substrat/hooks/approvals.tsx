/**
 * The approvals mod (#3146): the design gate and the promote checkpoints, approved by the
 * person in a pane instead of by flags the agent types.
 *
 * In Claude Desktop the agent runs the `substrat` CLI, so `plan --approve` and `--ack-*` were
 * typed by the agent, held back only by the skills' prose. Here:
 *
 *   - a Bash call that passes one of those flags is refused, with the reason;
 *   - a `substrat plan`, or a promote refused for want of an acknowledgement, opens the
 *     approvals pane with what the CLI printed;
 *   - the pane's buttons run the exact CLI line (the digest shown, or the flags the refusal
 *     named and its `--review` token), and hand the outcome back to the agent.
 *
 * A tripwire, not a boundary: the agent could still script around it. What holds is the
 * control plane's review token (#2333) and CI. Without mods the plugin works as before.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine } from 'claude-code'
import type { Register } from 'claude-code'

import type { Launch } from '../types'
import {
  approveArgs,
  cwdFor,
  digestIn,
  planArgs,
  promoteArgs,
  promoteRefusalIn,
  refusalFor,
  substratCalls,
} from './approvals-parse'

const PANE = 'substrat-approvals'
const TITLE = 'Substrat approvals'

// Change a tag when its value's fields change: it declines what an earlier version stored.
const plan = atom({ plugin: 'substrat', key: 'plan' } as const, null, { shape: 'plan-1' })
const promote = atom({ plugin: 'substrat', key: 'promote' } as const, null, { shape: 'promote-1' })

/** A CLI run can wait on the control plane; a promote applies migrations. */
const RUN_MS = 300_000

const IDLE = { kind: 'idle' } as const
const RUNNING = { kind: 'running' } as const
const failed = (message: string) => ({ kind: 'failed', message }) as const
const outputOf = (r: { stdout: string; stderr: string }) => [r.stdout, r.stderr].filter(s => s.trim()).join('\n').trim()
const tail = (text: string, lines = 12) => text.split('\n').slice(-lines).join('\n')

/** Shows a design gate: kept who and why if it is the same gate, then rendered fresh. */
async function showPlan($: Engine, launch: Launch, args: string[]) {
  const before = await read($, plan)
  const same = before !== null && before.plan.join(' ') === args.join(' ') && before.launch.cwd === launch.cwd
  const by = same ? before.by : await gitName($, launch.cwd)
  await update($, plan, () => ({
    launch,
    plan: args,
    markdown: null,
    digest: null,
    by,
    why: same ? before.why : '',
    status: IDLE,
  }))
  void $.ui.open({ id: PANE, title: TITLE })
  await renderPlan($)
}

async function gitName($: Engine, cwd: string) {
  try {
    const r = await $.process.run(['git', 'config', 'user.name'], { cwd })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

/** Runs `substrat plan` as the agent did, so what the person reads is the CLI's own output. */
async function renderPlan($: Engine) {
  const p = await read($, plan)
  if (!p) return
  try {
    const r = await $.process.run([...p.launch.launcher, ...p.plan], { cwd: p.launch.cwd, timeoutMs: RUN_MS })
    await update($, plan, cur =>
      cur === null
        ? null
        : r.exitCode === 0
          ? { ...cur, markdown: r.stdout, digest: digestIn(r.stdout) ?? null, status: IDLE }
          : { ...cur, status: failed(outputOf(r) || `substrat plan exited ${r.exitCode}`) },
    )
  } catch (err) {
    await update($, plan, cur => (cur === null ? null : { ...cur, status: failed(String(err)) }))
  }
}

async function approvePlan($: Engine) {
  const p = await read($, plan)
  if (!p?.digest || !p.by.trim() || !p.why.trim()) return
  await update($, plan, cur => (cur === null ? null : { ...cur, status: RUNNING }))
  try {
    const r = await $.process.run([...p.launch.launcher, ...approveArgs(p.plan, p.digest, p.by.trim(), p.why.trim())], {
      cwd: p.launch.cwd,
      timeoutMs: RUN_MS,
    })
    if (r.exitCode !== 0) {
      await update($, plan, cur => (cur === null ? null : { ...cur, status: failed(outputOf(r)) }))
      // The delta moved since it was shown: show the new one, never approve it unseen.
      if (/the delta is now/.test(r.stderr)) await renderPlan($)
      return
    }
    await update($, plan, () => null)
    $.ui.toast('Design gate approved')
    void $.prompt.submit({
      text: `I approved the design gate in the Substrat approvals pane (digest ${p.digest}, because: ${p.why.trim()}).\n\n${tail(outputOf(r))}`,
    })
  } catch (err) {
    await update($, plan, cur => (cur === null ? null : { ...cur, status: failed(String(err)) }))
  }
}

async function acknowledge($: Engine) {
  const p = await read($, promote)
  if (!p) return
  await update($, promote, cur => (cur === null ? null : { ...cur, status: RUNNING }))
  const args = promoteArgs(p)
  try {
    const r = await $.process.run([...p.launch.launcher, ...args], { cwd: p.launch.cwd, timeoutMs: RUN_MS })
    if (r.exitCode === 0) {
      await update($, promote, () => null)
      $.ui.toast(`${p.slug} promoted`)
      void $.prompt.submit({
        text: `I acknowledged ${p.acks.join(', ')} and promoted ${p.slug} ${p.versionId} in the Substrat approvals pane.\n\n${tail(outputOf(r))}`,
      })
      return
    }
    // Prod moved since the diffs were read: the refusal prints the new review. Show that one.
    const again = promoteRefusalIn({ launcher: p.launch.launcher, args }, outputOf(r))
    await update($, promote, cur =>
      cur === null
        ? null
        : again
          ? { ...again, launch: cur.launch, status: failed('What prod serves changed since this was shown. This is the review as it stands now.') }
          : { ...cur, status: failed(outputOf(r)) },
    )
  } catch (err) {
    await update($, promote, cur => (cur === null ? null : { ...cur, status: failed(String(err)) }))
  }
}

export const register: Register = (on, options) => {
  // `/config` → Approvals pane: off leaves the plugin as it was before the mod, skills and all.
  if (options.approvals === false) return

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: PANE, description: 'Show what is waiting for your approval in this Substrat vertical' })

    return next(e)
  })

  on('command.run', { command: PANE }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Substrat approvals pane opened.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const calls = substratCalls(e.command)
    if (calls.length === 0) return next(e)

    const sessionCwd = await $.session.cwd()
    // A design gate is shown even when the call is refused: it is the delta the agent wanted
    // approved, and the pane is where that happens now. After the agent's own run otherwise,
    // so the pane's run of `substrat plan` does not hold up the agent's.
    const showPlans = async () => {
      for (const call of calls) {
        const args = planArgs(call.args)
        if (args) await showPlan($, { launcher: call.launcher, cwd: cwdFor(sessionCwd, call.cd) }, args)
      }
    }

    const deny = refusalFor(e.command)
    if (deny) {
      await showPlans()
      return { deny }
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    await showPlans()
    for (const call of calls) {
      const refusal = promoteRefusalIn(call, ran.text ?? '')
      if (!refusal) continue
      const launch = { launcher: call.launcher, cwd: cwdFor(sessionCwd, call.cd) }
      await update($, promote, () => ({ ...refusal, launch, status: IDLE }))
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return ran
  }).catch(($, e, next) => (next.called ? next(e) : refusalFor(e.command) ? { deny: refusalFor(e.command)! } : next(e)))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e)
    const p = await read($, plan)
    const q = await read($, promote)

    if (p === null && q === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Nothing is waiting for your approval.</Text>
          <Text dimColor>A design gate or a refused promote shows here when Claude runs one.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {q !== null && (
          <Box flexDirection="column" gap={1}>
            <Text bold>
              Promote {q.slug} {q.versionId}
            </Text>
            <Text>
              Production refused this promote until you have read what changes. Acknowledging runs{' '}
              {q.acks.join(' ')}
              {q.review ? ' for exactly the review below.' : '.'}
            </Text>
            <Markdown text={'```text\n' + q.text + '\n```'} />
            {q.status.kind === 'failed' && <Text color="error">{q.status.message}</Text>}
            {q.status.kind === 'running' ? (
              <Text dimColor>Promoting…</Text>
            ) : (
              <Box gap={1}>
                <Button key="promote-ack" variant="primary" label="Acknowledge and promote" onPress={() => void acknowledge($)} />
                <Button key="promote-dismiss" label="Not now" onPress={() => void update($, promote, () => null)} />
              </Box>
            )}
          </Box>
        )}
        {p !== null && (
          <Box flexDirection="column" gap={1}>
            <Text bold>Design gate</Text>
            {p.markdown === null && p.status.kind !== 'failed' && <Text dimColor>Running substrat plan…</Text>}
            {p.markdown !== null && <Markdown text={p.markdown} />}
            {p.status.kind === 'failed' && <Text color="error">{p.status.message}</Text>}
            {p.markdown !== null && p.digest === null && <Text dimColor>Nothing to approve: the model is unchanged.</Text>}
            {p.digest !== null && p.status.kind !== 'running' && (
              <Box flexDirection="column" gap={1}>
                <Input
                  key="plan-by"
                  label="Approved by"
                  value={p.by}
                  onInput={v => void update($, plan, cur => (cur === null ? null : { ...cur, by: v }))}
                  onSubmit={v => void update($, plan, cur => (cur === null ? null : { ...cur, by: v }))}
                />
                <Input
                  key="plan-why"
                  label="Why"
                  placeholder="The reason, in your words"
                  value={p.why}
                  onInput={v => void update($, plan, cur => (cur === null ? null : { ...cur, why: v }))}
                  onSubmit={v => void update($, plan, cur => (cur === null ? null : { ...cur, why: v }))}
                />
                <Box gap={1}>
                  <Button
                    key="plan-approve"
                    variant="primary"
                    label={p.by.trim() && p.why.trim() ? 'Approve' : 'Approve (fill in who and why)'}
                    onPress={() => void approvePlan($)}
                  />
                  <Button key="plan-refresh" label="Refresh" onPress={() => void renderPlan($)} />
                  <Button key="plan-dismiss" label="Not now" onPress={() => void update($, plan, () => null)} />
                </Box>
              </Box>
            )}
            {p.status.kind === 'running' && <Text dimColor>Approving…</Text>}
          </Box>
        )}
      </Box>
    )
  })

  // While something waits and the pane may be closed, one line above the prompt says so.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, plan)
    const q = await read($, promote)
    const waiting = q !== null ? `promote of ${q.slug} waits for your acknowledgement` : p?.digest ? 'a design gate waits for your approval' : null
    if (waiting === null || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box gap={1}>
        <Text>Substrat: {waiting}</Text>
        <Button key="open-approvals" label="Open" onPress={() => void $.ui.open({ id: PANE, title: TITLE })} />
      </Box>
    )
  })
}
