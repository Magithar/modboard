import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { Task, TaskFile } from '../types'

const task = (id: string, status: Task['status'], owner?: string): Task => ({
  id,
  title: `title of ${id}`,
  description: '',
  status,
  claim: owner ? { owner, since: '2026-10-12T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' } : null,
  notes: [],
})

const NOW = Date.parse('2026-10-12T09:41:00')

// The test stands for the host: the clock, the session, the environment and the
// board CLI, which answers from `tasks` and refuses the names in `taken`.
function host(
  on: On,
  tasks: Task[],
  {
    agent,
    taken = [],
    effort,
    envEffort,
    modelEffort,
    taskfile = { file: null, items: [] },
    broken = { now: false },
    home,
  }: { home?: string; agent?: string; taken?: string[]; effort?: string; envEffort?: string; modelEffort?: string; taskfile?: TaskFile; broken?: { now: boolean } } = {},
) {
  const calls: string[][] = []
  // Claude Code's own /model and /effort, which the model and effort blocks run.
  let model = 'claude-sonnet-5-5'
  on('session.model', () => ({ value: model }))
  on('ui.status', () => ({ value: undefined }))
  on('command.run', { command: 'model' } as any, (_$, e: any) => {
    calls.push(['/model', e.args])
    model = `claude-${e.args}-5-5`
    return { text: `Set model to ${e.args}` }
  })
  // Claude Code's compaction, which the compact button calls.
  on('session.compact', () => {
    calls.push(['/compact'])
    return { skip: 'test' }
  })
  on('command.run', { command: 'effort' } as any, (_$, e: any) => {
    calls.push(['/effort', e.args])
    return { text: `Set effort to ${e.args}` }
  })
  on('session.start', (_$, e: any) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e: any) => ({ value: { tool: `mcp__modboard__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.id', () => ({ value: 'aaaa1111-2222-3333-4444-555566667777' }))
  on('env.get', (_$, e: any) => ({ value: e.name === 'HOME' ? home : e.name === 'BOARD_AGENT' ? agent : e.name === 'CLAUDE_CODE_EFFORT_LEVEL' ? envEffort : undefined }))
  // The effortLevel setting, which /effort saves: where a session starts.
  on('settings.read', () => ({ value: { ...(effort === undefined ? {} : { effortLevel: effort }), ...(modelEffort ? { modelSettings: { 'claude-sonnet-5-5': { effortLevel: modelEffort } } } : {}) } }))
  on('process.run', (_$, e: any) => {
    const argv: string[] = [...e.argv]
    calls.push(argv)
    // A board that cannot be read, while `broken.now` says so.
    if (argv[2] === 'view' && broken.now)
      return { value: { exitCode: 1, stdout: '', stderr: 'board: cannot read .modboard/board.json', isStdoutTruncated: false, isStderrTruncated: false } }
    const refused = argv[2] === 'register' && taken.includes(argv[3]!)
    // A command block's shell: `echo x` prints x, `false` fails.
    if (argv[0] === 'sh') {
      const cmd = argv[2]!
      const failed = cmd === 'false'
      return { value: { exitCode: failed ? 1 : 0, stdout: failed ? '' : `\n${cmd.replace(/^echo /, '')}\nsecond line`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const stdout =
      argv[2] === 'view'
        ? JSON.stringify({ tasks, agents: [{ name: 'codex', lastSeen: '' }] })
        : argv[2] === 'taskfile'
          ? JSON.stringify(taskfile)
          : argv[2] === 'join'
            ? JSON.stringify({ name: 'claude 1' })
            : 'ok'
    return {
      value: {
        exitCode: refused ? 7 : 0,
        stdout: refused ? '' : stdout,
        stderr: refused ? 'board: the name is in use' : '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  return calls
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const PANE = { component: 'Pane', requestId: 'modboard', props: { title: 'modboard', bodyColumns: 60 } } as const
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100 } } as const
// The band without the model and effort switches, for tests about the rest of it.
const QUIET = { options: { band: 'summary,usage' } } as any
// The band with the model and effort switches, which are off by default.
const FULL = { options: { band: 'summary,usage,model,effort' } } as any
const inMinutes = (m: number) => new Date(NOW + m * 60_000).toISOString()
const handedOff = (id: string, by: string): Task => ({ ...task(id, 'todo'), notes: [{ at: '', by, text: 'HANDOFF: part 1 done' }] })

const label = async (ui: any, key: string) => (await ui.find({ key }))?.props.label
// The task file's heading as it reads: the button's name, then its grey count.
const heading = async (ui: any) => {
  const texts_ = (await texts(ui)) as string[]
  return (await label(ui, 'taskfile')) + (texts_.find(t => /^ · (\d+ open|all done)$/.test(t)) ?? '')
}

test('the pane groups in progress, then not started, then done', async ($, on) => {
  host(on, [
    task('T-002', 'todo'),
    { ...task('T-001', 'claimed', 'claude 1'), claim: { owner: 'claude 1', since: '', expiresAt: inMinutes(11) } },
    task('T-003', 'claimed', 'codex'),
    task('T-004', 'done'),
  ])
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'modboard', surface, ...PANE, props: { ...PANE.props, bodyColumns: 80 } } as any)
    // Each group's heading is a button that says how many it holds. What is
    // in progress starts open; what nobody has started starts closed.
    expect(await label(ui, 'group-in-progress')).toBe('▾ In progress')
    expect(await texts(ui)).toContain(' · 2')
    expect(await label(ui, 'group-not-started')).toBe('▸ Not started')
    expect(await texts(ui)).toContain(' · 1')
    let shown = await texts(ui)
    expect(shown.indexOf('title of T-001')).toBeLessThan(shown.indexOf('title of T-003'))
    expect(shown).not.toContain('title of T-002')
    // The heading says what is happening; the row only says who.
    expect(shown).toContain('you')
    expect(shown).toContain('codex')
    expect(shown.some((t: string) => t.includes('on it'))).toBe(false)
    // A lease with time to spare says nothing; only one that needs you does.
    expect(shown.some((t: string) => /unfinished|responding|idle/.test(t))).toBe(false)
    // Done is a group too, closed until pressed.
    expect(await label(ui, 'group-done')).toBe('▸ Done')
    expect(shown).not.toContain('title of T-004')
    // Pressed, a closed group opens; pressed again, it closes.
    await ui.press({ key: 'group-not-started' })
    expect(await label(ui, 'group-not-started')).toBe('▾ Not started')
    expect(await texts(ui)).toContain(' · 1')
    shown = await texts(ui)
    expect(shown.indexOf('title of T-003')).toBeLessThan(shown.indexOf('title of T-002'))
    await ui.press({ key: 'group-in-progress' })
    expect(await texts(ui)).not.toContain('title of T-001')
    await ui.press({ key: 'group-not-started' })
    await ui.press({ key: 'group-in-progress' })
    await ui.unmount()
  }
})

test('the pane flags a handoff nobody picked up and a claim going quiet', async ($, on) => {
  host(on, [
    handedOff('T-005', 'frontend'),
    { ...task('T-006', 'claimed', 'codex'), claim: { owner: 'codex', since: '', expiresAt: inMinutes(3) } },
  ])
  await $.session.start(START)
  const wide = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 80 } } as any)
  // Who stopped, and under the title, their handoff: what is done and what is left.
  expect(await texts(wide)).toContain('frontend')
  expect(await texts(wide)).toContain('part 1 done')
  expect((await texts(wide)).some((t: string) => /see its note|HANDOFF/.test(t))).toBe(false)
  await wide.unmount()
  // Narrow, it still says who stopped.
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const shown = await texts(ui)
  // What needs you starts open.
  expect(await label(ui, 'group-partway')).toBe('▾ Unfinished')
    expect(await texts(ui)).toContain(' · 1')
  expect(shown).toContain('frontend')
  expect(shown).toContain('codex · idle')
  // Its id is grey like every other; the name beside it is what is yellow.
  expect((await ui.find({ type: 'Text', text: 'T-005' }))?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Text', text: ' T-005 ' })).toBeUndefined()
  expect(await ui.find({ key: 'group-not-started' })).toBeUndefined()
})

test('a handoff written with semicolons shows one point a line', async ($, on) => {
  host(on, [{ ...task('T-005', 'todo'), notes: [{ at: '', by: 'claude 1', text: 'HANDOFF: layout done in src/settings.tsx; saving is not wired yet' }] }])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 80 } } as any)
  const shown = await texts(ui)
  expect(shown).toContain('· layout done in src/settings.tsx')
  expect(shown).toContain('· saving is not wired yet')
  await ui.unmount()
})

const WHERE = { worktree: '/Users/me/code/app-login', branch: 'login', commit: 'a1b2c3d', dirty: true }
const checked = (where: object) => ({ at: '', by: 'claude 1', text: 'CHECKED: npm test', check: { cmd: 'npm test', ran: true }, where })

test('under a handoff, where the work is, its path from ~, and the last check that passed', async ($, on) => {
  host(on, [
    { ...task('T-005', 'todo'), notes: [checked({ ...WHERE, dirty: false }), { at: '', by: 'claude 1', text: 'HANDOFF: form done; api left', where: WHERE }] },
    { ...task('T-006', 'todo'), notes: [checked({ ...WHERE, commit: '0ld0ld0' }), { at: '', by: 'codex 1', text: 'HANDOFF: started', where: { ...WHERE, dirty: false } }] },
    { ...task('T-007', 'todo'), notes: [{ at: '', by: 'codex 1', text: 'HANDOFF: outside git' }] },
  ], { home: '/Users/me' })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as any)
  const shown = await texts(ui)
  for (const label of ['where', 'path', 'check']) expect(shown).toContain(label)
  expect(shown).toContain('login @ a1b2c3d, uncommitted changes')
  expect(shown).toContain('~/code/app-login')
  expect(shown.some((t: string) => /^copy/.test(t))).toBe(false)
  // Checked before the work left uncommitted; then, checked at an older commit.
  expect(shown).toContain('npm test passed at a1b2c3d, before uncommitted changes')
  expect(shown).toContain('npm test passed at 0ld0ld0 (before later changes)')
  // The path shows once; a handoff made outside git has no facts.
  expect(shown.filter((t: string) => t.includes('app-login'))).toHaveLength(2)
  expect(shown.filter((t: string) => t === 'where')).toHaveLength(2)
  await ui.unmount()
  // Narrow, the path is cut from the start to fit, its own folder kept.
  const narrow = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 30 } } as any)
  expect((await texts(narrow)).filter((t: string) => /^….*app-login$/.test(t) && t.length <= 12)).toHaveLength(2)
  await narrow.unmount()
})

test('pressing the path puts a cd to the worktree on the clipboard, and says so for a moment', async ($, on) => {
  host(on, [{ ...task('T-005', 'todo'), notes: [{ at: '', by: 'claude 1', text: 'HANDOFF: half done', where: { ...WHERE, worktree: "/w/it's here" } }] }])
  const copies: string[] = []
  on('ui.copy', (_$, e: any) => {
    copies.push(e.text)
    return { value: { isCopied: true } }
  })
  // The moment ✓ copied shows lasts until the test lets it pass.
  let pass = () => {}
  on('clock.sleep', () => new Promise(resolve => (pass = () => resolve({ value: undefined }))) as any)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as any)
  const pressed = ui.press({ key: 'copy-T-005' })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(copies).toEqual([`cd '/w/it'\\''s here'`])
  expect(await texts(ui)).toContain('✓ copied')
  // The path gives way to ✓ copied, then comes back.
  expect(await texts(ui)).not.toContain("/w/it's here")
  pass()
  await pressed
  expect(await texts(ui)).toContain("/w/it's here")
  expect(await texts(ui)).not.toContain('✓ copied')
  await ui.unmount()
})

test('where the surface cannot copy, a toast gives the path', async ($, on) => {
  host(on, [{ ...task('T-005', 'todo'), notes: [{ at: '', by: 'claude 1', text: 'HANDOFF: half done', where: WHERE }] }])
  on('ui.copy', () => ({ value: { isCopied: false, reason: 'remote' } }))
  const toasts: string[] = []
  on('ui.toast', (_$, e: any) => {
    toasts.push(e.text ?? e.message ?? String(e))
    return { value: undefined }
  })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as any)
  await ui.press({ key: 'copy-T-005' })
  expect(toasts.some(t => t.includes("couldn't copy; the worktree is /Users/me/code/app-login"))).toBe(true)
  expect(await texts(ui)).toContain('/Users/me/code/app-login')
  await ui.unmount()
})

test('when the board cannot be read, the pane says so in red, until it can again', async ($, on) => {
  const broken = { now: false }
  host(on, [task('T-001', 'todo')], { broken })
  await $.session.start(START)
  broken.now = true
  await $.tool.call({ tool: 'mcp__modboard__board_list' } as any)
  let ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const line = await ui.find({ type: 'Text', text: 'board not updating: cannot read .modboard/board.json' })
  expect(line?.props.color).toBe('error')
  // The tasks it last read are still there below it.
  expect(await texts(ui)).toContain('modBOARD')
  await ui.unmount()
  broken.now = false
  await $.tool.call({ tool: 'mcp__modboard__board_list' } as any)
  ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect((await texts(ui)).some((t: string) => t.startsWith('board not updating'))).toBe(false)
})

test('the band says in plain words what is waiting, and the one thing that needs you', QUIET, async ($, on) => {
  host(on, [handedOff('T-005', 'frontend'), task('T-001', 'claimed', 'codex'), task('T-002', 'todo')])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(ui)).toEqual(['2 waiting', ' · ', '1 active', ' T-005 '])
  // Active is green; what was left partway is yellow, its task in a yellow box.
  expect((await ui.find({ type: 'Text', text: '1 active' }))?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: ' T-005 ' }))?.props.backgroundColor).toBe('warning')
})

test('the band boxes each task left partway, then counts the rest', QUIET, async ($, on) => {
  host(on, ['T-005', 'T-008', 'T-009', 'T-010'].map(id => handedOff(id, 'claude 1')))
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(ui)).toEqual(['4 waiting', ' T-005 ', ' ', ' T-008 ', ' ', ' T-009 ', ' +1'])
})

test('an idle claim stays off the band; the pane shows it', QUIET, async ($, on) => {
  host(on, [handedOff('T-005', 'claude 1'), { ...task('T-006', 'claimed', 'codex'), claim: { owner: 'codex', since: '', expiresAt: inMinutes(2) } }])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(ui)).toEqual(['1 waiting', ' · ', '1 active', ' T-005 '])
})

test('the band stays out of the way when nothing is waiting or in progress', QUIET, async ($, on) => {
  host(on, [task('T-001', 'done')])
  // Stands for Claude Code's own band beneath the mod.
  on('ui.render', { component: 'AbovePrompt' } as any, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine's own</Text>
  })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(ui)).toEqual(["engine's own"])
})

test('a session takes the name it was started with', async ($, on) => {
  const calls = host(on, [], { agent: 'frontend' })
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__modboard__board_claim', id: 'T-001' } as any)
  expect(calls.find(argv => argv.includes('claim'))?.slice(-4)).toEqual(['claim', 'T-001', '--as', 'frontend'])
})

test('a name another live session holds falls back to the next free one', async ($, on) => {
  const calls = host(on, [], { agent: 'frontend', taken: ['frontend'] })
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__modboard__board_list' } as any)
  expect(calls.find(argv => argv.includes('list'))?.slice(-2)).toEqual(['--as', 'frontend-2'])
})

test('with no name asked for, the board names the session by what it runs and when it joined', async ($, on) => {
  const calls = host(on, [])
  await $.session.start(START)
  expect(calls.find(argv => argv[2] === 'join')?.slice(2)).toEqual(['join', 'claude', '--session', 'aaaa1111-2222-3333-4444-555566667777', '--json'])
  await $.tool.call({ tool: 'mcp__modboard__board_list' } as any)
  expect(calls.find(argv => argv.includes('list'))?.slice(-2)).toEqual(['--as', 'claude 1'])
})

test('board_done passes the verification note through', async ($, on) => {
  const calls = host(on, [task('T-001', 'claimed', 'claude 1')])
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__modboard__board_done', id: 'T-001', note: 'ran it, saw hello' } as any)
  expect(calls.find(argv => argv.includes('done'))?.slice(-6)).toEqual(['done', 'T-001', '--note', 'ran it, saw hello', '--as', 'claude 1'])
})

test('ending the session releases what it holds and gives up its name', async ($, on) => {
  const calls = host(on, [], { agent: 'frontend' })
  on('session.end', () => ({ sessionId: 'aaaa1111-2222-3333-4444-555566667777' }))
  await $.session.start(START)
  await $.session.end({ reason: 'logout' } as any)
  expect(calls.find(argv => argv.includes('release-all'))?.slice(-5)).toEqual([
    'release-all',
    '--session',
    'aaaa1111-2222-3333-4444-555566667777',
    '--as',
    'frontend',
  ])
})

const measure = (percentUsed: number) => ({
  context: { window: 200000, percent: 41.6 },
  rateLimits: [
    { kind: 'five_hour', percentUsed, resetsAt: '2026-10-12T12:00:00' },
    { kind: 'seven_day', percentUsed: 20, resetsAt: '2026-10-15T12:00:00' },
  ],
  cost: { usd: 1.234 },
  changed: ['context', 'rateLimits', 'cost'],
})

test('usage shows in the pane with resets, and in the band only past half', QUIET, async ($, on) => {
  host(on, [task('T-001', 'todo')])
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)

  await $.session.measure(measure(31) as any)
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const inPane = await texts(pane)
  // A bar, then when it resets.
  expect(inPane).toEqual(expect.arrayContaining(['5-hour limit', '▓▓▓', '░░░░░░░', '  31%', '   resets 12:00']))
  // The weekly window is left off the board.
  expect(inPane.some((t: string) => t.includes('weekly'))).toBe(false)
  let band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect((await texts(band)).some((t: string) => t.endsWith('limit'))).toBe(false)
  await band.unmount()

  await $.session.measure(measure(72.4) as any)
  band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(band)).toEqual(expect.arrayContaining(['5-hour limit', '▓▓▓▓▓▓▓', '░░░', '  72%']))
})

const atContext = (percent: number) => ({ ...measure(10), context: { window: 200000, percent }, changed: ['context'] })

test('the compact button shows the context as a bar like the 5-hour limit, and compacts when pressed', { options: { pane: 'compact' } } as any, async ($, on) => {
  const calls = host(on, [task('T-001', 'todo')])
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)
  for (const [percent, used, color] of [[5, '▓', undefined], [30, '▓▓▓', undefined], [55, '▓▓▓▓▓▓', undefined], [75, '▓▓▓▓▓▓▓▓', 'warning'], [95, '▓▓▓▓▓▓▓▓▓▓', 'error']] as const) {
    await $.session.measure(atContext(percent) as any)
    const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
    expect(await texts(pane)).toEqual(expect.arrayContaining(['context', used, ` ${String(percent).padStart(3)}%`]))
    expect((await pane.find({ type: 'Text', text: used }))?.props.color).toBe(color)
    await pane.unmount()
  }
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  await pane.press({ key: 'compact' })
  expect(calls).toContainEqual(['/compact'])
})

test('the pane offers compact before the context is known, with an empty bar', async ($, on) => {
  const calls = host(on, [task('T-001', 'todo')])
  await $.session.start(START)
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await texts(pane)).toEqual(expect.arrayContaining(['context', '░░░░░░░░░░', '    –']))
  await pane.press({ key: 'compact' })
  expect(calls).toContainEqual(['/compact'])
})

test('before the first reply, the context bar shows Claude Code\'s own estimate', async ($, on) => {
  host(on, [task('T-001', 'todo')])
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200000, breakdown: { percentage: 18 } }, rateLimits: [] },
  }))
  await $.session.start(START)
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await texts(pane)).toEqual(expect.arrayContaining(['context', '▓▓', '░░░░░░░░', '  18%']))
})

test('the band offers compact from the first reading of the context', { options: { band: 'compact' } } as any, async ($, on) => {
  const calls = host(on, [task('T-001', 'todo')])
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)
  // Before Claude Code has measured anything, there is nothing to show.
  let band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await band.find({ key: 'compact' })).toBeUndefined()
  await band.unmount()
  await $.session.measure(atContext(12) as any)
  band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  // The whole part is the button: the bar, its percent, and the word.
  expect((await band.find({ key: 'compact' }))?.props.label).toBe('context ▓░░░░░░░░░  12% compact')
  await band.unmount()
  await $.session.measure(atContext(72) as any)
  band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect((await band.find({ key: 'compact' }))?.props.label).toBe('context ▓▓▓▓▓▓▓░░░  72% compact')
  await band.press({ key: 'compact' })
  expect(calls).toContainEqual(['/compact'])
})

test('usage is plain with room, yellow from 70%, red from 90%', QUIET, async ($, on) => {
  host(on, [task('T-001', 'todo')])
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)
  for (const [percent, color] of [[64, undefined], [72, 'warning'], [93, 'error']] as const) {
    await $.session.measure(measure(percent) as any)
    const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
    expect((await band.find({ type: 'Text', text: /^▓+$/ }))?.props.color).toBe(color)
    expect((await band.find({ type: 'Text', text: /^░+$/ }))?.props.dimColor).toBe(true)
    // Plain means dim: nothing to act on yet.
    expect((await band.find({ type: 'Text', text: `  ${percent}%` }))?.props.dimColor).toBe(!color)
    await band.unmount()
  }
})

test('the band and pane settings pick blocks and their order', { options: { band: 'clock', pane: 'clock,work,context' } } as any, async ($, on) => {
  host(on, [task('T-001', 'todo')])
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)
  await $.session.measure(measure(72) as any)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(band)).toEqual(['09:41'])
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const shown = await texts(pane)
  expect(shown[0]).toBe('09:41')
  expect(shown.at(-1)).toBe('context 42% full · cost $1.23')
})

const TASKFILE: TaskFile = {
  file: 'task.md',
  items: [
    { text: 'Write the parser', done: false, section: 'Sprint', depth: 0, priority: null },
    { text: 'Sketch the pane', done: true, section: 'Sprint', depth: 0, priority: null },
    { text: 'Ship it', done: false, section: 'Later', depth: 0, priority: null },
  ],
}

const BOARD_ONLY = { options: { pane: 'work,todo' } } as any
const BOARD_ONLY_BARS = { options: { pane: 'work,todo,compact,usage' } } as any

test('the task.md button says what is left, and shows only that when pressed', BOARD_ONLY, async ($, on) => {
  host(on, [task('T-001', 'todo')], { taskfile: TASKFILE })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await heading(ui)).toBe('▸ To do · 2 open')
  // Only the name is the button; the count is grey text beside it.
  expect((await ui.find({ type: 'Text', text: '▸ To do' }))?.props.bold).toBe(true)
  expect(await label(ui, 'taskfile')).toBe('▸ To do')
  expect((await ui.find({ type: 'Text', text: ' · 2 open' }))?.props.dimColor).toBe(true)
  expect(await texts(ui)).not.toContain('Write the parser')
  expect(await texts(ui)).not.toContain('from task.md')
  await ui.press({ key: 'taskfile' })
  expect(await heading(ui)).toBe('▾ To do · 2 open')
  const shown = await texts(ui)
  // The heading says what it is; open, the pane says which file it read.
  expect(shown).toContain('from task.md')
  expect(shown.indexOf('Sprint')).toBeLessThan(shown.indexOf('Write the parser'))
  expect(shown.indexOf('Write the parser')).toBeLessThan(shown.indexOf('Later'))
  expect(shown.indexOf('Later')).toBeLessThan(shown.indexOf('Ship it'))
  // Done is the file's business, not the pane's.
  expect(shown).not.toContain('Sketch the pane')
  // The board's own tasks stay where they were, above it.
  expect(shown.indexOf('title of T-001')).toBeLessThan(shown.indexOf('Sprint'))
  await ui.press({ key: 'taskfile' })
  expect(await texts(ui)).not.toContain('Write the parser')
})

test('a long task.md shows every open item when open, with no count of the rest', BOARD_ONLY, async ($, on) => {
  const items = Array.from({ length: 20 }, (_, n) => ({ text: `item ${n + 1}`, done: n % 4 === 3, section: n < 10 ? 'Sprint' : 'Later', depth: 0, priority: null }))
  host(on, [], { taskfile: { file: 'task.md', items } })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await heading(ui)).toBe('▸ To do · 15 open')
  await ui.press({ key: 'taskfile' })
  const shown = (await texts(ui)).filter((t: string) => t.startsWith('item '))
  expect(shown).toHaveLength(15)
  expect((await texts(ui)).some((t: string) => / more$/.test(t))).toBe(false)
})

test('all shows every open item in a file with priorities, with no count of the rest', BOARD_ONLY, async ($, on) => {
  const items = Array.from({ length: 12 }, (_, n) => ({ text: `item ${n + 1}`, done: false, section: '', depth: 0, priority: n < 6 ? 0 : 1 }))
  host(on, [], { taskfile: { file: 'TASKS.md', items } })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  await ui.press({ key: 'taskfile' })
  await ui.press({ key: 'tier' })
  await ui.press({ key: 'tier' })
  expect(await label(ui, 'tier')).toBe('all')
  const shown = await texts(ui)
  expect(shown.filter((t: string) => t.startsWith('item '))).toHaveLength(12)
  expect(shown.some((t: string) => / more$/.test(t))).toBe(false)
})

test('a press on the task file reads it again, so what was just added shows', BOARD_ONLY, async ($, on) => {
  const file = { file: 'TASKS.md', items: [{ text: 'first', done: false, section: '', depth: 0, priority: 0 }] }
  host(on, [], { taskfile: file })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await label(ui, 'tier')).toBe('P0')
  file.items.push({ text: 'added later', done: false, section: '', depth: 0, priority: 0 })
  await ui.press({ key: 'taskfile' })
  expect(await heading(ui)).toBe('▾ To do · 2 open')
  expect(await texts(ui)).toEqual(expect.arrayContaining(['first', 'added later']))
})

test('a task.md with everything checked off says so', async ($, on) => {
  host(on, [], { taskfile: { file: 'task.md', items: [{ text: 'a', done: true, section: '', depth: 0, priority: null }] } })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await heading(ui)).toBe('▸ To do · all done')
})

test('opened, Done lists what is finished, the latest first, with who finished it', async ($, on) => {
  const finished = (id: string, by: string, at: string): Task => ({ ...task(id, 'done'), notes: [{ at, by, text: 'VERIFIED: ran it' }] })
  host(on, [finished('T-001', 'codex 1', '2026-11-19T10:00'), finished('T-002', 'claude 1', '2026-11-19T12:00')])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  await ui.press({ key: 'group-done' })
  expect(await label(ui, 'group-done')).toBe('▾ Done')
  const shown = await texts(ui)
  expect(shown.indexOf('title of T-002')).toBeLessThan(shown.indexOf('title of T-001'))
  expect(shown).toContain('you')
  expect(shown).toContain('codex 1')
})

test('opened, a long backlog shows every task, with no count of the rest', async ($, on) => {
  const backlog = Array.from({ length: 12 }, (_, n) => task(`T-${String(n + 10).padStart(3, '0')}`, 'todo'))
  const working = Array.from({ length: 10 }, (_, n) => task(`T-${String(n + 30).padStart(3, '0')}`, 'claimed', 'codex'))
  host(on, [...backlog, ...working])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  await ui.press({ key: 'group-not-started' })
  const shown = await texts(ui)
  expect(shown.filter((t: string) => /^title of T-03/.test(t))).toHaveLength(10)
  expect(shown.filter((t: string) => /^title of T-0[12]/.test(t))).toHaveLength(12)
  expect(shown.some((t: string) => / more$/.test(t))).toBe(false)
  // The state is in the heading, not a mark on every row.
  expect(shown.some((t: string) => t === '◐' || t === '○')).toBe(false)
})

const ITEM = (text: string, priority: number | null, done = false) => ({ text, done, section: 'x', depth: 0, priority })
const RANKED: TaskFile = {
  file: 'docs/TASKS.md',
  items: [ITEM('later one', 2), ITEM('urgent one', 0), ITEM('no priority', null), ITEM('next one', 1), ITEM('urgent two', 0), ITEM('urgent done', 0, true)],
}
// The list's rows: what comes after its "from" line, so the button's own "P0" is not one.
const work = async (ui: any) => {
  const all: string[] = await texts(ui)
  return all.slice(all.findIndex(t => t.startsWith('from ')) + 1).filter(t => /one|two|priority|^P\d$|^–?$/.test(t))
}

test('the priority button starts on the most urgent tier and shows only its work', BOARD_ONLY, async ($, on) => {
  host(on, [], { taskfile: RANKED })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await heading(ui)).toBe('▸ To do · 5 open')
  expect(await label(ui, 'tier')).toBe('P0')
  await ui.press({ key: 'taskfile' })
  expect(await texts(ui)).toContain('from docs/TASKS.md')
  // The button names the tier, so the rows are only the work.
  expect(await work(ui)).toEqual(['urgent one', 'urgent two'])
  // Each item has a grey dot before it.
  expect((await ui.find({ type: 'Text', text: '· ' }))?.props.dimColor).toBe(true)
  // With priorities, the headings step aside.
  expect(await texts(ui)).not.toContain('x')
})

test('the priority button turns through each tier the file has, then all, then round again', BOARD_ONLY, async ($, on) => {
  host(on, [], { taskfile: RANKED })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  // Pressing it opens a closed list on the next tier.
  await ui.press({ key: 'tier' })
  expect(await heading(ui)).toBe('▾ To do · 5 open')
  expect(await label(ui, 'tier')).toBe('P1')
  expect(await work(ui)).toEqual(['next one'])
  await ui.press({ key: 'tier' })
  expect(await label(ui, 'tier')).toBe('P2')
  expect(await work(ui)).toEqual(['later one'])
  await ui.press({ key: 'tier' })
  expect(await label(ui, 'tier')).toBe('all')
  // All: most urgent first, every row with its priority; none last, with a dash.
  expect(await work(ui)).toEqual(['P0', 'urgent one', 'P0', 'urgent two', 'P1', 'next one', 'P2', 'later one', '–', 'no priority'])
  await ui.press({ key: 'tier' })
  expect(await label(ui, 'tier')).toBe('P0')
})

test('a task file without priorities has no priority button', async ($, on) => {
  host(on, [], { taskfile: TASKFILE })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await ui.find({ key: 'tier' })).toBeUndefined()
})

test('the names work and todo had before, tasks and taskfile, still show them', { options: { pane: 'tasks,taskfile' } } as any, async ($, on) => {
  host(on, [task('T-001', 'todo')], { taskfile: TASKFILE })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await label(ui, 'taskfile')).toBe('▸ To do')
  expect((await texts(ui)).some(t => t.includes('Not started'))).toBe(true)
})

test('with no task.md the pane shows no button for it', async ($, on) => {
  host(on, [task('T-001', 'todo')])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await ui.find({ key: 'taskfile' })).toBeUndefined()
})

test('task.md is never read when no shown block uses it', { options: { pane: 'work' } } as any, async ($, on) => {
  const calls = host(on, [], { taskfile: TASKFILE })
  await $.session.start(START)
  expect(calls.some(argv => argv[2] === 'taskfile')).toBe(false)
})

test('an empty board says how to add a task', async ($, on) => {
  host(on, [])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await ui.find({ type: 'Text', text: /No tasks yet/ })).toBeDefined()
})

test('one task reads as one task', QUIET, async ($, on) => {
  host(on, [task('T-001', 'todo')])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(ui)).toEqual(['1 waiting'])
})

test('the model block shows the model and switches to the next one when pressed', FULL, async ($, on) => {
  const calls = host(on, [task('T-001', 'todo')])
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect((await band.find({ key: 'model' }))?.props.label).toBe('Sonnet 5.5')
  await band.press({ key: 'model' })
  expect(calls).toContainEqual(['/model', 'haiku'])
  expect((await band.find({ key: 'model' }))?.props.label).toBe('Haiku 5.5')
  await band.press({ key: 'model' })
  expect(calls).toContainEqual(['/model', 'opus'])
})

test('the effort block shows the level and steps to the next when pressed', FULL, async ($, on) => {
  const calls = host(on, [task('T-001', 'todo')], { effort: 'medium' })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect((await band.find({ key: 'effort' }))?.props.label).toBe('medium')
  await band.press({ key: 'effort' })
  expect(calls).toContainEqual(['/effort', 'high'])
  expect((await band.find({ key: 'effort' }))?.props.label).toBe('high')
})

test('effort shows the saved level before the session has sent anything', FULL, async ($, on) => {
  host(on, [task('T-001', 'todo')], { effort: 'low' })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect((await band.find({ key: 'effort' }))?.props.label).toBe('low')
})

test("the model's own saved effort wins over the general one", FULL, async ($, on) => {
  host(on, [task('T-001', 'todo')], { effort: 'medium', modelEffort: 'low' })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect((await band.find({ key: 'effort' }))?.props.label).toBe('low')
})

test('CLAUDE_CODE_EFFORT_LEVEL overrides the saved level', FULL, async ($, on) => {
  host(on, [task('T-001', 'todo')], { effort: 'low', envEffort: 'high' })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect((await band.find({ key: 'effort' }))?.props.label).toBe('high')
})

test('the models and efforts settings choose what the blocks step through', { options: { band: 'summary,usage,model,effort', models: 'sonnet,fable', efforts: 'low,max' } } as any, async ($, on) => {
  const calls = host(on, [task('T-001', 'todo')], { effort: 'max' })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  await band.press({ key: 'model' })
  await band.press({ key: 'effort' })
  expect(calls).toContainEqual(['/model', 'fable'])
  expect(calls).toContainEqual(['/effort', 'low'])
})

test('effort steps through every level in order and wraps from the highest to the lowest', FULL, async ($, on) => {
  const calls = host(on, [task('T-001', 'todo')], { effort: 'medium' })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  const seen: string[] = []
  for (let i = 0; i < 5; i++) {
    await band.press({ key: 'effort' })
    seen.push(String((await band.find({ key: 'effort' }))?.props.label))
  }
  // "xhigh" contains "high": it must still step on to "max", not back to itself.
  expect(seen).toEqual(['high', 'xhigh', 'max', 'low', 'medium'])
  expect(calls.filter(c => c[0] === '/effort').map(c => c[1])).toEqual(['high', 'xhigh', 'max', 'low', 'medium'])
})

// The band at a given width: what it shows, and how wide that is.
async function bandAt($: any, columns: number) {
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: columns } } as any)
  const shown: string[] = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
  await ui.unmount()
  return shown
}

test('the band defaults to the tasks, model and effort, then a modBOARD button; usage and context stay in the pane', async ($, on) => {
  host(on, [task('T-001', 'todo')], { effort: 'low' })
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)
  await $.session.measure({ ...measure(64), context: { window: 200000, percent: 72 } } as any)
  const shown = await bandAt($, 140)
  expect(shown).toEqual(['1 waiting', 'Sonnet 5.5', 'low', 'modBOARD'])
})


test('a task\'s box on the band opens the pane at its group; pressed again it folds the group, and never closes the pane', QUIET, async ($, on) => {
  host(on, [handedOff('T-005', 'claude 1')])
  const opened: any[] = []
  on('ui.open', (_$, e: any) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  const closed: string[] = []
  on('ui.close', (_$, e: any) => {
    closed.push(e.id)
    return { value: undefined }
  })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect((await band.find({ key: 'task-T-005' }))?.props.plain).toBe(true)
  await band.press({ key: 'task-T-005' })
  expect(opened).toHaveLength(1)
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await label(pane, 'group-partway')).toBe('▾ Unfinished')
  // Pressed again with the pane open, it folds the group; the pane stays.
  await band.press({ key: 'task-T-005' })
  expect(await label(pane, 'group-partway')).toBe('▸ Unfinished')
  // And again, it unfolds it.
  await band.press({ key: 'task-T-005' })
  expect(await label(pane, 'group-partway')).toBe('▾ Unfinished')
  expect(opened).toHaveLength(1)
  expect(closed).toHaveLength(0)
})

test('modBOARD on the band opens the board pane', { options: { band: 'summary,board' } } as any, async ($, on) => {
  host(on, [task('T-001', 'todo')])
  const opened: any[] = []
  on('ui.open', (_$, e: any) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  const closed: string[] = []
  on('ui.close', (_$, e: any) => {
    closed.push(e.id)
    return { value: undefined }
  })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(band)).toContain('modBOARD')
  // No brackets: a word, like the model's.
  expect((await band.find({ key: 'board' }))?.props.plain).toBe(true)
  await band.press({ key: 'board' })
  expect(opened.map(e => e.id)).toEqual(['modboard'])
  // Pressed again while the board is open, it closes it; then opens it again.
  await band.press({ key: 'board' })
  expect(closed).toEqual(['modboard'])
  await band.press({ key: 'board' })
  expect(opened.map(e => e.id)).toEqual(['modboard', 'modboard'])
})

test('modBOARD sits last but outlasts model and effort on a short line', { options: { band: 'summary,model,effort,board' } } as any, async ($, on) => {
  host(on, [task('T-001', 'todo')], { effort: 'low' })
  await $.session.start(START)
  expect((await bandAt($, 120)).at(-1)).toBe('modBOARD')
  const short = await bandAt($, 34)
  expect(short).toContain('modBOARD')
  expect(short).not.toContain('low')
})

test('the band never wraps: it narrows its parts, then leaves the last ones out', FULL, async ($, on) => {
  host(on, [task('T-001', 'todo'), task('T-002', 'todo')], { effort: 'low' })
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)
  await $.session.measure(measure(64) as any)

  const wide = await bandAt($, 124)
  expect(wide).toEqual(expect.arrayContaining(['2 waiting', '5-hour limit', 'Sonnet 5.5', 'low']))

  const medium = await bandAt($, 64)
  expect(medium).toEqual(expect.arrayContaining(['2 waiting', 'Sonnet 5.5', 'low']))
  expect(medium).not.toContain('model ')
  expect(medium).not.toContain('effort ')

  const narrow = await bandAt($, 38)
  expect(narrow).toContain('2 waiting')
  expect(narrow).toContain('5h')
  expect(narrow).not.toContain('5-hour limit')
  expect(narrow).not.toContain('Sonnet 5.5')

  const tiny = await bandAt($, 20)
  expect(tiny).toEqual(['2 waiting'])
})

test('when the line is short, the alert outlasts the counts', async ($, on) => {
  host(on, [handedOff('T-005', 'frontend'), task('T-002', 'todo')])
  await $.session.start(START)
  expect(await bandAt($, 26)).toEqual(['2 waiting', ' T-005 '])
  expect(await bandAt($, 14)).toEqual([' T-005 '])
})

test('at every width, what the band draws fits the line', FULL, async ($, on) => {
  host(on, [handedOff('T-005', 'frontend'), task('T-001', 'claimed', 'codex')], { effort: 'xhigh' })
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  on('ui.render', { component: 'AbovePrompt' } as any, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{''}</Text>
  })
  await $.session.start(START)
  await $.session.measure(measure(93) as any)
  for (const columns of [140, 100, 80, 60, 40, 30, 20, 12]) {
    const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: columns } } as any)
    const tree: any = await ui.drawn()
    await ui.unmount()
    // The host stacks each plugin's band; measure modboard's alone. Its
    // parts sit 3 apart, and the texts inside one part sit together.
    const row = (tree.children ?? []).find((c: any) => c.part?.plugin === 'modboard')
    const parts = row?.children ?? []
    const textOf = (n: any): string => (typeof n === 'string' ? n : (n?.children ?? []).map(textOf).join(''))
    const width = parts.map(textOf).join('').length + (parts.length > 1 ? 3 * (parts.length - 1) : 0)
    // Clear of Claude Code's own [-] control at the right end.
    expect({ columns, width: width <= columns - 4 }).toEqual({ columns, width: true })
  }
})

test('a command block shows its first line in the band and the pane; a failing one shows nothing', {
  options: { blocks: '{"ci": "echo passing", "broken": "false"}', band: 'summary,ci,broken', pane: 'work,ci,broken' },
} as any, async ($, on) => {
  const calls = host(on, [task('T-001', 'todo')])
  await $.session.start(START)
  expect(calls).toContainEqual(['sh', '-c', 'echo passing'])
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(band)).toEqual(['1 waiting', 'ci passing'])
  await band.unmount()
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const shown = await texts(pane)
  expect(shown).toEqual(expect.arrayContaining(['ci', 'passing']))
  expect(shown).not.toContain('broken')
})

test('the blocks setting refuses what it cannot use, by name, and never runs it', {
  options: { blocks: '{"tasks": "echo hijack", "todo": "echo hijack", "Bad Name": "echo x", "ok": "echo fine"}', band: 'summary,ok' },
} as any, async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_$, e: any) => {
    toasts.push(String(e.message ?? e.text ?? e))
    return { value: undefined }
  })
  const calls = host(on, [task('T-001', 'todo')])
  await $.session.start(START)
  expect(toasts.some(t => t.includes('"tasks" is a built-in block'))).toBe(true)
  expect(toasts.some(t => t.includes('"todo" is a built-in block'))).toBe(true)
  expect(toasts.some(t => t.includes('"Bad Name"'))).toBe(true)
  expect(calls).not.toContainEqual(['sh', '-c', 'echo hijack'])
  expect(calls).toContainEqual(['sh', '-c', 'echo fine'])
})

test('a grey rule parts the pane sections; the bars stay together as one', BOARD_ONLY_BARS, async ($, on) => {
  host(on, [task('T-001', 'todo')], { taskfile: TASKFILE })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const shown = (await texts(ui)) as string[]
  const rules = shown.filter(t => /^─+$/.test(t))
  // tasks | taskfile | compact + usage
  expect(rules).toHaveLength(2)
  expect(shown.indexOf(rules[0]!)).toBeLessThan(shown.indexOf('▸ To do'))
})

test('the bars sit under a Limits heading that folds to their figures, coloured as the bars are', BOARD_ONLY_BARS, async ($, on) => {
  host(on, [task('T-001', 'todo')])
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)
  await $.session.measure({ ...measure(64), context: { window: 200000, percent: 72 } } as any)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  let shown = (await texts(ui)) as string[]
  // Open by default: the heading, then both bars.
  expect(shown).toEqual(expect.arrayContaining(['▾ Limits', 'context', '5-hour limit']))
  expect(shown.indexOf('▾ Limits')).toBeLessThan(shown.indexOf('context'))
  await ui.press({ key: 'group-limits' })
  shown = (await texts(ui)) as string[]
  expect(shown).toEqual(expect.arrayContaining(['▸ Limits', 'context 72%', '5-hour 64%']))
  expect(shown).not.toContain('5-hour limit')
  // Folded, the compact button goes with its bar.
  expect(await ui.find({ key: 'compact' })).toBeUndefined()
  // Folded, each figure keeps its bar's colour: yellow from 70%, plain below.
  expect((await ui.find({ type: 'Text', text: 'context 72%' }))?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Text', text: '5-hour 64%' }))?.props.color).toBeUndefined()
  await ui.press({ key: 'group-limits' })
  expect(await texts(ui)).toContain('▾ Limits')
})

test('the pane opens with modBOARD, this session\'s name, and the counts of what waits and what is active', BOARD_ONLY, async ($, on) => {
  host(on, [task('T-001', 'todo'), task('T-002', 'todo'), task('T-003', 'claimed', 'codex')])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const shown = (await texts(ui)) as string[]
  expect(shown.slice(0, 6)).toEqual(['modBOARD', ' · ', 'claude 1', '2 waiting', ' · ', '1 active'])
  expect((await ui.find({ type: 'Text', text: '1 active' }))?.props.color).toBe('success')
  const logo = (await ui.find({ type: 'Text', text: 'modBOARD' }))?.props
  expect([logo?.color, logo?.bold, logo?.size]).toEqual(['success', true, 'heading'])
})
