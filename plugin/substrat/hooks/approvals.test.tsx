import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { promoteRefusalIn, refusalFor, substratCalls } from './approvals-parse'

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
