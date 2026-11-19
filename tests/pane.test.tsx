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
  }: { agent?: string; taken?: string[]; effort?: string; envEffort?: string; modelEffort?: string; taskfile?: TaskFile } = {},
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
  on('env.get', (_$, e: any) => ({ value: e.name === 'BOARD_AGENT' ? agent : e.name === 'CLAUDE_CODE_EFFORT_LEVEL' ? envEffort : undefined }))
  // The effortLevel setting, which /effort saves: where a session starts.
  on('settings.read', () => ({ value: { ...(effort === undefined ? {} : { effortLevel: effort }), ...(modelEffort ? { modelSettings: { 'claude-sonnet-5-5': { effortLevel: modelEffort } } } : {}) } }))
  on('process.run', (_$, e: any) => {
    const argv: string[] = [...e.argv]
    calls.push(argv)
    const refused = argv[2] === 'register' && taken.includes(argv[3]!)
    // A command block's shell: `echo x` prints x, `false` fails.
    if (argv[0] === 'sh') {
      const cmd = argv[2]!
      const failed = cmd === 'false'
      return { value: { exitCode: failed ? 1 : 0, stdout: failed ? '' : `\n${cmd.replace(/^echo /, '')}\nsecond line`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const stdout =
      argv[2] === 'view' ? JSON.stringify({ tasks, agents: [{ name: 'codex', lastSeen: '' }] }) : argv[2] === 'taskfile' ? JSON.stringify(taskfile) : 'ok'
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

test('the pane groups in progress, then not started, and counts done', async ($, on) => {
  host(on, [
    task('T-002', 'todo'),
    { ...task('T-001', 'claimed', 'claude:aaaa1111'), claim: { owner: 'claude:aaaa1111', since: '', expiresAt: inMinutes(11) } },
    task('T-003', 'claimed', 'codex'),
    task('T-004', 'done'),
  ])
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'modboard', surface, ...PANE, props: { ...PANE.props, bodyColumns: 80 } } as any)
    // Each group's heading is a button that says how many it holds. What is
    // in progress starts open; what nobody has started starts closed.
    expect(await label(ui, 'group-in-progress')).toBe('▾ In progress · 2')
    expect(await label(ui, 'group-not-started')).toBe('▸ Not started · 1')
    let shown = await texts(ui)
    expect(shown.indexOf('title of T-001')).toBeLessThan(shown.indexOf('title of T-003'))
    expect(shown).not.toContain('title of T-002')
    // The heading says what is happening; the row only says who.
    expect(shown).toContain('you')
    expect(shown).toContain('codex')
    expect(shown.some((t: string) => t.includes('on it'))).toBe(false)
    // A lease with time to spare says nothing; only one that needs you does.
    expect(shown.some((t: string) => /partway|responding/.test(t))).toBe(false)
    expect(shown).toContain('1 done')
    expect(shown).not.toContain('title of T-004')
    // Pressed, a closed group opens; pressed again, it closes.
    await ui.press({ key: 'group-not-started' })
    expect(await label(ui, 'group-not-started')).toBe('▾ Not started · 1')
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
  expect(await texts(wide)).toContain('frontend · see its note')
  await wide.unmount()
  // Narrow, it still says who stopped.
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  const shown = await texts(ui)
  // What needs you starts open.
  expect(await label(ui, 'group-partway')).toBe('▾ Stopped partway · 1')
  expect(shown).toContain('frontend')
  expect(shown).toContain('codex stopped responding')
  expect(await ui.find({ key: 'group-not-started' })).toBeUndefined()
})

test('the band says in plain words what is waiting, and the one thing that needs you', QUIET, async ($, on) => {
  host(on, [handedOff('T-005', 'frontend'), task('T-001', 'claimed', 'codex'), task('T-002', 'todo')])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(ui)).toEqual(['2 waiting', ' · ', '1 active', 'T-005 stopped partway'])
  // Active is green; what was left partway is yellow.
  expect((await ui.find({ type: 'Text', text: '1 active' }))?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: 'T-005 stopped partway' }))?.props.color).toBe('warning')
})

test('the band names a claim going quiet when no handoff waits', QUIET, async ($, on) => {
  host(on, [{ ...task('T-006', 'claimed', 'codex'), claim: { owner: 'codex', since: '', expiresAt: inMinutes(2) } }])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect(await texts(ui)).toContain('T-006: codex stopped responding')
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

test('with no name asked for, the session is named from its id', async ($, on) => {
  const calls = host(on, [])
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__modboard__board_list' } as any)
  expect(calls.find(argv => argv.includes('list'))?.slice(-2)).toEqual(['--as', 'claude:aaaa1111'])
})

test('board_done passes the verification note through', async ($, on) => {
  const calls = host(on, [task('T-001', 'claimed', 'claude:aaaa1111')])
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__modboard__board_done', id: 'T-001', note: 'ran it, saw hello' } as any)
  expect(calls.find(argv => argv.includes('done'))?.slice(-6)).toEqual(['done', 'T-001', '--note', 'ran it, saw hello', '--as', 'claude:aaaa1111'])
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

test('the band and pane settings pick blocks and their order', { options: { band: 'clock', pane: 'clock,tasks,context' } } as any, async ($, on) => {
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

const BOARD_ONLY = { options: { pane: 'tasks,taskfile' } } as any

test('the task.md button says what is left, and shows only that when pressed', BOARD_ONLY, async ($, on) => {
  host(on, [task('T-001', 'todo')], { taskfile: TASKFILE })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await label(ui, 'taskfile')).toBe('▸ task.md · 2 open')
  expect(await texts(ui)).not.toContain('Write the parser')
  await ui.press({ key: 'taskfile' })
  expect(await label(ui, 'taskfile')).toBe('▾ task.md · 2 open')
  const shown = await texts(ui)
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
  expect(await label(ui, 'taskfile')).toBe('▸ task.md · 15 open')
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
  expect(await label(ui, 'tier')).toBe('P0 · 1')
  file.items.push({ text: 'added later', done: false, section: '', depth: 0, priority: 0 })
  await ui.press({ key: 'taskfile' })
  expect(await label(ui, 'taskfile')).toBe('▾ TASKS.md · 2 open')
  expect(await texts(ui)).toEqual(expect.arrayContaining(['first', 'added later']))
})

test('a task.md with everything checked off says so', async ($, on) => {
  host(on, [], { taskfile: { file: 'task.md', items: [{ text: 'a', done: true, section: '', depth: 0, priority: null }] } })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await label(ui, 'taskfile')).toBe('▸ task.md · all done')
})

test('a long backlog shows eight not started, then a count; what needs you is never cut', async ($, on) => {
  const backlog = Array.from({ length: 12 }, (_, n) => task(`T-${String(n + 10).padStart(3, '0')}`, 'todo'))
  const working = Array.from({ length: 10 }, (_, n) => task(`T-${String(n + 30).padStart(3, '0')}`, 'claimed', 'codex'))
  host(on, [...backlog, ...working])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  await ui.press({ key: 'group-not-started' })
  const shown = await texts(ui)
  expect(shown.filter((t: string) => /^title of T-03/.test(t))).toHaveLength(10)
  expect(shown.filter((t: string) => /^title of T-0[12]/.test(t))).toHaveLength(8)
  expect(shown).toContain('4 more')
  // The state is in the heading, not a mark on every row.
  expect(shown.some((t: string) => t === '◐' || t === '○')).toBe(false)
})

const ITEM = (text: string, priority: number | null, done = false) => ({ text, done, section: 'x', depth: 0, priority })
const RANKED: TaskFile = {
  file: 'docs/TASKS.md',
  items: [ITEM('later one', 2), ITEM('urgent one', 0), ITEM('no priority', null), ITEM('next one', 1), ITEM('urgent two', 0), ITEM('urgent done', 0, true)],
}
const work = async (ui: any) => (await texts(ui)).filter((t: string) => /one|two|priority|^P\d$|^–?$/.test(t))

test('the priority button starts on the most urgent tier and shows only its work', BOARD_ONLY, async ($, on) => {
  host(on, [], { taskfile: RANKED })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await label(ui, 'taskfile')).toBe('▸ TASKS.md · 5 open')
  expect(await label(ui, 'tier')).toBe('P0 · 2')
  await ui.press({ key: 'taskfile' })
  // The button names the tier, so the rows are only the work.
  expect(await work(ui)).toEqual(['urgent one', 'urgent two'])
  // With priorities, the headings step aside.
  expect(await texts(ui)).not.toContain('x')
})

test('the priority button turns through each tier the file has, then all, then round again', BOARD_ONLY, async ($, on) => {
  host(on, [], { taskfile: RANKED })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  // Pressing it opens a closed list on the next tier.
  await ui.press({ key: 'tier' })
  expect(await label(ui, 'taskfile')).toBe('▾ TASKS.md · 5 open')
  expect(await label(ui, 'tier')).toBe('P1 · 1')
  expect(await work(ui)).toEqual(['next one'])
  await ui.press({ key: 'tier' })
  expect(await label(ui, 'tier')).toBe('P2 · 1')
  expect(await work(ui)).toEqual(['later one'])
  await ui.press({ key: 'tier' })
  expect(await label(ui, 'tier')).toBe('all')
  // All: most urgent first, every row with its priority; none last, with a dash.
  expect(await work(ui)).toEqual(['P0', 'urgent one', 'P0', 'urgent two', 'P1', 'next one', 'P2', 'later one', '–', 'no priority'])
  await ui.press({ key: 'tier' })
  expect(await label(ui, 'tier')).toBe('P0 · 2')
})

test('a task file without priorities has no priority button', async ($, on) => {
  host(on, [], { taskfile: TASKFILE })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await ui.find({ key: 'tier' })).toBeUndefined()
})

test('with no task.md the pane shows no button for it', async ($, on) => {
  host(on, [task('T-001', 'todo')])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...PANE } as any)
  expect(await ui.find({ key: 'taskfile' })).toBeUndefined()
})

test('task.md is never read when no shown block uses it', { options: { pane: 'tasks' } } as any, async ($, on) => {
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
  expect((await band.find({ key: 'model' }))?.props.label).toBe('model Sonnet 5.5')
  await band.press({ key: 'model' })
  expect(calls).toContainEqual(['/model', 'haiku'])
  expect((await band.find({ key: 'model' }))?.props.label).toBe('model Haiku 5.5')
  await band.press({ key: 'model' })
  expect(calls).toContainEqual(['/model', 'opus'])
})

test('the effort block shows the level and steps to the next when pressed', FULL, async ($, on) => {
  const calls = host(on, [task('T-001', 'todo')], { effort: 'medium' })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect((await band.find({ key: 'effort' }))?.props.label).toBe('effort medium')
  await band.press({ key: 'effort' })
  expect(calls).toContainEqual(['/effort', 'high'])
  expect((await band.find({ key: 'effort' }))?.props.label).toBe('effort high')
})

test('effort shows the saved level before the session has sent anything', FULL, async ($, on) => {
  host(on, [task('T-001', 'todo')], { effort: 'low' })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect((await band.find({ key: 'effort' }))?.props.label).toBe('effort low')
})

test("the model's own saved effort wins over the general one", FULL, async ($, on) => {
  host(on, [task('T-001', 'todo')], { effort: 'medium', modelEffort: 'low' })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect((await band.find({ key: 'effort' }))?.props.label).toBe('effort low')
})

test('CLAUDE_CODE_EFFORT_LEVEL overrides the saved level', FULL, async ($, on) => {
  host(on, [task('T-001', 'todo')], { effort: 'low', envEffort: 'high' })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND } as any)
  expect((await band.find({ key: 'effort' }))?.props.label).toBe('effort high')
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
  expect(seen).toEqual(['effort high', 'effort xhigh', 'effort max', 'effort low', 'effort medium'])
  expect(calls.filter(c => c[0] === '/effort').map(c => c[1])).toEqual(['high', 'xhigh', 'max', 'low', 'medium'])
})

// The band at a given width: what it shows, and how wide that is.
async function bandAt($: any, columns: number) {
  const ui = await $.ui.mount({ plugin: 'modboard', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: columns } } as any)
  const shown: string[] = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
  await ui.unmount()
  return shown
}

test('the band defaults to the tasks, model and effort, then a full board button; usage and context stay in the pane', async ($, on) => {
  host(on, [task('T-001', 'todo')], { effort: 'low' })
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)
  await $.session.measure({ ...measure(64), context: { window: 200000, percent: 72 } } as any)
  const shown = await bandAt($, 140)
  expect(shown).toEqual(['1 waiting', 'model ', 'Sonnet 5.5', 'effort ', 'low', 'full board'])
})


test('full board on the band opens the board pane', { options: { band: 'summary,board' } } as any, async ($, on) => {
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
  expect(await texts(band)).toContain('full board')
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

test('full board sits last but outlasts model and effort on a short line', { options: { band: 'summary,model,effort,board' } } as any, async ($, on) => {
  host(on, [task('T-001', 'todo')], { effort: 'low' })
  await $.session.start(START)
  expect((await bandAt($, 120)).at(-1)).toBe('full board')
  const short = await bandAt($, 34)
  expect(short).toContain('full board')
  expect(short).not.toContain('low')
})

test('the band never wraps: it narrows its parts, then leaves the last ones out', FULL, async ($, on) => {
  host(on, [task('T-001', 'todo'), task('T-002', 'todo')], { effort: 'low' })
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)
  await $.session.measure(measure(64) as any)

  const wide = await bandAt($, 124)
  expect(wide).toEqual(expect.arrayContaining(['2 waiting', '5-hour limit', 'model ', 'Sonnet 5.5', 'effort ', 'low']))

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
  expect(await bandAt($, 30)).toEqual(['2 waiting', 'T-005 partway'])
  expect(await bandAt($, 20)).toEqual(['T-005 partway'])
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
  options: { blocks: '{"ci": "echo passing", "broken": "false"}', band: 'summary,ci,broken', pane: 'tasks,ci,broken' },
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
  options: { blocks: '{"tasks": "echo hijack", "Bad Name": "echo x", "ok": "echo fine"}', band: 'summary,ok' },
} as any, async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_$, e: any) => {
    toasts.push(String(e.message ?? e.text ?? e))
    return { value: undefined }
  })
  const calls = host(on, [task('T-001', 'todo')])
  await $.session.start(START)
  expect(toasts.some(t => t.includes('"tasks" is a built-in block'))).toBe(true)
  expect(toasts.some(t => t.includes('"Bad Name"'))).toBe(true)
  expect(calls).not.toContainEqual(['sh', '-c', 'echo hijack'])
  expect(calls).toContainEqual(['sh', '-c', 'echo fine'])
})
