import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { changesIn, promoteRefusalIn, refusalFor, substratCalls, waitingPromoteIn } from './approvals-parse'

const PANE = {
  plugin: 'substrat',
  component: 'Pane',
  requestId: 'substrat-approvals',
  props: {
    title: 'Substrat approvals',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** What a refused `substrat push --promote prod` prints, as `promote.ts` writes it. */
const REFUSED = [
  '✓ pushed acme. version 01JX9ZV3Q8 (1.4.0) is admitted; deploymentRef=acme-01jx9zv3q8',
  '  no data loss',
  'promote failed (409): promotion changes the permission surface (a1 → b2) — acknowledge it explicitly to promote; promotion changes migrations (c3 → d4) — acknowledge it explicitly to promote',
  '',
  'prod serves 01JX9ZV0AA; promoting 01JX9ZV3Q8.',
  '',
  'permission changes:',
  '  + invoice:void → admin',
  '',
  'migration changes:',
  '  0007 add column invoices.voided_at',
  '',
  `to acknowledge exactly what is shown above, re-run with the --ack-* flags it needs and --review 01JX9ZV0AA:${'e'.repeat(64)}`,
].join('\n')

const DELTA = '# Concept delta — acme\n\nAgainst `origin/main` (the merge-base with HEAD). Digest `0a1b2c3d4e5f`.\n\n+ entity Invoice gains `voidedAt`\n'

/** The engine beneath the plugin: every CLI run is recorded and answered by `cli`. */
function engine(on: On, cli: (argv: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string }) {
  const runs: string[][] = []
  const prompts: string[] = []
  on('command.register', () => ({ value: { command: 'substrat-approvals' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/acme' }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    const r = e.argv[0] === 'git' ? { exitCode: 0, stdout: 'Ada Lovelace\n' } : cli(e.argv)
    return { value: { stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...r } }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  return { runs, prompts }
}

describe('the guard', () => {
  for (const [command, flag] of [
    ['npx substrat plan --approve 0a1b2c3d4e5f --by Ada --why "ok"', '--approve'],
    ['cd demos/acme && substrat push --promote prod --ack-migrations', '--ack-migrations'],
    ['pnpm exec substrat promote acme --version 01J --ack-permissions --review x:y', '--ack-permissions'],
    ['npx @substrat-run/cli scope rebind s1 --to other --ack-migrations=1', '--ack-migrations'],
  ] as const) {
    test(`refuses ${command}`, () => {
      expect(refusalFor(command)).toContain(flag)
    })
  }

  for (const command of [
    'substrat push --promote prod',
    'npx substrat plan --why "add invoices"',
    'git commit -m "substrat: document --ack-migrations"',
    'echo substrat --ack-migrations is the person\'s',
  ]) {
    test(`lets ${command} through`, () => {
      expect(refusalFor(command)).toBeUndefined()
    })
  }

  test('the refusal reaches the agent and the delta it wanted approved reaches the pane', async ($, on) => {
    const { runs } = engine(on, () => ({ exitCode: 0, stdout: DELTA }))
    on('tool.call', () => ({ result: {}, text: 'ran' }))
    await $.session.start({ cwd: '/work/acme', surface: 'desktop', isInteractive: true })

    const ran = await $.tool.call({ tool: 'Bash', command: 'npx substrat plan --approve 0a1b2c3d4e5f --by me --why because' })

    expect(ran.deny).toContain('--approve')
    // The pane rendered the gate itself, never with the approval the agent asked for.
    expect(runs).toContainEqual(['npx', 'substrat', 'plan'])
    expect(runs.flat()).not.toContain('--approve')
  })

  test('turned off in /config, the guard lets the agent through', { options: { approvals: false } }, async ($, on) => {
    on('tool.call', () => ({ result: {}, text: 'ran' }))
    const ran = await $.tool.call({ tool: 'Bash', command: 'substrat push --promote prod --ack-migrations' })
    expect(ran.deny).toBeUndefined()
  })
})

describe('the design gate', () => {
  test('approving in the pane runs the shown digest with who and why, then tells the agent', async ($, on) => {
    const { runs, prompts } = engine(on, argv =>
      argv.includes('--approve') ? { exitCode: 0, stdout: '✓ approved 0a1b2c3d4e5f (minor)' } : { exitCode: 0, stdout: DELTA },
    )
    on('tool.call', () => ({ result: {}, text: DELTA }))
    await $.session.start({ cwd: '/work/acme', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'npx substrat plan demos/acme --base origin/main' })

    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Input', key: 'plan-by' })).toBeDefined()
      await ui.unmount()
    }

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.input({ key: 'plan-why', text: 'Invoices can be voided now', kind: 'change' })
    await ui.press({ key: 'plan-approve' })

    expect(runs.at(-1)).toEqual([
      'npx', 'substrat', 'plan', 'demos/acme', '--base', 'origin/main',
      '--approve', '0a1b2c3d4e5f', '--by', 'Ada Lovelace', '--why', 'Invoices can be voided now',
    ])
    expect(prompts.at(-1)).toContain('approved the design gate')
    expect((await ui.find({ type: 'Text', text: /Nothing is waiting/ }))).toBeDefined()
    await ui.unmount()
  })

  test('Approve does nothing until the person says why', async ($, on) => {
    const { runs } = engine(on, () => ({ exitCode: 0, stdout: DELTA }))
    on('tool.call', () => ({ result: {}, text: DELTA }))
    await $.session.start({ cwd: '/work/acme', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'substrat plan' })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'plan-approve' })

    expect(runs.flat()).not.toContain('--approve')
    await ui.unmount()
  })
})

describe('the promote checkpoint', () => {
  test('reads the refusal: the version, the acknowledgements it names and its review token', () => {
    const [call] = substratCalls('cd demos/acme && npx substrat push --promote prod')
    expect(promoteRefusalIn(call!, REFUSED)).toMatchObject({
      slug: 'acme',
      versionId: '01JX9ZV3Q8',
      acks: ['--ack-permissions', '--ack-migrations'],
      review: `01JX9ZV0AA:${'e'.repeat(64)}`,
    })
    expect(promoteRefusalIn(call!, '✓ acme → prod now points at 1.4.0')).toBeUndefined()
  })

  test('acknowledging in the pane runs exactly those flags and that token', async ($, on) => {
    const { runs, prompts } = engine(on, () => ({ exitCode: 0, stdout: '✓ acme → prod now points at 01JX9ZV3Q8' }))
    on('tool.call', () => ({ isError: true, result: REFUSED, text: REFUSED }))
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'cd demos/acme && npx substrat push --promote prod' })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'promote-ack' })

    expect(runs.at(-1)).toEqual([
      'npx', 'substrat', 'promote', 'acme', '--version', '01JX9ZV3Q8',
      '--ack-permissions', '--ack-migrations', '--review', `01JX9ZV0AA:${'e'.repeat(64)}`,
    ])
    expect(prompts.at(-1)).toContain('promoted acme 01JX9ZV3Q8')
    await ui.unmount()
  })

  test('a review that went stale is replaced by the one the control plane prints now', async ($, on) => {
    const STALE = REFUSED.replace('01JX9ZV0AA:', '01JX9ZV0BB:')
    engine(on, () => ({ exitCode: 1, stderr: STALE }))
    on('tool.call', () => ({ isError: true, result: REFUSED, text: REFUSED }))
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'npx substrat push --promote prod' })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'promote-ack' })

    expect(await ui.find({ type: 'Text', text: /changed since this was shown/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'promote-ack' })).toBeDefined()
    await ui.unmount()
  })
})

/** What `substrat promote --review-only --json` answers for a promote waiting in prod. */
const WAITING = JSON.stringify({
  slug: 'acme',
  channel: 'prod',
  serving: { versionId: '01JX9ZV0AA', version: '1.3.0' },
  incoming: { versionId: '01JX9ZV3Q8', version: '1.4.0' },
  needs: ['--ack-migrations'],
  review: `01JX9ZV0AA:${'e'.repeat(64)}`,
  command: `substrat promote acme --version 01JX9ZV3Q8 --ack-migrations --review 01JX9ZV0AA:${'e'.repeat(64)}`,
  text: 'prod serves 01JX9ZV0AA (1.3.0); promoting 01JX9ZV3Q8 (1.4.0).',
})

describe('a promote waiting in prod, pushed outside the session', () => {
  test('reads the review the CLI answers, and nothing when nothing waits', () => {
    expect(waitingPromoteIn(WAITING)).toEqual({
      slug: 'acme',
      versionId: '01JX9ZV3Q8',
      acks: ['--ack-migrations'],
      review: `01JX9ZV0AA:${'e'.repeat(64)}`,
      text: 'prod serves 01JX9ZV0AA (1.3.0); promoting 01JX9ZV3Q8 (1.4.0).',
    })
    const served = JSON.parse(WAITING) as Record<string, unknown>
    expect(waitingPromoteIn(JSON.stringify({ ...served, serving: { versionId: '01JX9ZV3Q8' } }))).toBeUndefined()
    expect(waitingPromoteIn(JSON.stringify({ ...served, serving: null }))).toBeUndefined()
    expect(waitingPromoteIn(JSON.stringify({ ...served, needs: ['--force'] }))).toBeUndefined()
    expect(waitingPromoteIn('error: not signed in')).toBeUndefined()
  })

  test('the empty pane asks the control plane, and acknowledging runs exactly the reviewed line', async ($, on) => {
    const { runs, prompts } = engine(on, argv =>
      argv.includes('--review-only') ? { exitCode: 0, stdout: WAITING } : { exitCode: 0, stdout: '✓ acme → prod now points at 01JX9ZV3Q8' },
    )
    await $.session.start({ cwd: '/work/acme', surface: 'desktop', isInteractive: true })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'check-plane' })
    expect(runs.at(-1)?.slice(-3)).toEqual(['promote', '--review-only', '--json'])
    expect(await ui.find({ type: 'Text', text: /Promote acme 01JX9ZV3Q8/ })).toBeDefined()

    await ui.press({ key: 'promote-ack' })
    const last = runs.at(-1)!
    expect(last.slice(last.indexOf('promote'))).toEqual([
      'promote', 'acme', '--version', '01JX9ZV3Q8', '--ack-migrations', '--review', `01JX9ZV0AA:${'e'.repeat(64)}`,
    ])
    expect(prompts.at(-1)).toContain('acknowledged --ack-migrations and promoted acme 01JX9ZV3Q8')
    await ui.unmount()
  })
})

describe('a code review started from the pane', () => {
  test('uploads the branch against origin/main, shows the review, and tells the agent its id', async ($, on) => {
    const { runs, prompts } = engine(on, argv =>
      argv.includes('upload') ? { exitCode: 0, stdout: JSON.stringify({ id: 'r-0001', state: 'received', expiresAt: '2026-12-15T00:00:00.000Z' }) } : { exitCode: 1 },
    )
    await $.session.start({ cwd: '/work/acme', surface: 'desktop', isInteractive: true })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'start-review' })

    const last = runs.at(-1)!
    expect(last.slice(last.indexOf('review'))).toEqual(['review', 'upload', '--base', 'origin/main', '--json'])
    expect(await ui.find({ type: 'Text', text: /Review r-0001: received/ })).toBeDefined()
    expect(prompts.at(-1)).toContain('review r-0001 is received')
    await ui.unmount()
  })
})

/** What `substrat changes --json` answers for a vertical with two open pull requests. */
const CHANGES = JSON.stringify({
  provider: 'github',
  repository: 'acme-org/acme',
  changes: [
    {
      id: '#12', title: 'Void invoices', branch: 'feat-void', url: 'https://github.com/acme-org/acme/pull/12', author: 'ada',
      updatedAt: '2026-11-15T10:00:00Z', head: 'abc', checks: { state: 'failure', failing: ['test'] },
      preview: { tag: 'pr-12', url: 'https://acme--pr-12.global.substrat.run' },
    },
    { id: '#11', title: 'Docs', branch: 'docs', url: null, author: null, updatedAt: '2026-11-14T10:00:00Z', head: 'def', checks: { state: 'success', failing: [] }, preview: null },
  ],
})

/** The same, from an installation that may not read checks. */
const UNREAD = (() => {
  const r = JSON.parse(CHANGES)
  r.reason = 'the GitHub App cannot read checks for acme-org/acme'
  for (const c of r.changes) c.checks = { state: 'unknown', failing: [] }
  return JSON.stringify(r)
})()

describe('the open changes', () => {
  test('reads what the CLI answers, and nothing from output that is not that answer', () => {
    expect(changesIn(CHANGES)?.changes.map(c => [c.id, c.checks.state, c.preview?.url ?? null])).toEqual([
      ['#12', 'failure', 'https://acme--pr-12.global.substrat.run'],
      ['#11', 'success', null],
    ])
    expect(changesIn(JSON.stringify({ provider: null, repository: null, changes: [], reason: 'no repository is known' }))).toEqual({
      provider: null, repository: null, reason: 'no repository is known', changes: [],
    })
    expect(changesIn(UNREAD)?.changes[1]?.checks.state).toBe('unknown')
    expect(changesIn(JSON.stringify({ provider: 'gitlab', changes: [] }))).toBeUndefined()
    expect(changesIn('error: unknown command changes')).toBeUndefined()
  })

  test('checking the plane lists each change with its checks and preview', async ($, on) => {
    const { runs } = engine(on, argv => (argv.includes('changes') ? { exitCode: 0, stdout: CHANGES } : { exitCode: 0, stdout: '{}' }))
    await $.session.start({ cwd: '/work/acme', surface: 'desktop', isInteractive: true })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'check-plane' })
    expect(runs.some(r => r.slice(-2).join(' ') === 'changes --json')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /Changes in acme-org\/acme/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#12 Void invoices/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /checks fail: test · preview https:\/\/acme--pr-12\.global\.substrat\.run/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /checks pass/ })).toBeDefined()
    await ui.unmount()
  })

  test('a promote waiting beside them leaves the list in the pane, checks it cannot read shown as unknown', async ($, on) => {
    engine(on, argv => ({ exitCode: 0, stdout: argv.includes('--review-only') ? WAITING : UNREAD }))
    await $.session.start({ cwd: '/work/acme', surface: 'desktop', isInteractive: true })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'check-plane' })
    expect(await ui.find({ type: 'Text', text: /Promote acme 01JX9ZV3Q8/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#12 Void invoices/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /cannot read checks for acme-org\/acme/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^checks unknown · preview/ })).toBeDefined()
    await ui.unmount()
  })
})
