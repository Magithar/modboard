import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { splitProblem } from '../hooks/blocks/problem'

import type { Task, TaskFile, Where } from '../types'

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
    untrusted = false,
    home,
    live = [{ name: 'codex', lastSeen: '' }],
    time,
    shell,
  }: { untrusted?: boolean; time?: { now: number }; shell?: { failing: Set<string> }; live?: { name: string; lastSeen: string }[]; home?: string; agent?: string; taken?: string[]; effort?: string; envEffort?: string; modelEffort?: string; taskfile?: TaskFile; broken?: { now: boolean } } = {},
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
  on('clock.now', () => ({ value: time?.now ?? NOW }))
  on('session.id', () => ({ value: 'aaaa1111-2222-3333-4444-555566667777' }))
  on('env.get', (_$, e: any) => ({ value: e.name === 'HOME' ? home : e.name === 'BOARD_AGENT' ? agent : e.name === 'CLAUDE_CODE_EFFORT_LEVEL' ? envEffort : undefined }))
  // The effortLevel setting, which /effort saves: where a session starts.
  on('settings.read', () => ({ value: { ...(effort === undefined ? {} : { effortLevel: effort }), ...(modelEffort ? { modelSettings: { 'claude-sonnet-5-5': { effortLevel: modelEffort } } } : {}) } }))
  on('process.run', (_$, e: any) => {
    const argv: string[] = [...e.argv]
    calls.push(argv)
    // A board that names a storage block it may not run: every board command exits
    // 12, and one with --json says why as JSON on stdout, as the CLI does.
    if (untrusted && argv[1]?.endsWith('board.mjs')) {
      const error = 'storage block "./cloned.mjs" is a file in this project, and modBOARD only runs blocks you installed yourself: read it, then run board block add at a terminal. The block: /repo/.modboard/cloned.mjs, named in /repo/.modboard/config.json'
      return { value: argv.includes('--json') ? { exitCode: 12, stdout: JSON.stringify({ error, code: 12 }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } : { exitCode: 12, stdout: '', stderr: `board: ${error}`, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // A board that cannot be read, while `broken.now` says so.
    if (argv[2] === 'view' && broken.now)
      return { value: { exitCode: 1, stdout: '', stderr: 'board: cannot read .modboard/board.json', isStdoutTruncated: false, isStderrTruncated: false } }
    const refused = argv[2] === 'register' && taken.includes(argv[3]!)
    // A command block's shell: `echo x` prints x, `false` fails.
    if (argv[0] === 'sh') {
      const cmd = argv[2]!
      const failed = cmd === 'false' || (shell?.failing.has(cmd) ?? false)
      return { value: { exitCode: failed ? 1 : 0, stdout: failed ? '' : `\n${cmd.replace(/^echo /, '')}\nsecond line`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const stdout =
      argv[2] === 'view'
        ? JSON.stringify({ tasks, agents: live })
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

test('a task not ready yet says what it waits on, and labels show beside the title', async ($, on) => {
  host(on, [{ ...task('T-002', 'todo'), after: ['T-001'], waitingOn: ['T-001'], labels: ['kind=bug'] }, task('T-001', 'claimed', 'codex')])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 80 } } as any)
  await ui.press({ key: 'group-not-started' })
  const shown = await texts(ui)
  expect(shown).toContain('waits on T-001')
  expect(shown).toContain('  kind=bug')
  // Waiting is not a warning: nothing has gone wrong.
  expect((await ui.find({ type: 'Text', text: 'waits on T-001' }))?.props.color).toBeUndefined()
  await ui.unmount()
})

const WHERE = { worktree: '/Users/me/code/app-login', branch: 'login', commit: 'a1b2c3d', dirty: true }
const checked = (where: Where) => ({ at: '', by: 'claude 1', text: 'CHECKED: npm test', check: { cmd: 'npm test', ran: true }, where })

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
  // Grey labels, plain values.
  expect((await ui.find({ type: 'Text', text: 'where' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ type: 'Text', text: 'login @ a1b2c3d, uncommitted changes' }))?.props.dimColor).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: '~/code/app-login' }))?.props.dimColor).toBeFalsy()
  // A blank line parts the rows.
  expect((await ui.find({ key: 'path-T-005' }))?.props.marginTop).toBe(1)
  // The path shows once; a handoff made outside git has no facts.
  expect(shown.filter((t: string) => t.includes('app-login'))).toHaveLength(2)
  expect(shown.filter((t: string) => t === 'where')).toHaveLength(2)
  await ui.unmount()
  // Narrow, the path is cut from the start to fit, its own folder kept.
  const narrow = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 30 } } as any)
  expect((await texts(narrow)).filter((t: string) => /^….*app-login$/.test(t) && t.length <= 12)).toHaveLength(2)
  await narrow.unmount()
})

test('a handoff the board wrote for a session that went away names that agent, and marks its place stale', async ($, on) => {
  host(on, [
    {
      ...task('T-005', 'todo'),
      notes: [
        checked({ ...WHERE, dirty: false }),
        { at: '', by: 'board', text: 'HANDOFF: claude 1 stopped responding (its session went silent); read the notes above', where: { ...WHERE, dirty: false, stale: true } },
      ],
    },
  ])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as any)
  const shown = await texts(ui)
  expect(await label(ui, 'group-partway')).toBe('▾ Unfinished')
  expect(shown).toContain('claude 1')
  expect(shown).not.toContain('board')
  expect(shown).toContain('login @ a1b2c3d · last known, may be stale')
  expect(shown).toContain('npm test passed at a1b2c3d')
  await ui.unmount()
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
  const heading = await ui.find({ type: 'Text', text: 'board not updating' })
  expect(heading?.props.color).toBe('error')
  expect((await ui.find({ type: 'Text', text: 'cannot read .modboard/board.json' }))?.props.color).toBe('error')
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
  expect(calls.find(argv => argv.includes('done'))?.slice(-5)).toEqual(['done', 'T-001', '--note=ran it, saw hello', '--as', 'claude 1'])
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
  expect(shown).toEqual(['1 waiting', 'Sonnet 5.5', 'low', 'blocks', 'modBOARD'])
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

test('bars with another block between them still share one Limits heading, where the first bar sits', { options: { pane: 'usage,checks,compact' } } as any, async ($, on) => {
  host(on, [task('T-001', 'todo')])
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)
  await $.session.measure({ ...measure(18), context: { window: 200000, percent: 3 } } as any)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const shown = (await texts(ui)) as string[]
  expect(shown.filter(t => /Limits$/.test(t))).toEqual(['▾ Limits'])
  // Limits (both bars) first, then Checks.
  expect(shown.indexOf('5-hour limit')).toBeLessThan(shown.indexOf('context'))
  expect(shown.indexOf('context')).toBeLessThan(shown.indexOf('▾ Checks'))
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

// The plugin's store, kept in a map the test can read and seed.
function store(on: On, seed: Record<string, unknown> = {}) {
  const kept = new Map(Object.entries(seed))
  on('store.get', (_$, e: any) => ({ value: kept.get(e.key) }))
  on('store.set', (_$, e: any) => {
    kept.set(e.key, e.value)
    return { value: undefined }
  })
  return kept
}

test('blocks opens the pane at the list of blocks alone; ticks change the board; modBOARD shows it', { options: { band: 'summary,board' } } as any, async ($, on) => {
  const calls = host(on, [task('T-001', 'claimed', 'codex')])
  const kept = store(on)
  const opened: any[] = []
  on('ui.open', (_$, e: any) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  const shown = (await texts(band)) as string[]
  // It sits just before modBOARD.
  expect(shown.indexOf('blocks')).toBe(shown.indexOf('modBOARD') - 1)
  // Bold, in the logo's cap orange.
  const look = (await band.find({ type: 'Text', text: 'blocks' }))?.props
  expect([look?.bold, look?.color]).toEqual([true, '#F27238'])
  const before = (calls: string[][]) => calls.filter(c => c[2] === 'view').length
  const views = before(calls)
  await band.press({ key: 'blocks' })
  expect(opened.map(e => e.id)).toEqual(['modboard'])
  // Straight to the list: no read of the board first.
  expect(before(calls)).toBe(views)
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  let list = (await texts(pane)) as string[]
  // Only the list: no board under it.
  expect(list[0]).toBe('Blocks')
  expect(await pane.find({ key: 'group-in-progress' })).toBeUndefined()
  // The default pane: work, todo, compact, usage ticked; the rest not.
  expect(list.filter(t => t.startsWith('[x] '))).toHaveLength(4)
  expect(list).toContain('[ ] agents       who is live')
  // What the band or another block shows already is left off the list.
  for (const name of ['model', 'effort', 'clock', 'context']) expect(await pane.find({ key: `pick-${name}` })).toBeUndefined()
  // Ticks in the cap's orange, as blocks on the band is.
  // One colour a row: ticked orange, the rest grey.
  expect((await pane.find({ type: 'Text', text: /^\[x\] work/ }))?.props.color).toBe('#F27238')
  expect((await pane.find({ type: 'Text', text: /^\[ \] agents/ }))?.props.dimColor).toBe(true)
  await pane.press({ key: 'pick-agents' })
  await pane.press({ key: 'pick-work' })
  list = (await texts(pane)) as string[]
  expect(list.filter(t => t.startsWith('[x] '))).toHaveLength(4)
  // There is no Done: each tick is saved as it is made. The logo, modBOARD, shows the board: work gone, agents there.
  expect(await pane.find({ key: 'blocks-done' })).toBeFalsy()
  await band.press({ key: 'board' })
  expect(await pane.find({ key: 'group-in-progress' })).toBeUndefined()
  expect((await texts(pane)).some((t: string) => t.includes('codex'))).toBe(true)
  // Kept between sessions, with the setting it was ticked from.
  expect(kept.get('paneBlocks')).toEqual({ from: 'work,todo,compact,usage', blocks: ['todo', 'compact', 'usage', 'agents'] })
})

test('modBOARD on the list of blocks turns the pane to the board instead of closing it', { options: { band: 'summary,board' } } as any, async ($, on) => {
  host(on, [task('T-001', 'claimed', 'codex')])
  store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const closed: string[] = []
  on('ui.close', (_$, e: any) => {
    closed.push(e.id)
    return { value: undefined }
  })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  await band.press({ key: 'blocks' })
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  await band.press({ key: 'board' })
  expect(closed).toEqual([])
  expect(await label(pane, 'group-in-progress')).toBe('▾ In progress')
  await band.press({ key: 'board' })
  expect(closed).toEqual(['modboard'])
})

test('a pane changed in /config since the list was ticked wins over it', { options: { pane: 'work,agents' } } as any, async ($, on) => {
  host(on, [task('T-001', 'claimed', 'codex')])
  store(on, { paneBlocks: { from: 'work,todo,compact,usage', blocks: ['usage'] } })
  await $.session.start(START)
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await label(pane, 'group-in-progress')).toBe('▾ In progress')
})

test('the ticked list comes back in the next session', async ($, on) => {
  host(on, [task('T-001', 'claimed', 'codex')])
  store(on, { paneBlocks: { from: 'work,todo,compact,usage', blocks: ['agents'] } })
  await $.session.start(START)
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await pane.find({ key: 'group-in-progress' })).toBeUndefined()
  expect((await texts(pane)).some((t: string) => t.includes('codex'))).toBe(true)
})

test('blocks pressed again while the list shows closes the pane; from the board it shows the list', { options: { band: 'summary,board' } } as any, async ($, on) => {
  host(on, [task('T-001', 'claimed', 'codex')])
  store(on)
  const opened: string[] = []
  on('ui.open', (_$, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  const closed: string[] = []
  on('ui.close', (_$, e: any) => {
    closed.push(e.id)
    return { value: undefined }
  })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  await band.press({ key: 'blocks' })
  await band.press({ key: 'blocks' })
  expect(closed).toEqual(['modboard'])
  // With the board showing, it turns the pane to the list and keeps it open.
  await band.press({ key: 'board' })
  await band.press({ key: 'blocks' })
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect((await texts(pane))[0]).toBe('Blocks')
  expect(opened).toEqual(['modboard', 'modboard'])
  expect(closed).toEqual(['modboard'])
})

test('blocks of your own are on the list as one, checks, which shows them under a Checks heading', { options: { blocks: '{"ci": "echo green"}' } } as any, async ($, on) => {
  host(on, [])
  store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  await band.press({ key: 'blocks' })
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const listed = (await texts(pane)) as string[]
  expect(listed.some(t => t.startsWith('[ ] checks'))).toBe(true)
  expect(listed.some(t => / ci /.test(t))).toBe(false)
  await pane.press({ key: 'pick-checks' })
  await band.press({ key: 'board' })
  expect(await label(pane, 'group-checks')).toBe('▾ Checks')
  expect(await texts(pane)).toEqual(expect.arrayContaining(['ci', 'green']))
})

test('a command block that fails keeps its last result, says its age, then that it is not updating', { options: { blocks: '{"tests": "echo 42 passed"}', pane: 'checks' } } as any, async ($, on) => {
  const time = { now: NOW }
  const shell = { failing: new Set<string>() }
  host(on, [], { time, shell })
  // The commands' 30-second timer, run when the test says.
  let tick = () => {}
  on('clock.every', (_$, e: any) => (e.ms === 30_000 ? new Promise(resolve => (tick = () => resolve({ value: undefined }))) : new Promise(() => {})) as any)
  const run = async () => {
    tick()
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await $.session.start(START)
  let pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await texts(pane)).toEqual(expect.arrayContaining(['tests', '42 passed']))
  expect(((await texts(pane)) as string[]).some(t => /ago|updating/.test(t))).toBe(false)
  // It fails: the last result stays, and once it is old, it says how old, in grey.
  shell.failing.add('echo 42 passed')
  time.now = NOW + 6 * 60_000
  await run()
  expect(await texts(pane)).toContain('42 passed')
  expect((await pane.find({ type: 'Text', text: ' · 6 min ago' }))?.props.dimColor).toBe(true)
  // Failing for 5 minutes: not updating since its last success, in yellow.
  // (The state is as before, so nothing redraws on its own; in a session the
  // turning minute redraws the pane. Here a fresh drawing reads the new time.)
  time.now = NOW + 12 * 60_000
  await run()
  await pane.unmount()
  pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const stale = await pane.find({ type: 'Text', text: ' · not updating since 09:41' })
  expect(stale?.props.color).toBe('warning')
  expect(await texts(pane)).toContain('42 passed')
  // Folded, the heading names it in yellow.
  await pane.press({ key: 'group-checks' })
  expect((await pane.find({ type: 'Text', text: 'tests not updating' }))?.props.color).toBe('warning')
  await pane.press({ key: 'group-checks' })
  // It works again: fresh, nothing after it.
  shell.failing.clear()
  await run()
  expect(((await texts(pane)) as string[]).some(t => /ago|updating/.test(t))).toBe(false)
})

test('a handoff lists the files its work changed, as many as fit, then how many more', async ($, on) => {
  const files = ['api/auth.ts', 'src/login.tsx', 'src/form.css', 'src/routes.ts', 'test/login.test.ts']
  host(on, [{ ...task('T-005', 'todo'), notes: [{ at: '', by: 'claude 1', text: 'HANDOFF: half done', where: { ...WHERE, files } }] }], { home: '/Users/me' })
  await $.session.start(START)
  const wide = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 120 } } as any)
  expect(await texts(wide)).toContain('files')
  expect(await texts(wide)).toContain(files.join(', '))
  await wide.unmount()
  const narrow = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 60 } } as any)
  expect(await texts(narrow)).toContain('api/auth.ts, src/login.tsx +3')
  await narrow.unmount()
})

test('under Checks a success is green, a failure red, anything else plain', { options: { blocks: '{"ci": "echo success", "tests": "echo 1 failed, 41 passed", "unit": "echo ✓ 42 passed", "lint": "echo 42 passed, 0 failed", "branch": "echo login"}', pane: 'checks' } } as any, async ($, on) => {
  host(on, [])
  await $.session.start(START)
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const colour = async (text: string) => (await pane.find({ type: 'Text', text }))?.props.color
  expect(await colour('success')).toBe('success')
  expect(await colour('1 failed, 41 passed')).toBe('error')
  expect(await colour('✓ 42 passed')).toBe('success')
  expect(await colour('42 passed, 0 failed')).toBe('success')
  expect(await colour('login')).toBeUndefined()
})

test('a command that keeps working is not written again every run, so the pane is not redrawn for nothing', { options: { blocks: '{"ci": "echo success"}', pane: 'checks' } } as any, async ($, on) => {
  const time = { now: NOW }
  host(on, [], { time })
  let tick = () => {}
  on('clock.every', (_$, e: any) => (e.ms === 30_000 ? new Promise(resolve => (tick = () => resolve({ value: undefined }))) : new Promise(() => {})) as any)
  const writes: string[] = []
  on('state.set', (_$, e: any, next: any) => {
    if (String(e.key ?? e.name ?? '').includes('commandState')) writes.push(String(time.now))
    return next(e)
  })
  await $.session.start(START)
  // The first run starts with the session but doesn't hold up its start.
  await new Promise(resolve => setTimeout(resolve, 20))
  const before = writes.length
  // The first run is written: the test sees writes.
  expect(before).toBeGreaterThan(0)
  for (const after of [30, 60, 90]) {
    time.now = NOW + after * 1000
    tick()
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(writes.length).toBe(before)
})

test('checks with no blocks of your own says where to add one', { options: { pane: 'checks' } } as any, async ($, on) => {
  host(on, [])
  await $.session.start(START)
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await texts(pane)).toContain('No command blocks yet: add one under Your own blocks in /config.')
})

test('agents is one line: Live, then a green dot for each agent seen lately and a grey one for the quiet', { options: { pane: 'agents' } } as any, async ($, on) => {
  const ago = (s: number) => new Date(NOW - s * 1000).toISOString()
  host(on, [], { live: [{ name: 'claude 1', lastSeen: ago(10) }, { name: 'codex 1', lastSeen: ago(150) }] })
  await $.session.start(START)
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const shown = (await texts(pane)) as string[]
  expect(shown.slice(0, 5)).toEqual(['Live', '● ', 'claude 1 (you)', '○ ', 'codex 1'])
  expect((await pane.find({ type: 'Text', text: '● ' }))?.props.color).toBe('success')
  // Nothing here is pressable, so nothing is white: grey words, a green dot.
  for (const text of ['Live', 'claude 1 (you)', 'codex 1']) expect((await pane.find({ type: 'Text', text }))?.props.dimColor).toBe(true)
  expect(shown.some(t => t.startsWith('live:'))).toBe(false)
})

// ── The pixel clock, the weather and the alarm ──────────────────────────────

// Open-Meteo, as the host's fetch answers it: the place, then the weather.
function openMeteo(on: On, { down = false } = {}) {
  const urls: string[] = []
  on('http.fetch', (_$, e: any) => {
    urls.push(e.url)
    if (down) return { value: { status: 503, ok: false, headers: {}, text: '' } }
    const text = e.url === 'https://ipapi.co/json/'
      ? JSON.stringify({ city: 'Bengaluru', latitude: 12.97, longitude: 77.59 })
      : e.url.includes('geocoding')
      ? JSON.stringify({ results: [{ latitude: 12.97, longitude: 77.59, name: 'Bengaluru' }] })
      : JSON.stringify({ current: { temperature_2m: 18.4, weather_code: 0 }, daily: { temperature_2m_max: [24.2] } })
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  return urls
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const PIXEL = { options: { band: 'pixel-clock,weather', pane: 'pixel-clock', location: 'Bengaluru' } } as any

test('the pixel clock draws the time three rows tall, with the weather beside it', PIXEL, async ($, on) => {
  host(on, [])
  store(on)
  const urls = openMeteo(on)
  await $.session.start(START)
  await settle()
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const shown = await texts(pane)
  expect(shown[0]).toBe('▾ Clock')
  expect(shown.slice(1, 4)).toEqual(['█▀█ █▀█   █ █ ▀█ ', '█ █ ▀▀█ ▀ ▀▀█  █ ', '█▄█ ▄▄█ ▀   █ ▄█▄'])
  expect(shown.slice(4)).toEqual(['☀ 18°  Bengaluru', 'clear · H 24°'])
  // Only the location is sent, and only to Open-Meteo.
  expect(urls.every(u => u.startsWith('https://geocoding-api.open-meteo.com/') || u.startsWith('https://api.open-meteo.com/'))).toBe(true)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(band)).toEqual(['09:41', '☀ 18°'])
})

test('with no location set, nothing is fetched and the clock stands alone', { options: { pane: 'pixel-clock' } } as any, async ($, on) => {
  host(on, [])
  store(on)
  const urls = openMeteo(on)
  await $.session.start(START)
  await settle()
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(urls).toEqual([])
  expect((await texts(pane)).slice(4)).toEqual(['weather: /board location'])
})

test('offline, the weather keeps the last reading and says how old it is', PIXEL, async ($, on) => {
  host(on, [])
  store(on, { configPlace: { from: 'Bengaluru', place: { latitude: 12.97, longitude: 77.59, name: 'Bengaluru' } }, weather: { from: '12.97,77.59|false', reading: { temp: 21, high: 26, code: 61, place: 'Bengaluru', at: NOW - 90 * 60_000 } } })
  openMeteo(on, { down: true })
  await $.session.start(START)
  await settle()
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await texts(pane)).toContain('rain · H 26° · 90 min old')
})

test('an alarm set for this minute rings: toast, notification, sound, and a stop button', { options: { band: 'pixel-clock', pane: 'pixel-clock', alarm: '9:41' } } as any, async ($, on) => {
  host(on, [])
  store(on)
  const toasts: string[] = []
  const notes: string[] = []
  const played: any[] = []
  on('ui.toast', (_$, e: any) => (toasts.push(e.text), { value: undefined }))
  on('ui.notify', (_$, e: any) => (notes.push(e.text), { value: { isSent: true, channel: 'test' } }))
  on('audio.play', (_$, e: any) => (played.push(e), { value: undefined }))
  on('clock.sleep', () => new Promise(() => {}) as any)
  await $.session.start(START)
  await settle()
  expect(toasts).toContain('⏰ 09:41')
  expect(notes).toEqual(["It's 09:41."])
  expect(played).toHaveLength(1)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(band)).toEqual(['⏰ 09:41'])
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  await pane.press({ key: 'alarm-stop' })
  expect(await texts(band)).toEqual(['09:41  ⏰ 09:41'])
})

test('/board alarm sets, lists and clears alarms, kept between sessions', { options: { band: 'pixel-clock' } } as any, async ($, on) => {
  host(on, [])
  const kept = store(on)
  await $.session.start(START)
  const run = async (args: string) => ((await $.command.run({ command: 'board', args } as any)) as any).text
  expect(await run('alarm')).toBe('No alarm set.')
  expect(await run('alarm 7:30pm')).toBe('Alarm set for 19:30.')
  expect(await run('alarm 07:05')).toBe('Alarm set for 07:05, 19:30.')
  expect(await run('alarm tea')).toMatch(/is not a time/)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(band)).toEqual(['09:41  ⏰ 19:30'])
  expect((kept.get('alarms') as any).times).toEqual(['07:05', '19:30'])
  expect(await run('alarm off 19:30')).toBe('Alarm set for 07:05.')
  expect(await run('alarm off')).toBe('Alarm off.')
})

// What rang: toasts and notifications, and how many chimes played.
function bell(on: On) {
  const rung = { toasts: [] as string[], notes: [] as string[], chimes: 0 }
  on('ui.toast', (_$, e: any) => (rung.toasts.push(e.text), { value: undefined }))
  on('ui.notify', (_$, e: any) => (rung.notes.push(e.text), { value: { isSent: true, channel: 'test' } }))
  on('audio.play', () => (rung.chimes++, { value: undefined }))
  on('clock.sleep', () => new Promise(() => {}) as any)
  return rung
}

test('a task flagged to ring rings when it turns done, whoever finished it; one done before stays quiet', { options: { band: 'pixel-clock' } } as any, async ($, on) => {
  const flagged = { ...task('T-004', 'claimed', 'codex 1'), title: 'Ship release', ring: true }
  const before = { ...task('T-001', 'done'), ring: true }
  const list = [flagged, before, task('T-002', 'claimed', 'codex 1')]
  host(on, list)
  store(on)
  const rung = bell(on)
  await $.session.start(START)
  await settle()
  expect(rung.toasts.filter(t => t.startsWith('⏰'))).toEqual([])
  // Codex finishes both; only the flagged one rings.
  list[0] = { ...flagged, status: 'done', claim: null, notes: [{ at: '', by: 'codex 1', text: 'VERIFIED: tagged v1.0' }] }
  list[2] = { ...task('T-002', 'done') }
  // Any board tool reads the board again, as the 3-second poll does.
  await $.tool.call({ tool: 'mcp__modboard__board_list' } as any)
  await settle()
  expect(rung.toasts).toContain('⏰ T-004 done · Ship release')
  expect(rung.notes).toEqual(['T-004 done: Ship release (by codex 1)'])
  expect(rung.chimes).toBe(3)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(band)).toEqual(['⏰ T-004 done · Ship release'])
})

test('board_add with ring flags the task on the board', async ($, on) => {
  const calls = host(on, [])
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__modboard__board_add', title: 'Ship release', ring: true } as any)
  expect(calls.find(argv => argv.includes('add'))?.slice(2)).toEqual(['add', '--ring', '--as', 'claude 1', '--', 'Ship release'])
})

test('board_claim with no id takes the next ready task; board_add and board_done pass waits, labels and review', async ($, on) => {
  const calls = host(on, [])
  await $.session.start(START)
  const argv = (cmd: string) => calls.findLast(a => a.includes(cmd))?.slice(2)
  await $.tool.call({ tool: 'mcp__modboard__board_claim', labels: ['kind=bug'] } as any)
  expect(argv('claim')).toEqual(['claim', '--next', '--label', 'kind=bug', '--as', 'claude 1'])
  await $.tool.call({ tool: 'mcp__modboard__board_claim', id: 'T-004' } as any)
  expect(argv('claim')).toEqual(['claim', 'T-004', '--as', 'claude 1'])
  await $.tool.call({ tool: 'mcp__modboard__board_add', title: 'Ship', after: ['T-001', 'T-002'], labels: ['kind=release'] } as any)
  expect(argv('add')).toEqual(['add', '--after', 'T-001,T-002', '--label', 'kind=release', '--as', 'claude 1', '--', 'Ship'])
  await $.tool.call({ tool: 'mcp__modboard__board_done', id: 'T-004', note: 'ran it', review: true } as any)
  expect(argv('done')).toEqual(['done', 'T-004', '--note=ran it', '--review', '--as', 'claude 1'])
})

test('board_alarm rings now with its note, but not twice in a minute, and needs a note', { options: { band: 'pixel-clock' } } as any, async ($, on) => {
  host(on, [])
  store(on)
  const rung = bell(on)
  await $.session.start(START)
  const alarm = async (input: object) => ((await $.tool.call({ tool: 'mcp__modboard__board_alarm', ...input } as any)) as any).result
  expect(await alarm({ note: '' })).toMatch(/needs a note/)
  expect(await alarm({ note: 'deploy is green' })).toBe('rang the alarm: deploy is green')
  await settle()
  expect(rung.notes).toEqual(['deploy is green'])
  expect(await alarm({ note: 'again' })).toMatch(/not twice in a minute/)
})

test('board_alarm sets a one-off alarm at a time or in minutes, shown on the clock and in /board alarm', { options: { band: 'pixel-clock', pane: 'pixel-clock' } } as any, async ($, on) => {
  host(on, [])
  const kept = store(on)
  await $.session.start(START)
  const alarm = async (input: object) => ((await $.tool.call({ tool: 'mcp__modboard__board_alarm', ...input } as any)) as any).result
  expect(await alarm({ note: 'check the deploy', inMinutes: 20 })).toBe('the alarm rings once at 10:01: check the deploy')
  expect(await alarm({ note: 'standup', at: '6pm' })).toBe('the alarm rings once at 18:00: standup')
  expect(await alarm({ note: 'x', at: 'soon' })).toMatch(/is not a time/)
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await texts(pane)).toContain('⏰ 10:01 · check the deploy · 2 set')
  expect((kept.get('reminders') as any).map((r: any) => r.at)).toEqual(['10:01', '18:00'])
  const listed = ((await $.command.run({ command: 'board', args: 'alarm' } as any)) as any).text
  expect(listed).toBe('Once at 10:01: check the deploy\nOnce at 18:00: standup')
})

test('board_alarm_off clears one-off alarms, all or just one time', { options: { band: 'pixel-clock' } } as any, async ($, on) => {
  host(on, [])
  const kept = store(on)
  await $.session.start(START)
  const call = async (tool: string, input: object) => ((await $.tool.call({ tool: `mcp__modboard__${tool}`, ...input } as any)) as any).result
  await call('board_alarm', { note: 'a', at: '14:00' })
  await call('board_alarm', { note: 'b', at: '18:00' })
  expect(await call('board_alarm_off', { at: 'soon' })).toMatch(/is not a time/)
  await call('board_alarm_off', { at: '2pm' })
  expect((kept.get('reminders') as any).map((r: any) => r.at)).toEqual(['18:00'])
  expect(await call('board_alarm_off', {})).toBe('Alarm off.')
  expect(kept.get('reminders')).toEqual([])
})

test('a one-off alarm rings once at its minute with its note, then is gone', { options: { band: 'pixel-clock' } } as any, async ($, on) => {
  host(on, [])
  const kept = store(on, { reminders: [{ at: '09:41', note: 'check the deploy' }, { at: '18:00', note: 'standup' }] })
  const rung = bell(on)
  await $.session.start(START)
  await settle()
  expect(rung.toasts).toContain('⏰ 09:41 · check the deploy')
  expect(rung.notes).toEqual(['check the deploy'])
  expect(kept.get('reminders')).toEqual([{ at: '18:00', note: 'standup' }])
})

// The question dialog, answered with `answer`; undefined stands for Esc.
function asks(on: On, answer: string | undefined) {
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' } as any, (_$, e: any) => {
    const question = e.questions?.[0]?.question
    asked.push(question)
    if (answer === undefined) throw new Error('dismissed')
    return { result: { questions: e.questions, answers: { [question]: answer } } } as any
  })
  return asked
}

const pickClock = async ($: any) => {
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  await band.press({ key: 'blocks' })
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  await pane.press({ key: 'pick-pixel-clock' })
  await band.press({ key: 'board' })
  await settle()
  return pane
}
const CHOOSE = { options: { band: 'summary,board' } } as any

test('ticking the pixel clock asks for a location; a typed city gets the weather', CHOOSE, async ($, on) => {
  host(on, [])
  const kept = store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  openMeteo(on)
  const asked = asks(on, 'Bengaluru')
  const pane = await pickClock($)
  expect(asked).toHaveLength(1)
  expect(await texts(pane)).toContain('☀ 18°  Bengaluru')
  expect((kept.get('location') as any).name).toBe('Bengaluru')
})

test('Use my location reads the city from the IP, once', CHOOSE, async ($, on) => {
  host(on, [])
  const kept = store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const urls = openMeteo(on)
  asks(on, 'Use my location (from my IP)')
  await $.session.start(START)
  await pickClock($)
  expect((kept.get('location') as any).name).toBe('Bengaluru')
  expect(urls.filter(u => u === 'https://ipapi.co/json/')).toHaveLength(1)
  expect(urls.some(u => u.startsWith('https://api.open-meteo.com/'))).toBe(true)
})

test('Esc means no weather and ticking again does not ask again; /board location asks again', CHOOSE, async ($, on) => {
  host(on, [])
  store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const urls = openMeteo(on)
  const asked = asks(on, undefined)
  await $.session.start(START)
  const pane = await pickClock($)
  expect(asked).toHaveLength(1)
  expect(urls).toEqual([])
  expect(await texts(pane)).toContain('weather: /board location')
  // Unticked and ticked again: no second question.
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  await band.press({ key: 'blocks' })
  await pane.press({ key: 'pick-pixel-clock' })
  await pane.press({ key: 'pick-pixel-clock' })
  await band.press({ key: 'board' })
  await settle()
  expect(asked).toHaveLength(1)
  const said = ((await $.command.run({ command: 'board', args: 'location' } as any)) as any).text
  expect(asked).toHaveLength(2)
  expect(said).toMatch(/No weather for now/)
})

test('board_location lets Claude ask when the person says to add a location for the weather', async ($, on) => {
  host(on, [])
  const kept = store(on)
  openMeteo(on)
  asks(on, 'Bengaluru')
  await $.session.start(START)
  const out = ((await $.tool.call({ tool: 'mcp__modboard__board_location' } as any)) as any).result
  expect(out).toBe('Weather for Bengaluru. Change it with /board location.')
  expect((kept.get('location') as any).name).toBe('Bengaluru')
})

test('a task done while the mod reloads still rings: what was seen done outlives the reload', { options: { band: 'pixel-clock' } } as any, async ($, on) => {
  const list = [{ ...task('T-003', 'claimed', 'me'), title: 'Alarm demo', ring: true }]
  host(on, list)
  store(on)
  const rung = bell(on)
  await $.session.start(START)
  await settle()
  list[0] = { ...list[0]!, status: 'done', claim: null }
  // A reload runs session.start again; the next read must still ring.
  await $.session.start(START)
  await settle()
  expect(rung.toasts).toContain('⏰ T-003 done · Alarm demo')
})

test('stop is bold green, like Done, beside the yellow alarm line', { options: { pane: 'pixel-clock', alarm: '9:41' } } as any, async ($, on) => {
  host(on, [])
  store(on)
  bell(on)
  await $.session.start(START)
  await settle()
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const stop = (await pane.find({ type: 'Text', text: 'stop' }))?.props
  expect([stop?.color, stop?.bold]).toEqual(['success', true])
  expect((await pane.find({ type: 'Text', text: '⏰ 09:41' }))?.props.color).toBe('warning')
})

test('an agent alarm at 1:30 with no am or pm rings at the next 1:30; 13:30 and am/pm are taken as said', async ($, on) => {
  // NOW is 09:41.
  host(on, [])
  store(on)
  await $.session.start(START)
  const alarm = async (at: string) => ((await $.tool.call({ tool: 'mcp__modboard__board_alarm', note: 'n', at } as any)) as any).result
  expect(await alarm('1:30')).toBe('the alarm rings once at 13:30: n')
  expect(await alarm('9:30')).toBe('the alarm rings once at 21:30: n')
  expect(await alarm('10:00')).toBe('the alarm rings once at 10:00: n')
  expect(await alarm('12:15')).toBe('the alarm rings once at 12:15: n')
  expect(await alarm('13:30')).toBe('the alarm rings once at 13:30: n')
  expect(await alarm('1:30am')).toBe('the alarm rings once at 01:30: n')
  expect(await alarm('01:30')).toBe('the alarm rings once at 01:30: n')
})

test('the alarm sits third in the column beside the digits, and a note that only repeats the time is left out', { options: { pane: 'pixel-clock', location: 'Bengaluru' } } as any, async ($, on) => {
  host(on, [])
  store(on, { reminders: [{ at: '14:00', note: 'Alarm set for 2 PM' }] })
  openMeteo(on)
  await $.session.start(START)
  await settle()
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect((await texts(pane)).slice(4)).toEqual(['☀ 18°  Bengaluru', 'clear · H 24°', '⏰ 14:00'])
  // Narrow, the column goes under the digits.
  await pane.unmount()
  const narrow = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 30 } } as any)
  expect((await texts(narrow)).slice(4)).toEqual(['☀ 18°  Bengaluru', 'clear · H 24°', '⏰ 14:00'])
})

test('a note that says more than the time stays', { options: { pane: 'pixel-clock' } } as any, async ($, on) => {
  host(on, [])
  store(on, { reminders: [{ at: '14:00', note: 'check the deploy' }] })
  await $.session.start(START)
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect((await texts(pane)).slice(4)).toEqual(['weather: /board location', '⏰ 14:00 · check the deploy'])
})

// The logo's orange (CAP in hooks/blocks/board.tsx).
const CAP_COLOR = '#F27238'
const ORDER = { options: { band: 'summary,board', pane: 'work,usage,compact,pixel-clock' } } as any
const openOrder = async ($: any, on: On) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  await band.press({ key: 'blocks' })
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  await pane.press({ key: 'tab-order' })
  return pane
}
const order = async (pane: any) => ((await texts(pane)) as string[]).filter(t => /^ ?\d+  /.test(t)).map(t => t.trim().split(/\s+/)[1])

test('the list has two tabs: Blocks ticks, Order lists the ticked blocks numbered, in the board order', ORDER, async ($, on) => {
  host(on, [])
  store(on)
  const pane = await openOrder($, on)
  expect(((await texts(pane)) as string[]).slice(0, 3)).toEqual(['Blocks', 'Order', `${' '.repeat(10)}━━━━━`])
  // The two bars are one row, as the pane draws them under one Limits heading.
  expect(await order(pane)).toEqual(['work', 'limits', 'pixel-clock'])
  expect(((await texts(pane)) as string[]).some(t => t.startsWith(' 2  limits (usage, compact)'))).toBe(true)
  // No ▲ on the first, no ▼ on the last; nothing else to press but the arrows.
  for (const [key, there] of [['up-work', false], ['down-work', true], ['up-pixel-clock', true], ['down-pixel-clock', false], ['top-compact', false], ['bottom-usage', false]] as const)
    expect(!!(await pane.find({ key }))).toBe(there)
  await pane.press({ key: 'tab-blocks' })
  expect(((await texts(pane)) as string[])[2]).toBe('━━━━━━')
  expect(await pane.find({ key: 'pick-agents' })).toBeTruthy()
})

test('▲ and ▼ move a block a place; the board follows and the order is kept; the moved row lights up', ORDER, async ($, on) => {
  host(on, [])
  const kept = store(on)
  let pass = () => {}
  on('clock.sleep', () => new Promise(resolve => (pass = () => resolve({ value: undefined }))) as any)
  const pane = await openOrder($, on)
  const row = async (start: string) => ((await pane.findAll({ type: 'Text' })) as any[]).find(t => t.text.startsWith(start))
  const pressed = pane.press({ key: 'up-pixel-clock' })
  await settle()
  expect(await order(pane)).toEqual(['work', 'pixel-clock', 'limits'])
  expect((await row(' 2  pixel-clock'))?.props.color).toBe(CAP_COLOR)
  pass()
  await pressed
  expect((await row(' 2  pixel-clock'))?.props.color).toBeUndefined()
  expect((kept.get('paneBlocks') as any).blocks).toEqual(['work', 'pixel-clock', 'usage', 'compact'])
  const p1 = pane.press({ key: 'up-pixel-clock' }); await settle(); pass(); await p1
  expect(await order(pane)).toEqual(['pixel-clock', 'work', 'limits'])
  const p2 = pane.press({ key: 'down-work' }); await settle(); pass(); await p2
  expect((kept.get('paneBlocks') as any).blocks).toEqual(['pixel-clock', 'usage', 'compact', 'work'])
  // The bars move as one.
  const p3 = pane.press({ key: 'up-limits' }); await settle(); pass(); await p3
  expect((kept.get('paneBlocks') as any).blocks).toEqual(['usage', 'compact', 'pixel-clock', 'work'])
  await (await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)).press({ key: 'board' })
  expect(await pane.find({ key: 'tab-order' })).toBeFalsy()
})

test('bars apart in the order are one limits row, where the first sits, as the pane draws them', { options: { band: 'summary,board', pane: 'work,usage,todo,checks,compact,agents' } } as any, async ($, on) => {
  host(on, [])
  store(on)
  const pane = await openOrder($, on)
  expect(await order(pane)).toEqual(['work', 'limits', 'todo', 'checks', 'agents'])
})

test('every row shows ▲ and ▼; the first row\'s ▲ and the last row\'s ▼ are grey and do nothing', ORDER, async ($, on) => {
  host(on, [])
  store(on)
  const pane = await openOrder($, on)
  const arrows = ((await pane.findAll({ type: 'Text' })) as any[]).filter(t => /^\[ [▲▼] \]$/.test(t.text))
  expect(arrows).toHaveLength(6)
  expect(arrows.filter(t => t.props.dimColor).map(t => t.text)).toEqual(['[ ▲ ]', '[ ▼ ]'])
  expect(await pane.find({ key: 'up-work' })).toBeFalsy()
  expect(await pane.find({ key: 'down-pixel-clock' })).toBeFalsy()
})

test('every ▲ and every ▼ moves its block one place, on the terminal and the desktop app; grey ones do nothing', ORDER, async ($, on) => {
  host(on, [])
  const kept = store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.sleep', () => ({ value: undefined }))
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  await band.press({ key: 'blocks' })
  const start = ['work', 'usage', 'compact', 'pixel-clock']
  // The Order rows: the bars are one, `limits`.
  const BARS = ['usage', 'compact']
  const rows = (names: string[]) => names.filter(n => !BARS.includes(n) || n === names.find(m => BARS.includes(m))).map(n => (BARS.includes(n) ? 'limits' : n))
  const flat = (keys: string[]) => keys.flatMap(k => (k === 'limits' ? BARS : [k]))
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'modboard', surface, ...PANE } as any)
    await pane.press({ key: 'tab-order' })
    const now = () => (kept.get('paneBlocks') as any)?.blocks ?? start
    for (let at = 0; at < rows(start).length; at++) {
      for (const by of [-1, 1] as const) {
        const before = [...now()]
        const keys = rows(before)
        const name = keys[at]!
        const key = `${by < 0 ? 'up' : 'down'}-${name}`
        const to = at + by
        if (to < 0 || to >= keys.length) {
          // The grey arrow: nothing to press, nothing changes.
          expect(await pane.find({ key })).toBeFalsy()
          continue
        }
        await pane.press({ key })
        const want = [...keys]
        want[at] = keys[to]!
        want[to] = name
        expect(now()).toEqual(flat(want))
        // And back, so each row is tried from its own place.
        await pane.press({ key: `${by < 0 ? 'down' : 'up'}-${name}` })
        expect(now()).toEqual(before)
      }
    }
    await pane.unmount()
  }
})

test('at the right of the tabs, in yellow, what was saved: added, removed, order changed; nothing when nothing changed', ORDER, async ($, on) => {
  host(on, [])
  store(on)
  const toasts: string[] = []
  on('ui.toast', (_$, e: any) => (toasts.push(e.text), { value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.sleep', () => ({ value: undefined }))
  asks(on, undefined)
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  await band.press({ key: 'blocks' })
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const note = async () => ((await pane.findAll({ type: 'Text' })) as any[]).find(t => t.props.color === 'warning')
  expect(await note()).toBeUndefined()
  await pane.press({ key: 'pick-agents' })
  await pane.press({ key: 'pick-usage' })
  expect((await note())?.text).toBe('saved · added agents · removed usage')
  await pane.press({ key: 'tab-order' })
  await pane.press({ key: 'up-pixel-clock' })
  expect((await note())?.text).toBe('saved · added agents · removed usage · order changed')
  // Ticked back and moved back: nothing to say.
  await pane.press({ key: 'down-pixel-clock' })
  await pane.press({ key: 'tab-blocks' })
  await pane.press({ key: 'pick-agents' })
  await pane.press({ key: 'pick-usage' })
  // compact off and on, so the bars read usage, compact again (work, pixel-clock, usage, compact).
  await pane.press({ key: 'pick-compact' })
  await pane.press({ key: 'pick-compact' })
  await pane.press({ key: 'tab-order' })
  // The bars are one limits row: a place up puts them where they were.
  await pane.press({ key: 'up-limits' })
  expect(await note()).toBeUndefined()
  await band.press({ key: 'board' })
  await settle()
  // modBOARD shows the board; no corner notification.
  expect(toasts.filter(t => t.startsWith('board:'))).toEqual([])
})

test('the clock has a Clock heading that folds to one line: the time, the weather and the alarm', { options: { pane: 'pixel-clock', location: 'Bengaluru' } } as any, async ($, on) => {
  host(on, [])
  store(on, { reminders: [{ at: '14:00', note: 'check the deploy' }] })
  openMeteo(on)
  await $.session.start(START)
  await settle()
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await label(pane, 'group-clock')).toBe('▾ Clock')
  await pane.press({ key: 'group-clock' })
  expect(await texts(pane)).toEqual(['▸ Clock', ' · 09:41 · ☀ 18° · ⏰ 14:00 · check the deploy'])
  await pane.press({ key: 'group-clock' })
  expect((await texts(pane))[1]).toBe('█▀█ █▀█   █ █ ▀█ ')
})

test('a tool call still running renews the claims with each presence ping, so it cannot outlast the lease', async ($, on) => {
  const calls = host(on, [{ ...task('T-001', 'claimed', 'claude 1'), claim: { owner: 'claude 1', since: '', expiresAt: inMinutes(14) } }])
  let ping = async () => {}
  on('clock.every', (_$, e: any) => (e.ms === 60_000 ? new Promise(resolve => (ping = async () => resolve({ value: undefined }))) : new Promise(() => {})) as any)
  // A Bash call that runs for a long time: it ends only when the test says.
  let finish = () => {}
  on('tool.call', { tool: 'Bash' } as any, () => new Promise(resolve => (finish = () => resolve({ result: 'done' } as any))) as any)
  await $.session.start(START)
  const beats = () => calls.filter(argv => argv[2] === 'heartbeat').length
  const call = $.tool.call({ tool: 'Bash', command: 'npm test' } as any)
  await new Promise(resolve => setTimeout(resolve, 20))
  const before = beats()
  await ping()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(beats()).toBe(before + 1)
  finish()
  await call
})

test('a one-off alarm whose minute was slept through rings when the session sees it; one an hour late is told as missed', { options: { band: 'pixel-clock' } } as any, async ($, on) => {
  host(on, [])
  // NOW reads 09:41. One due 10 minutes ago (the minute was slept through),
  // one due two hours ago (missed), one still to come.
  const kept = store(on, {
    reminders: [
      { at: '09:31', note: 'slept through', due: NOW - 10 * 60_000 },
      { at: '07:41', note: 'long gone', due: NOW - 120 * 60_000 },
      { at: '18:00', note: 'standup', due: NOW + 60 * 60_000 },
    ],
  })
  const rung = bell(on)
  await $.session.start(START)
  await settle()
  expect(rung.notes).toEqual(['slept through'])
  expect(rung.toasts.some((t: string) => t.includes('missed: 07:41 · long gone'))).toBe(true)
  expect((kept.get('reminders') as any).map((r: any) => r.note)).toEqual(['standup'])
})

test('the done group shows the newest twenty, then how many more', async ($, on) => {
  const done = Array.from({ length: 25 }, (_, i) => ({ ...task(`T-${String(i + 1).padStart(3, '0')}`, 'done'), notes: [{ at: new Date(NOW - (25 - i) * 60_000).toISOString(), by: 'codex', text: 'VERIFIED: ok' }] }))
  host(on, done)
  store(on, {})
  await $.session.start(START)
  const pane = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  await pane.press({ key: 'group-done' })
  const shown = await texts(pane)
  expect(shown).toContain(' · 25')
  expect(shown).toContain('title of T-025')
  expect(shown).not.toContain('title of T-005')
  expect(shown).toContain('… 5 more: board list --all')
})

test('a storage block the board may not run is named in words, not JSON, in the toast and the pane', async ($, on) => {
  host(on, [], { untrusted: true })
  const rung = bell(on)
  await $.session.start(START)
  const toast = rung.toasts.find(t => t.includes('only runs blocks you installed'))
  expect(toast).toBe('board: storage block "./cloned.mjs" is a file in this project, and modBOARD only runs blocks you installed yourself: read it, then run board block add at a terminal. The block: /repo/.modboard/cloned.mjs, named in /repo/.modboard/config.json')
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const shown = (await texts(ui)) as string[]
  // A heading, the reason in words, then the files on rows of their own.
  const at = shown.indexOf('board not updating')
  expect(shown[at + 1]).toBe('storage block "./cloned.mjs" is a file in this project, and modBOARD only runs blocks you installed yourself: read it, then run board block add at a terminal.')
  expect(shown.slice(at + 2, at + 6)).toEqual(['block', '/repo/.modboard/cloned.mjs', 'config', '/repo/.modboard/config.json'])
  expect(shown.some(t => t.includes('{"error"'))).toBe(false)
  // The reason wraps, never cut: it says what to do.
  const line = await ui.find({ type: 'Text', text: `storage block "./cloned.mjs" is a file in this project, and modBOARD only runs blocks you installed yourself: read it, then run board block add at a terminal.` })
  expect(line?.props.wrap).toBeUndefined()
})

test('the board error sits under the work title when work comes first, and on top when it does not', async ($, on) => {
  const broken = { now: true }
  host(on, [task('T-001', 'todo')], { broken })
  const kept = store(on)
  await $.session.start(START)
  const ERROR = 'board not updating'
  const first = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  let shown = (await texts(first)) as string[]
  await first.unmount()
  // modBOARD · claude 1, then the error, then the tasks.
  expect(shown.indexOf('modBOARD')).toBeLessThan(shown.indexOf(ERROR))
  expect(shown.indexOf(ERROR)).toBeLessThan(shown.indexOf('title of T-001') < 0 ? Infinity : shown.indexOf('title of T-001'))
  expect(shown.filter(t => t === ERROR).length).toBe(1)

  // Work moved below the bars: the error goes first, once.
  kept.set('paneBlocks', { from: 'work,todo,compact,usage', blocks: ['compact', 'usage', 'work'] })
  await $.session.start(START)
  shown = (await texts(await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any))) as string[]
  expect(shown.indexOf(ERROR)).toBeLessThan(shown.indexOf('modBOARD'))
  expect(shown.filter(t => t === ERROR).length).toBe(1)
})

test('a board that cannot be read is not called empty', { options: {} } as any, async ($, on) => {
  host(on, [], { untrusted: true })
  bell(on)
  await $.session.start(START)
  const shown = (await texts(await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any))) as string[]
  expect(shown).toContain('board not updating')
  expect(shown.some(t => t.startsWith('No tasks yet'))).toBe(false)
})

test('a long path in the board error is cut from the start to fit the pane', async ($, on) => {
  host(on, [], { untrusted: true })
  bell(on)
  await $.session.start(START)
  expect(splitProblem('cannot read it')).toEqual({ message: 'cannot read it', files: [] })
  expect(splitProblem('storage block "x" isn\'t installed: ask. Named in /r/.modboard/config.json')).toEqual({ message: 'storage block "x" isn\'t installed: ask.', files: [['config', '/r/.modboard/config.json']] })
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 30 } } as any)
  const shown = (await texts(ui)) as string[]
  const path = shown[shown.indexOf('block') + 1]!
  expect(path.startsWith('…')).toBe(true)
  expect(path.endsWith('cloned.mjs')).toBe(true)
})

test('the board error rows copy their file paths, like a handoff path; nothing offers to approve the code', async ($, on) => {
  host(on, [], { untrusted: true })
  on('ui.toast', () => ({ value: undefined }))
  const copies: string[] = []
  on('ui.copy', (_$, e: any) => {
    copies.push(e.text)
    return { value: { isCopied: true } }
  })
  let pass = () => {}
  on('clock.sleep', () => new Promise(resolve => (pass = () => resolve({ value: undefined }))) as any)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as any)
  expect(await ui.find({ key: 'copy-problem-run' })).toBeFalsy()
  const pressed = ui.press({ key: 'copy-problem-config' })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(copies).toEqual(['/repo/.modboard/config.json'])
  expect(await texts(ui)).toContain('✓ copied')
  pass()
  await pressed
  const second = ui.press({ key: 'copy-problem-block' })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(copies.at(-1)).toBe('/repo/.modboard/cloned.mjs')
  pass()
  await second
  await ui.unmount()
})
