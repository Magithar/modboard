import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, ReadyBlock, ReadyValue, Reminder, Task, TaskFile, Weather } from '../types'
import { BLOCKS, type BandForm, type Block, type Ctx } from './blocks'
import type { CommandState } from './blocks/types'
import { CAP } from './blocks/board'
import { hhmm } from './blocks/clock'
import { commandBlock, firstLine, parseCommandBlocks } from './blocks/command'
import { groupOpen, type GroupName } from './blocks/tasks'
import { Problem } from './blocks/problem'
import { tone } from './blocks/meter'
import { nextTier, openItems } from './blocks/taskfile'

// The mod is an adapter: every board read and write goes through bin/board.mjs,
// the same CLI Codex or a human runs, so it works whatever storage block holds
// the board. The mod adds what only Claude's host can: the session's identity,
// heartbeats, usage readings, and a display built from blocks (./blocks): a
// one-line band above the prompt, and the /board pane.

const PANE = 'modboard'
const HEARTBEAT_MS = 60_000
const PRESENCE_MS = 60_000
const POLL_MS = 3_000
// Pane blocks that draw a bar; together they make one section.
const BARS = new Set(['compact', 'usage', 'context'])
const COMMAND_MS = 30_000
// How old a command block's result gets before it says its age, and how long
// its command fails before it says it is not updating: the `stale` setting, in minutes.
let staleMs = 5 * 60_000
let commandNames: string[] = []
const NAME_TRIES = 9

const tasks = atom({ plugin: 'modboard', key: 'tasks' } as const, [])
const agents = atom({ plugin: 'modboard', key: 'agents' } as const, [])
const me = atom({ plugin: 'modboard', key: 'me' } as const, '')
const usage = atom({ plugin: 'modboard', key: 'usage' } as const, { limits: [] })
const model = atom({ plugin: 'modboard', key: 'model' } as const, '')
const effort = atom({ plugin: 'modboard', key: 'effort' } as const, '')
const custom = atom({ plugin: 'modboard', key: 'custom' } as const, {} as Record<string, string>)
// When each command block last succeeded, and since when it has failed.
const commandState = atom({ plugin: 'modboard', key: 'commandState' } as const, {} as Record<string, CommandState>)
const taskfile = atom({ plugin: 'modboard', key: 'taskfile' } as const, { file: null, items: [] } as TaskFile)
const taskfileOpen = atom({ plugin: 'modboard', key: 'taskfileOpen' } as const, false)
// Whether the pane is open now: set when it is placed, cleared when it closes,
// by modBOARD on the band or by its own ✕.
const paneOpen = atom({ plugin: 'modboard', key: 'paneOpen' } as const, false)
const taskfileTier = atom({ plugin: 'modboard', key: 'taskfileTier' } as const, '')
const groupsOpen = atom({ plugin: 'modboard', key: 'groupsOpen' } as const, {} as Record<string, boolean>)
// The task whose worktree path was just copied, for a moment; and the home
// directory, so a path reads ~/code/app.
const copied = atom({ plugin: 'modboard', key: 'copied' } as const, '')
const home = atom({ plugin: 'modboard', key: 'home' } as const, '')
const COPIED_MS = 2_000
// Why the last read of the board failed, or '' when it worked: the pane would
// otherwise go on showing old tasks as if they were current.
const boardError = atom({ plugin: 'modboard', key: 'boardError' } as const, '')
// What the pane shows: the board, or the list of blocks to tick on and off.
const paneView = atom({ plugin: 'modboard', key: 'paneView' } as const, 'board')
// The pane's blocks by name, in order: the `pane` setting, until the person
// ticks blocks on the list; then their choice, kept between sessions.
// The block just moved on the Order screen, lit for a moment.
const moved = atom({ plugin: 'modboard', key: 'moved' } as const, '')
const MOVED_MS = 1_500
// The board's blocks, in order, when the list of blocks opened: Done says
// what changed since.
const listStart = atom({ plugin: 'modboard', key: 'listStart' } as const, [] as string[])
const paneBlocks = atom({ plugin: 'modboard', key: 'paneBlocks' } as const, [] as string[])
// Ready-made blocks (board blocks): the registry as the CLI reports it, with
// which are on; and each one's last line, for this session's project.
const readyList = atom({ plugin: 'modboard', key: 'readyList' } as const, [] as ReadyBlock[])
const readyValues = atom({ plugin: 'modboard', key: 'readyValues' } as const, {} as Record<string, ReadyValue>)

// The pixel clock's minute, written when it turns, so the clock redraws then
// and not on every poll; the weather; the alarm times; and the one ringing.
const minute = atom({ plugin: 'modboard', key: 'minute' } as const, '')
const weather = atom({ plugin: 'modboard', key: 'weather' } as const, null as Weather | null)
const alarms = atom({ plugin: 'modboard', key: 'alarms' } as const, [] as string[])
const ringing = atom({ plugin: 'modboard', key: 'ringing' } as const, '')
// One-off alarms an agent set with board_alarm: each rings once, then goes.
// Whether the weather has a place to be read for; the clock says how to give one when not.
const located = atom({ plugin: 'modboard', key: 'located' } as const, false)
// The tasks seen done at the last read, or null before the first (see ringFinished).
const seenDone = atom({ plugin: 'modboard', key: 'seenDone' } as const, null as string[] | null)
const reminders = atom({ plugin: 'modboard', key: 'reminders' } as const, [] as Reminder[])
const TICK_MS = 5_000
const WEATHER_MS = 20 * 60_000
const RING_MS = 60_000
// An agent may ring now at most this often, so a chatty one can't drown you.
const AGENT_RING_MS = 60_000
// A ring that isn't a set time (a task done, an agent ringing now) chimes
// this many times and stops.
const CHIMES = 3
const ALARM_SOUND = 'hooks/sounds/alarm.wav'

let session = ''
let lastBeat = 0

async function cli($: EngineInterface, args: string[]) {
  const run = await $.process.run(['node', `${$.plugin.root}/bin/board.mjs`, ...args])
  return { ok: run.exitCode === 0, code: run.exitCode, text: (run.exitCode === 0 ? run.stdout : run.stderr || run.stdout).trim() }
}

async function board($: EngineInterface, args: string[]) {
  // --as goes last, but before a bare --, after which everything is text.
  const as = ['--as', await read($, me)]
  const end = args.indexOf('--')
  return cli($, end < 0 ? [...args, ...as] : [...args.slice(0, end), ...as, ...args.slice(end)])
}

// Tool calls under way in this session, and a heartbeat for its claims.
let toolsRunning = 0
async function beat($: EngineInterface) {
  const who = await read($, me)
  // A failed heartbeat must never fail the tool call it rode in on.
  if ((await read($, tasks)).some(t => t.claim?.owner === who)) await board($, ['heartbeat']).catch(() => {})
}

// The board names the session by what it runs and when it joined ("claude 1",
// "claude 2"), unless BOARD_AGENT asks for a name: then that one, or the next
// free one after it.
async function joined($: EngineInterface) {
  const out = await cli($, ['join', 'claude', '--session', session, '--json'])
  try {
    if (out.ok) return (JSON.parse(out.text) as { name: string }).name
  } catch {}
  // A storage block the project names that isn't installed: say so once, at start.
  if (out.code === 12) $.ui.toast(`board: ${reason(out.text)}`)
  return `claude:${session.slice(0, 8)}`
}

async function takeName($: EngineInterface, wanted: string | undefined) {
  if (!wanted) return joined($)
  for (let i = 1; i <= NAME_TRIES; i++) {
    const name = i === 1 ? wanted : `${wanted}-${i}`
    const taken = await cli($, ['register', name, '--session', session])
    if (taken.ok) {
      if (i > 1) $.ui.toast(`board: "${wanted}" is in use by another live session, so this one is "${name}"`)
      return name
    }
    if (taken.code !== 7) break
  }
  const name = await joined($)
  $.ui.toast(`board: could not take the name "${wanted}", so this session is "${name}"`)
  return name
}

// The context window's fill before the session's first reply, when Claude Code
// has not measured it yet: its own local estimate, as /context makes, with no
// API call. Each reply's measurement (session.measure) replaces it.
async function estimateContext($: EngineInterface) {
  if ((await read($, usage)).context !== undefined) return
  try {
    const now = await $.session.usage({ breakdown: 'summary' })
    const percent = now.context.percent ?? now.context.breakdown?.percentage
    if (percent !== undefined) await update($, usage, u => ({ ...u, context: percent }))
  } catch {}
}

// Whether any shown block reads task.md; when none does, it is never read.
let readsTaskfile = false
let bandReadsTodo = false
// The `pane` setting as written, the blocks the pane can show, and the
// setting's own choice of them (see register).
let paneSetting = ''
let paneChoosable: string[] = []
let paneFromSetting: string[] = []

function reads(names: string[]) {
  readsTaskfile = bandReadsTodo || names.includes('todo')
}

// The list kept in the store, while the setting is the one it was ticked
// from: a `pane` changed in /config since wins over it.
async function loadPane($: EngineInterface) {
  const kept: any = await $.store.get('paneBlocks').catch(() => undefined)
  const names =
    kept && kept.from === paneSetting && Array.isArray(kept.blocks)
      ? [...new Set((kept.blocks as unknown[]).filter((n): n is string => typeof n === 'string').map(n => RENAMED[n] ?? n))].filter(n => paneChoosable.includes(n))
      : paneFromSetting
  await update($, paneBlocks, () => names)
  reads(names)
}

// A row on the list of blocks pressed: ticked, the block goes last, below
// the others; unticked, it leaves the pane. Kept between sessions.
// ── Ready-made blocks ────────────────────────────────────────────────────────
// The registry and which blocks are on come from the CLI (board blocks), the
// same list every agent reads. Each block that's on runs through the CLI in
// this session's folder, on its own schedule, never twice at once; one that's
// off never runs. A command block of your own with the same name wins, and
// the ready-made one is left out.
const READY_TICK_MS = 5_000
const readyRunning = new Set<string>()
const readyLastRun = new Map<string, number>()

async function loadReady($: EngineInterface) {
  const out = await cli($, ['blocks', '--all', '--json']).catch(() => undefined)
  let list: ReadyBlock[] = []
  try {
    list = out?.ok ? ((JSON.parse(out.text) as { all: ReadyBlock[] }).all ?? []).filter(b => !commandNames.includes(b.id)) : []
  } catch {}
  if (!same(await read($, readyList), list)) await update($, readyList, () => list)
  // A block turned off drops its line.
  const on = new Set(list.filter(b => b.enabled).map(b => b.id))
  const values = await read($, readyValues)
  if (Object.keys(values).some(id => !on.has(id))) await update($, readyValues, all => Object.fromEntries(Object.entries(all).filter(([id]) => on.has(id))))
}

async function runReady($: EngineInterface, force = false) {
  // Hidden means no work: with the Project group off the pane, nothing runs.
  // The blocks stay on in your settings, for board blocks and other agents.
  if (!(await read($, paneBlocks)).includes('project')) return
  const now = await $.clock.now()
  const due = (await read($, readyList)).filter(
    b => b.enabled && !readyRunning.has(b.id) && (force || now - (readyLastRun.get(b.id) ?? 0) >= b.every),
  )
  await Promise.all(
    due.map(async b => {
      readyRunning.add(b.id)
      readyLastRun.set(b.id, now)
      try {
        const out = await cli($, ['blocks', 'run', b.id, '--json'])
        let value: ReadyValue = { state: 'error', text: reason(out.text) || 'the block failed', at: await $.clock.now() }
        try {
          if (out.ok) value = { ...(JSON.parse(out.text) as Omit<ReadyValue, 'at'>), at: await $.clock.now() }
        } catch {}
        const before = (await read($, readyValues))[b.id]
        if (!before || before.state !== value.state || before.text !== value.text) await update($, readyValues, all => ({ ...all, [b.id]: value }))
      } finally {
        readyRunning.delete(b.id)
      }
    }),
  )
}

// A ready-made block's row on the Blocks tab, pressed: on or off, for every
// agent (your own settings). Turned on, it shows under Checks, which the pane
// gains if it hadn't it, and it runs at once.
async function toggleReady($: EngineInterface, id: string) {
  const on = !(await read($, readyList)).find(b => b.id === id)?.enabled
  const out = await cli($, ['blocks', on ? 'on' : 'off', id])
  if (!out.ok) return void $.ui.toast(`board: ${reason(out.text) || `could not turn ${id} ${on ? 'on' : 'off'}`}`)
  await loadReady($)
  if (on) {
    const shown = await read($, paneBlocks)
    if (!shown.includes('project')) await toggleBlock($, 'project')
    await runReady($, true)
  }
}

// The limits row on the Blocks tab: with any bar shown, hides them all; with
// none, shows them all, side by side at the end.
async function toggleBars($: EngineInterface, bars: string[]) {
  const now = await read($, paneBlocks)
  const names = now.some(n => bars.includes(n)) ? now.filter(n => !bars.includes(n)) : [...now, ...bars]
  await update($, paneBlocks, () => names)
  reads(names)
  await $.store.set('paneBlocks', { from: paneSetting, blocks: names }).catch(() => $.ui.toast('board: could not save the list of blocks'))
}

async function toggleBlock($: EngineInterface, name: string) {
  const now = await read($, paneBlocks)
  const names = now.includes(name) ? now.filter(n => n !== name) : [...now, name]
  // The tick changes first; saving follows.
  await update($, paneBlocks, () => names)
  reads(names)
  await $.store.set('paneBlocks', { from: paneSetting, blocks: names }).catch(() => $.ui.toast('board: could not save the list of blocks'))
  if (name === 'todo' && names.includes('todo')) await refresh($)
  if (name === 'project' && names.includes('project')) void runReady($, true).catch(() => {})
  if (name === 'pixel-clock' && names.includes('pixel-clock')) void askOnTick($)
}

// On the Order screen (▲ ▼): a ticked block moves to place `to` among the ticked
// blocks the list shows (0 is the top), and the board follows that order. The
// row lights up for a moment, so you can see where it landed. Kept between
// sessions, as the ticks are.
// The rows of the Order screen: one per block, except that the bars (two or
// more ticked) are one `limits` row where the first of them sits, as the pane
// draws them under one Limits heading.
function orderRows(names: string[]) {
  const bars = names.filter(n => BARS.has(n))
  const rows: { key: string; names: string[] }[] = []
  for (const n of names) {
    if (bars.length < 2 || !BARS.has(n)) rows.push({ key: n, names: [n] })
    else if (n === bars[0]) rows.push({ key: 'limits', names: bars })
  }
  return rows
}

async function moveBlock($: EngineInterface, key: string, to: number, shown: string[]) {
  const now = await read($, paneBlocks)
  const rows = orderRows(now.filter(n => shown.includes(n)))
  const from = rows.findIndex(row => row.key === key)
  if (from < 0) return
  const [row] = rows.splice(from, 1)
  rows.splice(Math.max(0, Math.min(to, rows.length)), 0, row!)
  // The bars land side by side, so the saved order reads as the pane draws.
  const order = rows.flatMap(row => row.names)
  // Hidden blocks (named in `pane`, off the list) keep their places.
  let k = 0
  const names = now.map(n => (shown.includes(n) ? order[k++]! : n))
  // The move and the light show at once; saving and the light's fading go on
  // after the press returns, so the next press never waits for them.
  await update($, paneBlocks, () => names)
  await update($, moved, () => key)
  void $.store.set('paneBlocks', { from: paneSetting, blocks: names }).catch(() => $.ui.toast('board: could not save the list of blocks'))
  void (async () => {
    await $.clock.sleep(MOVED_MS)
    await update($, moved, now => (now === key ? '' : now))
  })().catch(() => {})
}

// What went wrong, in one line: the board's own message, or the error line of
// a crash ("EACCES: permission denied, open '…/board.json'"), not its stack.
function reason(text: string) {
  // A command run with --json answers an error as JSON: {"error": "...", "code": 12}.
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed.error === 'string') return parsed.error
  } catch {}
  const lines = text.split('\n').map(l => l.trim())
  const line = lines.find(l => /^board:/.test(l)) ?? lines.find(l => /^\w*Error\b/.test(l)) ?? lines.find(Boolean) ?? ''
  return line.replace(/^board:\s*/, '').replace(/^\w*Error:\s*/, '')
}

// A polled value is written only when it changed: each write redraws its
// readers, and a pane redrawn every few seconds for nothing scrolls in jerks.
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// One read of the board at a time: a poll that comes round while the last
// is still running (a slow disk, a big board) waits for the next one.
let refreshing: Promise<void> | null = null

function refresh($: EngineInterface) {
  if (!refreshing) refreshing = readBoard($).finally(() => (refreshing = null))
  return refreshing
}

async function readBoard($: EngineInterface) {
  let problem = ''
  try {
    const out = await cli($, ['view', '--json'])
    if (out.ok) {
      const view = JSON.parse(out.text) as { tasks: Task[]; agents: Agent[] }
      await ringFinished($, view.tasks)
      if (!same(await read($, tasks), view.tasks)) await update($, tasks, () => view.tasks)
      if (!same(await read($, agents), view.agents)) await update($, agents, () => view.agents)
    } else problem = reason(out.text) || `the board CLI exited with ${out.code}`
  } catch {
    problem = 'the board CLI could not run (is node on PATH?)'
  }
  if ((await read($, boardError)) !== problem) await update($, boardError, () => problem)
  if (readsTaskfile) {
    const file = await cli($, ['taskfile', '--json'])
    let parsed: TaskFile | undefined
    try {
      parsed = file.ok ? (JSON.parse(file.text) as TaskFile) : undefined
    } catch {}
    if (parsed && !same(await read($, taskfile), parsed)) await update($, taskfile, () => parsed!)
  }
}

const TOOLS = [
  {
    name: 'board_list',
    description:
      'List open tasks on the shared board several agents work from at once (○ todo, ◐ claimed, with owner). ' +
      'Protocol: claim a task before working on it, note progress, release with a handoff if you stop, never touch a task another agent holds.',
    args: () => ['list'],
  },
  {
    name: 'board_show',
    description:
      'Show one task with its acceptance criteria, notes and handoffs. Read this before resuming a task someone else released: ' +
      'the handoff says which worktree, branch and commit the work is in, and the last check that passed.',
    schema: { id: { type: 'string' } },
    required: ['id'],
    args: (i: any) => ['show', i.id],
  },
  {
    name: 'board_add',
    description: 'Add a task to the shared board. Give it acceptance criteria: how to tell it is done.',
    schema: {
      title: { type: 'string' },
      description: { type: 'string' },
      accept: { type: 'string' },
      ring: { type: 'boolean', description: 'Ring the person\'s alarm when this task is done, whoever finishes it. Only for what they asked to hear about, or a milestone worth interrupting them for.' },
      after: { type: 'array', items: { type: 'string' }, description: 'Task ids this one waits on: nobody can claim it until they are done. For work that needs another task finished first.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Labels to sort work by, as key=value ("kind=bug", "area=api") or a plain word.' },
    },
    required: ['title'],
    args: (i: any) => [
      'add',
      // Text goes as --flag=value, or after --, so text that starts with dashes stays text.
      ...(i.description ? [`--desc=${i.description}`] : []),
      ...(i.accept ? [`--accept=${i.accept}`] : []),
      ...(i.ring ? ['--ring'] : []),
      ...(i.after?.length ? ['--after', i.after.join(',')] : []),
      ...(i.labels?.length ? ['--label', i.labels.join(',')] : []),
      '--',
      i.title,
    ],
  },
  {
    name: 'board_claim',
    description:
      'Claim a task before working on it. Fails if another agent holds it, or if it waits on a task not yet done: then pick another. ' +
      'Leave out id to take the next ready task instead (with labels, one carrying them): picked and claimed in one step, so agents never pick the same one. ' +
      'Your lease renews automatically while you work.',
    schema: {
      id: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' }, description: 'With no id: only a task carrying every one of these labels.' },
    },
    required: [],
    args: (i: any) => (i.id ? ['claim', i.id] : ['claim', '--next', ...(i.labels?.length ? ['--label', i.labels.join(',')] : [])]),
  },
  {
    name: 'board_note',
    description: 'Record progress on a task you hold (what is done, what is next, decisions).',
    schema: { id: { type: 'string' }, text: { type: 'string' } },
    required: ['id', 'text'],
    args: (i: any) => ['note', i.id, '--', i.text],
  },
  {
    name: 'board_release',
    description:
      'Give up a task you hold without finishing it. Always write a handoff: what is done, what is left, where to look, each part separated by a semicolon ("done X; left Y; see Z") — the next agent starts from it. ' +
      'The board records the worktree, branch and commit with it; record your last passing check with board_check first.',
    schema: { id: { type: 'string' }, handoff: { type: 'string' } },
    required: ['id', 'handoff'],
    args: (i: any) => ['release', i.id, `--handoff=${i.handoff ?? ''}`],
  },
  {
    name: 'board_check',
    description:
      'Record a check that just passed on a task you hold: the command you ran (tests, build, lint) and saw succeed. ' +
      'The board adds the worktree, branch and commit, so whoever picks the task up knows what was green and where. ' +
      'Record only checks that passed.',
    schema: { id: { type: 'string' }, command: { type: 'string' } },
    required: ['id', 'command'],
    args: (i: any) => ['check', i.id, '--passed', '--', i.command],
  },
  {
    name: 'board_who',
    description:
      'Which agents changed a file, and on which task: from the files each handoff and check recorded (committed or not, in that agent\'s worktree). ' +
      'The latest first. Use it before editing a file another agent may be working on.',
    schema: { file: { type: 'string' } },
    required: ['file'],
    args: (i: any) => ['who', '--', i.file],
  },
  {
    name: 'board_done',
    description:
      'Mark a task you hold as done. Only after you have checked it against its acceptance criteria (board_show lists them). ' +
      'The note says how you verified it: what you ran or checked and what you saw. ' +
      'review: true also adds a task to review it, which another agent or a person picks up; never you.',
    schema: { id: { type: 'string' }, note: { type: 'string' }, review: { type: 'boolean' } },
    required: ['id', 'note'],
    args: (i: any) => ['done', i.id, `--note=${i.note ?? ''}`, ...(i.review ? ['--review'] : [])],
  },
]

const AGENT_ALARM =
  "Ring the person's alarm: a toast, a notification and a chime, with your note. Now (leave out at and inMinutes), or once at a time. " +
  'Use it sparingly: when they asked to be told, or something important finished or needs them (a release shipped, a long run done, a blocker). ' +
  'Never for routine progress. To ring when a board task is done, whoever finishes it, add it with board_add ring: true instead.'

const SYMBOL = { todo: '○', claimed: '◐', done: '●' } as const

// Names blocks had before they were renamed, so a setting written then still
// shows them. They stay taken: a command block can't use them either.
const RENAMED: Record<string, string> = { tasks: 'work', taskfile: 'todo', checks: 'project' }

const pick = (all: Block[], setting: unknown, fallback: string) =>
  String(setting ?? fallback)
    .split(',')
    .map(name => name.trim())
    .map(name => all.find(b => b.name === (RENAMED[name] ?? name)))
    .filter(b => b !== undefined)

// Each command block's first line of output. A failing command keeps its last
// good line, and the time it last succeeded and since when it has failed are
// kept beside it, so the block can say how old its result is.
// Command blocks still running from an earlier round. One that hangs (a
// network call with no answer) is left to finish and not started again on
// top of itself every 30 seconds; the others run alongside it, and each
// writes its own result when it ends, so none waits behind a slow one.
const running = new Set<string>()

async function runCommands($: EngineInterface, commands: Record<string, string>) {
  // Names no longer in the setting drop out.
  const names = Object.keys(commands)
  const keep = <T,>(all: Record<string, T>) => Object.fromEntries(Object.entries(all).filter(([n]) => names.includes(n)))
  const [before, was] = await Promise.all([read($, custom), read($, commandState)])
  if (!same(before, keep(before))) await update($, custom, all => keep(all))
  if (!same(was, keep(was))) await update($, commandState, all => keep(all))
  await Promise.all(
    Object.entries(commands)
      .filter(([name]) => !running.has(name))
      .map(async ([name, command]) => {
        running.add(name)
        try {
          const run = await $.process.run(['sh', '-c', command]).catch(() => undefined)
          const now = await $.clock.now()
          const prev = (await read($, commandState))[name]
          let next: CommandState
          if (run && run.exitCode === 0) {
            const line = firstLine(run.stdout)
            if ((await read($, custom))[name] !== line) await update($, custom, all => ({ ...all, [name]: line }))
            // A success keeps its time until it is half way to stale: the age
            // never shows while the command keeps working, and the pane isn't
            // redrawn every 30 seconds for a time nobody sees (a redraw
            // mid-scroll jolts it).
            const fresh = prev && prev.failing === null && prev.ok !== null && now - prev.ok < staleMs / 2
            next = fresh ? prev : { ok: now, failing: null }
          } else {
            // A failure keeps its last good line.
            next = { ok: prev?.ok ?? null, failing: prev?.failing ?? now }
          }
          if (!same(prev, next)) await update($, commandState, all => ({ ...all, [name]: next }))
        } finally {
          running.delete(name)
        }
      }),
  )
}

const GAP = 3
// Claude Code draws its own collapse control ([-]) at the line's right end.
const CONTROL = 4

// The band never wraps. The `band` setting's order is the order of importance,
// so the first block (the board's summary, by default) holds its full form
// longest: first the others narrow, last first; then the others go, last
// first; only then does the first block narrow.
function fit(offered: BandForm[][], columns: number): BandForm[] {
  const chosen = offered.map(() => 0)
  let kept = offered.length
  const width = () => offered.slice(0, kept).reduce((sum, forms, i) => sum + forms[chosen[i]!]!.width, 0) + GAP * Math.max(0, kept - 1)
  for (let i = kept - 1; i >= 1 && width() > columns; i--) while (chosen[i]! < offered[i]!.length - 1 && width() > columns) chosen[i]!++
  while (kept > 1 && width() > columns) kept--
  while (kept === 1 && chosen[0]! < offered[0]!.length - 1 && width() > columns) chosen[0]!++
  if (width() > columns) kept = 0
  return offered.slice(0, kept).map((forms, i) => forms[chosen[i]!]!)
}

const list = (setting: unknown, fallback: string) =>
  String(setting ?? fallback)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)

// The entry after `current` in `cycle`, wrapping from the last to the first;
// the first when `current` matches none. An exact match wins, so "xhigh" is
// never taken for "high"; otherwise the longest name inside it, so a model
// named in full ("claude-opus-5-5") matches its short name ("opus").
function after(cycle: string[], current: string) {
  const now = current.toLowerCase()
  let at = cycle.findIndex(item => item.toLowerCase() === now)
  if (at < 0) {
    const inside = cycle.filter(item => now.includes(item.toLowerCase())).sort((a, b) => b.length - a.length)[0]
    at = inside === undefined ? -1 : cycle.indexOf(inside)
  }
  return cycle[(at + 1) % cycle.length]!
}

// ── The weather ─────────────────────────────────────────────────────────────
// Open-Meteo needs no key. Nothing is sent until there is a location: the one
// set in /config, else the one the person gave when asked (kept between
// sessions). Only that location is sent, through Claude Code's own fetch, so
// the organization's network policy holds. "Use my location" asks ipapi.co
// for the city of this machine's IP, once, and keeps that city.

type Place = { latitude: number; longitude: number; name: string }
let place: Place | null = null
let configLocation = ''
let fahrenheit = false
const ASK_LOCATION = 'Show the weather beside the clock? Type your city under Other, or:'
const FROM_IP = 'Use my location (from my IP)'
const NOT_NOW = 'Not now'
const LOCATION_TOOL =
  "Ask the person where they are, for the weather beside modboard's pixel clock: a question with their location from their IP, " +
  'or a city they type. Call it when they ask to add, set or change the weather location. It asks them itself; pass nothing.'

// "Bengaluru" is looked up; "12.97,77.59" is used as it is.
async function lookUp($: EngineInterface, text: string): Promise<Place | null> {
  const coords = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/)
  if (coords) return { latitude: Number(coords[1]), longitude: Number(coords[2]), name: text.trim() }
  const found = await $.http.fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(text.trim())}`)
  if (!found.ok) return null
  const first = (JSON.parse(found.text) as { results?: Place[] }).results?.[0]
  return first ? { latitude: first.latitude, longitude: first.longitude, name: first.name } : null
}

async function fromIp($: EngineInterface): Promise<Place | null> {
  const out = await $.http.fetch('https://ipapi.co/json/')
  if (!out.ok) return null
  const at = JSON.parse(out.text) as { city?: string; latitude?: number; longitude?: number }
  return typeof at.latitude === 'number' && typeof at.longitude === 'number' ? { latitude: at.latitude, longitude: at.longitude, name: at.city || 'here' } : null
}

const weatherKey = () => `${place?.latitude},${place?.longitude}|${fahrenheit}`

// The place to read the weather for: /config's, looked up once a session;
// else the one kept from the question; else none, and nothing is fetched.
async function loadPlace($: EngineInterface) {
  if (configLocation.trim()) {
    // Offline, the place this setting was found at last time.
    const kept: any = await $.store.get('configPlace').catch(() => undefined)
    const looked = await lookUp($, configLocation).catch(() => undefined)
    place = looked ?? (kept && kept.from === configLocation ? (kept.place as Place) : null)
    if (looked) await $.store.set('configPlace', { from: configLocation, place: looked }).catch(() => {})
    if (looked === null) $.ui.toast(`board: no place called "${configLocation.trim()}" for the weather`)
  } else {
    const kept: any = await $.store.get('location').catch(() => undefined)
    place = kept && typeof kept.latitude === 'number' ? (kept as Place) : null
  }
  await update($, located, () => !!place)
}

// A failed fetch keeps the last reading; the block says how old it is.
async function fetchWeather($: EngineInterface) {
  if (!place) return
  try {
    const at = place
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${at.latitude}&longitude=${at.longitude}` +
      `&current=temperature_2m,weather_code&daily=temperature_2m_max&forecast_days=1&timezone=auto` +
      (fahrenheit ? '&temperature_unit=fahrenheit' : '')
    const out = await $.http.fetch(url)
    if (!out.ok) return
    const body = JSON.parse(out.text) as { current: { temperature_2m: number; weather_code: number }; daily: { temperature_2m_max: number[] } }
    const reading: Weather = {
      temp: body.current.temperature_2m,
      high: body.daily.temperature_2m_max[0] ?? body.current.temperature_2m,
      code: body.current.weather_code,
      place: at.name,
      at: await $.clock.now(),
    }
    await update($, weather, () => reading)
    await $.store.set('weather', { from: weatherKey(), reading }).catch(() => {})
  } catch {}
}

// Asks where the person is: their IP's city, a city they type, or not now.
// Esc or Not now: no weather, and Done doesn't ask again; /board location or
// asking Claude does. Returns what to tell them.
async function askLocation($: EngineInterface): Promise<string> {
  if (configLocation.trim()) return `The weather location is set in /config: ${configLocation.trim()}. Change it there.`
  let answer: string
  try {
    answer = await $.ui.ask(ASK_LOCATION, { header: 'Weather', options: [FROM_IP, NOT_NOW] })
  } catch {
    answer = NOT_NOW
  }
  if (answer === NOT_NOW || !answer.trim()) {
    await $.store.set('locationAsked', true).catch(() => {})
    return 'No weather for now. Type /board location, or ask Claude to add a location for the weather, when you want it.'
  }
  const found = await (answer === FROM_IP ? fromIp($) : lookUp($, answer)).catch(() => null)
  if (!found) return answer === FROM_IP ? "board: couldn't tell your location from your IP; try /board location and type your city" : `board: no place called "${answer.trim()}"; try /board location again`
  place = found
  await $.store.set('location', found).catch(() => {})
  await $.store.set('locationAsked', true).catch(() => {})
  await update($, located, () => true)
  await fetchWeather($)
  return `Weather for ${found.name}. Change it with /board location.`
}

// Done on the list of blocks with the pixel clock ticked asks once, while no
// location is set and the person hasn't answered before.
// What changed on the list since it opened, in one line beside the tabs:
// "added agents · removed todo · order changed", or '' for nothing.
function changes(before: string[], after: string[]) {
  const added = after.filter(n => !before.includes(n))
  const removed = before.filter(n => !after.includes(n))
  const kept = (list: string[]) => list.filter(n => before.includes(n) && after.includes(n))
  const reordered = !same(kept(before), kept(after))
  const parts = [
    added.length ? `added ${added.join(', ')}` : '',
    removed.length ? `removed ${removed.join(', ')}` : '',
    reordered ? 'order changed' : '',
  ].filter(Boolean)
  return parts.join(' · ')
}

// Leaving the list (modBOARD on the band, the logo): the board shows,
// in its new order. Every tick and move was saved as it was made.
async function leaveList($: EngineInterface) {
  await update($, paneView, () => 'board')
}

// Ticking the pixel clock asks once where you are, while no location is set
// and you haven't answered before.
async function askOnTick($: EngineInterface) {
  if (place || configLocation.trim() || !(await read($, paneBlocks)).includes('pixel-clock')) return
  if (await $.store.get('locationAsked').catch(() => false)) return
  $.ui.toast(await askLocation($))
}

// ── The alarm ───────────────────────────────────────────────────────────────
// Set in /config (`alarm`) or with /board alarm 7:30; the times set with the
// command are kept between sessions, until `alarm` is changed in /config.

let alarmSetting = ''
let stopSound: AbortController | null = null

// "7:30", "07:30", "7:30pm", "19:30" → "07:30"; anything else → undefined.
function alarmTime(text: string) {
  const m = text.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (!m) return undefined
  let h = Number(m[1])
  const min = Number(m[2] ?? '0')
  if (m[3]) {
    if (h < 1 || h > 12) return undefined
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0)
  }
  if (h > 23 || min > 59) return undefined
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

const alarmList = (text: string) => [...new Set(text.split(',').map(alarmTime).filter((t): t is string => !!t))].sort()

async function loadAlarms($: EngineInterface) {
  const kept: any = await $.store.get('alarms').catch(() => undefined)
  const times = kept && kept.from === alarmSetting && Array.isArray(kept.times) ? alarmList(kept.times.join(',')) : alarmList(alarmSetting)
  await update($, alarms, () => times)
}

async function saveAlarms($: EngineInterface, times: string[]) {
  await update($, alarms, () => times)
  await $.store.set('alarms', { from: alarmSetting, times }).catch(() => $.ui.toast('board: could not save the alarm'))
}

// Rings: `shown` on the clock and in a toast, `told` in the notification.
// A set time chimes for a minute; anything else chimes a few times. Either
// stays on the clock a minute, unless stopped first.
async function ring($: EngineInterface, shown: string, told: string, { loop }: { loop: boolean }) {
  await update($, ringing, () => shown)
  $.ui.toast(`⏰ ${shown}`)
  $.ui.notify(told, { title: '⏰ modboard', key: `alarm-${shown}` }).catch(() => {})
  stopSound?.abort()
  const stop = (stopSound = new AbortController())
  if (loop) $.audio.play({ asset: ALARM_SOUND }, { shouldLoop: true, signal: stop.signal }).catch(() => {})
  else
    void (async () => {
      for (let i = 0; i < CHIMES && !stop.signal.aborted; i++) await $.audio.play({ asset: ALARM_SOUND }).catch(() => {})
    })()
  await $.clock.sleep(RING_MS)
  if (stopSound === stop) await stopAlarm($)
}

const ringAt = ($: EngineInterface, at: string) => ring($, at, `It's ${at}.`, { loop: true })

async function saveReminders($: EngineInterface, list: Reminder[]) {
  await update($, reminders, () => list)
  await $.store.set('reminders', list).catch(() => {})
}

async function loadReminders($: EngineInterface) {
  const kept: any = await $.store.get('reminders').catch(() => undefined)
  const list = Array.isArray(kept)
    ? kept
        .filter((r: any) => r && typeof r.at === 'string' && alarmTime(r.at))
        .map((r: any) => ({ at: alarmTime(r.at)!, note: String(r.note ?? ''), ...(typeof r.due === 'number' ? { due: r.due } : {}) }))
    : []
  await update($, reminders, () => list)
}

// A task flagged to ring (board add --ring, board ring <id>) that turned done
// since the last read rings, whoever finished it: Claude, Codex or a person.
// Null until the first read, so tasks done before this session stay quiet.
// Kept in the session's state, not the module: a reload (an edit, or a board
// written inside a --plugin-dir folder) would otherwise forget it, and a task
// done across the reload would never ring.
async function ringFinished($: EngineInterface, list: Task[]) {
  const done = list.filter(t => t.status === 'done').map(t => t.id)
  const before = await read($, seenDone)
  if (!before || !same(before, done)) await update($, seenDone, () => done)
  if (!before) return
  for (const t of list)
    if (t.ring && t.status === 'done' && !before.includes(t.id)) {
      const by = t.notes.at(-1)?.by
      void ring($, `${t.id} done · ${t.title}`, `${t.id} done: ${t.title}${by ? ` (by ${by})` : ''}`, { loop: false })
    }
}

// An agent's "1:30" with no am or pm: whichever of 01:30 and 13:30 comes
// next, since a one-off alarm means the next one. "13:30", "01:30", "0:15"
// and "6pm" say which already. (Your own /board alarm times repeat daily, on the
// 24-hour clock.)
function soonest(text: string, now: number) {
  const at = alarmTime(text)
  const bare = text.trim().match(/^([1-9]|1[0-2])(?::\d{2})?$/)
  if (!at || !bare) return at
  const [h, m] = at.split(':').map(Number) as [number, number]
  const other = `${String((h + 12) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  const nowAt = hhmm(now)
  // Minutes from now until each, wrapping past midnight; the nearer wins.
  const until = (t: string) => {
    const [th, tm] = t.split(':').map(Number) as [number, number]
    const [nh, nm] = nowAt.split(':').map(Number) as [number, number]
    return (th * 60 + tm - (nh * 60 + nm) + 24 * 60) % (24 * 60) || 24 * 60
  }
  return until(at) <= until(other) ? at : other
}

// The next time the clock reads `at`, from now, in ms.
function dueAt(at: string, now: number) {
  const [h, m] = at.split(':').map(Number) as [number, number]
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

// A one-off alarm whose time passed this long ago (the machine slept, or no
// session was open) is missed: said in a toast, not rung late.
const MISSED_MS = 60 * 60_000

let lastAgentRing = -Infinity

// The board_alarm tool: ring now, at a time, or in some minutes; always with
// a note saying why.
async function agentAlarm($: EngineInterface, input: { note?: unknown; at?: unknown; inMinutes?: unknown }) {
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (!note) return 'error: board_alarm needs a note saying why the person should look'
  const now = await $.clock.now()
  let at: string | undefined
  if (input.at !== undefined && input.at !== '') {
    at = soonest(String(input.at), now)
    if (!at) return `error: "${input.at}" is not a time; give HH:MM (18:00) or 6pm`
  } else if (input.inMinutes !== undefined) {
    const m = Number(input.inMinutes)
    if (!Number.isFinite(m) || m < 0 || m > 24 * 60) return 'error: inMinutes is a number of minutes, up to a day'
    if (m >= 1) at = hhmm(now + Math.round(m) * 60_000)
  }
  if (!at || at === hhmm(now)) {
    if (now - lastAgentRing < AGENT_RING_MS)
      return `error: the alarm rang ${Math.round((now - lastAgentRing) / 1000)} s ago; ring only for what needs the person, and not twice in a minute`
    lastAgentRing = now
    void ring($, note, note, { loop: false })
    return `rang the alarm: ${note}`
  }
  await saveReminders($, [...(await read($, reminders)), { at, note, due: dueAt(at, now) }])
  return `the alarm rings once at ${at}: ${note}`
}

async function stopAlarm($: EngineInterface) {
  stopSound?.abort()
  stopSound = null
  await update($, ringing, () => '')
}

// Every few seconds: when the minute turns, the clock redraws, and an alarm
// set for it rings.
async function tick($: EngineInterface) {
  const ms = await $.clock.now()
  const now = hhmm(ms)
  if ((await read($, minute)) === now) return
  await update($, minute, () => now)
  // One with a due time rings once it is reached, even if the minute itself
  // was slept through; one older than an hour was missed. One without (set
  // before due times) rings at its minute.
  const isDue = (r: Reminder) => (r.due !== undefined ? r.due <= ms : r.at === now)
  const isMissed = (r: Reminder) => r.due !== undefined && ms - r.due > MISSED_MS
  const all = await read($, reminders)
  const missed = all.filter(isMissed)
  const due = all.filter(r => isDue(r) && !isMissed(r))
  if (missed.length || due.length) await saveReminders($, (await read($, reminders)).filter(r => !isDue(r)))
  for (const r of missed) $.ui.toast(`⏰ missed: ${r.at} · ${r.note} (this machine was asleep or closed)`)
  if (due.length) {
    const note = due.map(r => r.note).join(' · ')
    return void ring($, `${now} · ${note}`, note, { loop: true })
  }
  if ((await read($, alarms)).includes(now)) void ringAt($, now)
}

// /board alarm 7:30 · /board alarm off · /board alarm off 7:30 · /board alarm
async function alarmCommand($: EngineInterface, args: string) {
  const now = await read($, alarms)
  const words_ = args.trim().split(/\s+/).filter(Boolean)
  const once = await read($, reminders)
  const listed = (times: string[]) =>
    [times.length ? `Alarm set for ${times.join(', ')}.` : once.length ? '' : 'No alarm set.', ...once.map(r => `Once at ${r.at}: ${r.note}`)].filter(Boolean).join('\n')
  if (!words_.length) return listed(now)
  if (words_[0] === 'off' || words_[0] === 'clear') {
    await stopAlarm($)
    if (words_.length === 1) {
      await saveAlarms($, [])
      await saveReminders($, [])
      return 'Alarm off.'
    }
    const drop = alarmList(words_.slice(1).join(','))
    const left = now.filter(t => !drop.includes(t))
    await saveAlarms($, left)
    await saveReminders($, once.filter(r => !drop.includes(r.at)))
    return listed(left)
  }
  const time = alarmTime(words_.join(' '))
  if (!time) return `board: "${args.trim()}" is not a time; try /board alarm 7:30 or /board alarm 7:30pm`
  const times = [...new Set([...now, time])].sort()
  await saveAlarms($, times)
  return listed(times)
}

// Switch the way the person would, through Claude Code's own commands, so
// everything else in the session sees the change.
// Open the /board pane, then read the board and the task file again.
// Ask for room for the whole board; the surface may give less, and the pane's
// body scrolls with the wheel when it does.

async function openBoard($: EngineInterface) {
  // Open at once on what the 3-second poll last read; the fresh read follows,
  // and the pane redraws when it lands.
  await update($, paneView, () => 'board')
  const opened = await $.ui.open({ id: PANE, title: 'modboard', rows: 30 })
  if (opened.isPlaced) await update($, paneOpen, () => true)
  await refresh($)
  await estimateContext($)
  return opened
}

function actions($: EngineInterface, cycles: { models: string[]; efforts: string[] }): Ctx['act'] {
  return {
    nextModel: async () => {
      const to = after(cycles.models, await read($, model))
      await $.command.run({ command: 'model', args: to }).catch(() => $.ui.toast(`board: could not switch the model to ${to}`))
      const now = await $.session.model()
      await update($, model, () => now || to)
    },
    // The band shows the new level at once; it goes back if /effort refuses.
    nextEffort: async () => {
      const from = await read($, effort)
      const to = after(cycles.efforts, from)
      await update($, effort, () => to)
      await $.command.run({ command: 'effort', args: to }).catch(async () => {
        $.ui.toast(`board: could not set effort to ${to}`)
        await update($, effort, now => (now === to ? from : now))
      })
    },
    // modBOARD on the band: opens the pane, or closes it when it is already open.
    // Open at the list of blocks, it turns the pane to the board instead.
    openBoard: async () => {
      const [isOpen, viewNow] = await Promise.all([read($, paneOpen), read($, paneView)])
      if (!isOpen) return void (await openBoard($))
      if (viewNow !== 'board') return void (await leaveList($))
      await $.ui.close({ id: PANE }).catch(() => {})
      await update($, paneOpen, () => false)
    },
    // blocks on the band: the pane, open at the list of blocks alone.
    // Pressed again while the list shows, it closes the pane.
    openBlocks: async () => {
      const [isOpen, viewNow, shown] = await Promise.all([read($, paneOpen), read($, paneView), read($, paneBlocks)])
      if (isOpen && viewNow !== 'board') {
        await $.ui.close({ id: PANE }).catch(() => {})
        return void (await update($, paneOpen, () => false))
      }
      await Promise.all([update($, listStart, () => shown), update($, paneView, () => 'blocks')])
      if (isOpen) return
      // Straight to the list: it needs no fresh read of the board, and the
      // board's 3-second poll keeps it current for Done.
      const opened = await $.ui.open({ id: PANE, title: 'modboard', rows: 30 })
      if (opened.isPlaced) await update($, paneOpen, () => true)
    },
    // A task's box on the band. With the pane closed, it opens the pane at
    // the group that holds the task, unfolded, so the task and its note are
    // in view. With the pane open, it folds or unfolds that group, and the
    // pane stays open: modBOARD is what closes it.
    showGroup: async (name: string) => {
      if (!(await read($, paneOpen))) {
        await update($, groupsOpen, chosen => ({ ...chosen, [name]: true }))
        return void (await openBoard($))
      }
      await update($, groupsOpen, chosen => ({ ...chosen, [name]: !groupOpen(chosen, name as GroupName) }))
    },
    // The same call /compact makes. Claude Code refuses it while a turn runs.
    compact: async () => {
      $.ui.toast('board: compacting the conversation…')
      await $.session.compact().catch(() => $.ui.toast("board: can't compact while Claude is working; press again when it's idle"))
    },
    // A worktree's path under a handoff: copies `cd '<path>'`, and the row says
    // ✓ copied for a moment. Where the surface can't copy, a toast gives the path.
    copyPath: (id: string, path: string, surface: string) => copyText($, id, `cd ${shellQuote(path)}`, surface, `the worktree is ${path}`),
    // Any text, the same way: ✓ copied on the row named `key` for a moment;
    // where the surface can't copy, a toast says `instead`.
    copy: (key: string, text: string, surface: string, instead: string) => copyText($, key, text, surface, instead),
    stopAlarm: () => stopAlarm($),
    toggleGroup: async (name: string) => {
      await update($, groupsOpen, chosen => ({ ...chosen, [name]: !groupOpen(chosen, name as GroupName) }))
    },
    // A press opens or folds at once on what the 3-second poll last read; a
    // fresh read of the file follows, so what was just added shows a moment later.
    toggleTaskfile: async () => {
      await update($, taskfileOpen, open => !open)
      void refresh($).catch(() => {})
    },
    // Turn to the next priority the file has, wrapping through "all", and
    // show it: like effort, one press, one step.
    // Turned at once on what the poll last read; a fresh read follows.
    nextTier: async () => {
      const [file, tier] = await Promise.all([read($, taskfile), read($, taskfileTier)])
      const to = nextTier(openItems(file.items), tier)
      await Promise.all([update($, taskfileTier, () => to), update($, taskfileOpen, () => true)])
      void refresh($).catch(() => {})
    },
  }
}

const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

async function copyText($: EngineInterface, key: string, text: string, surface: string, instead: string) {
  const out = await $.ui.copy({ text, surface: surface as any }).catch(() => ({ isCopied: false }))
  if (!out.isCopied) return void $.ui.toast(`board: couldn't copy; ${instead}`)
  await update($, copied, () => key)
  await $.clock.sleep(COPIED_MS)
  await update($, copied, now => (now === key ? '' : now))
}

// Everything a drawing reads, asked for at once: a pane is drawn again on
// every wheel tick, so reads one after another would slow scrolling.
async function context($: EngineInterface, width: number, ui: Ctx['ui'], act: Ctx['act']): Promise<Ctx> {
  const [now, who, tasksNow, agentsNow, usageNow, modelNow, effortNow, customNow, commandStateNow, taskfileNow, taskfileOpenNow, taskfileTierNow, groupsOpenNow, homeNow, copiedNow, weatherNow, alarmsNow, ringingNow, remindersNow, locatedNow, movedNow, problemNow, readyNow, readyValuesNow] =
    await Promise.all([
      $.clock.now(),
      read($, me),
      read($, tasks),
      read($, agents),
      read($, usage),
      read($, model),
      read($, effort),
      read($, custom),
      read($, commandState),
      read($, taskfile),
      read($, taskfileOpen),
      read($, taskfileTier),
      read($, groupsOpen),
      read($, home),
      read($, copied),
      read($, weather),
      read($, alarms),
      read($, ringing),
      read($, reminders),
      read($, located),
      read($, moved),
      read($, boardError),
      read($, readyList),
      read($, readyValues),
      // Read so a drawing of the clock redraws when the minute turns.
      read($, minute),
    ])
  return {
    ui,
    width,
    now,
    who,
    tasks: tasksNow,
    agents: agentsNow,
    usage: usageNow,
    model: modelNow,
    effort: effortNow,
    custom: customNow,
    commands: commandNames,
    commandState: commandStateNow,
    staleMs,
    taskfile: taskfileNow,
    taskfileOpen: taskfileOpenNow,
    taskfileTier: taskfileTierNow,
    groupsOpen: groupsOpenNow,
    home: homeNow,
    copied: copiedNow,
    weather: weatherNow,
    alarms: alarmsNow,
    ringing: ringingNow,
    reminders: remindersNow,
    located: locatedNow,
    moved: movedNow,
    problem: problemNow,
    ready: readyNow.filter(b => b.enabled),
    readyValues: readyValuesNow,
    act,
  }
}

export const register: Register = (on, options) => {
  const { commands, problems } = parseCommandBlocks(options.blocks, [...BLOCKS.map(b => b.name), ...Object.keys(RENAMED)])
  const all = [...BLOCKS, ...Object.entries(commands).map(([name, command]) => commandBlock(name, command))]
  commandNames = Object.keys(commands)
  const minutes = Number(options.stale)
  staleMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60_000
  const band = pick(all, options.band, 'summary,model,effort,board').filter(b => b.band)
  // Every block the pane can show, and the `pane` setting's own choice of them.
  const choosable = all.filter(b => b.pane)
  const setting = String(options.pane ?? 'work,todo,compact,usage')
  const fromSetting = pick(choosable, setting, '').map(b => b.name)
  bandReadsTodo = band.some(b => b.name === 'todo')
  paneSetting = setting
  paneChoosable = choosable.map(b => b.name)
  paneFromSetting = fromSetting
  reads(fromSetting)
  configLocation = String(options.location ?? '')
  fahrenheit = /^f/i.test(String(options.units ?? ''))
  alarmSetting = String(options.alarm ?? '')
  place = null
  const cycles = { models: list(options.models, 'opus,sonnet,haiku'), efforts: list(options.efforts, 'low,medium,high,xhigh,max') }

  on('session.start', async ($, e, next) => {
    // Clears a status line an earlier version of this mod left behind.
    $.ui.status(undefined)
    const startModel = await $.session.model()
    // Before the first request, the level the session will start on: the env
    // override, else the model's own effortLevel (modelSettings), else the
    // general one (what /effort saves). The first request's effort
    // (turn.step below) then replaces it with the truth.
    const level = (v: unknown) => (typeof v === 'string' && !['auto', 'unset', ''].includes(v) ? v : undefined)
    const settings: any = await $.settings.read().catch(() => ({}))
    const perModel = Object.entries(settings?.modelSettings ?? {}).find(([key]) => key === startModel || startModel.includes(key))?.[1] as any
    const startEffort =
      level(await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')) ?? level(perModel?.effortLevel) ?? level(settings?.effortLevel) ?? ''
    await update($, model, () => startModel)
    await update($, effort, () => startEffort)
    session = await $.session.id()
    const homeDir = await $.env.get('HOME').catch(() => undefined)
    if (homeDir) await update($, home, () => homeDir)
    const name = await takeName($, await $.env.get('BOARD_AGENT'))
    await update($, me, () => name)

    for (const t of TOOLS)
      await $.tool.register({
        name: t.name,
        description: t.description,
        inputSchema: { type: 'object', properties: t.schema ?? {}, required: t.required ?? [] },
        isDeferred: false,
      })
    await $.tool.register({
      name: 'board_alarm',
      description: AGENT_ALARM,
      inputSchema: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'Why the person should look, in a few words: "T-004 done: deploy is green".' },
          at: { type: 'string', description: 'A time to ring once: 13:30, 6pm, or 1:30 for whichever 1:30 comes next. Leave out to ring now.' },
          inMinutes: { type: 'number', description: 'Ring once this many minutes from now, instead of at.' },
        },
        required: ['note'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_alarm_off',
      description: "Turn off the person's alarm: stop one ringing, and clear the alarms set (the daily ones and one-offs). Give a time to clear only that one.",
      inputSchema: { type: 'object', properties: { at: { type: 'string', description: 'Clear only the alarm at this time (14:00, 2pm). Leave out to clear all.' } }, required: [] },
      isDeferred: false,
    })
    await $.tool.register({ name: 'board_location', description: LOCATION_TOOL, inputSchema: { type: 'object', properties: {}, required: [] }, isDeferred: false })
    await $.command.register({ name: 'board', description: 'Open the modboard pane · /board alarm 7:30 sets an alarm, /board alarm off clears it · /board location sets the weather\'s' })
    await estimateContext($)
    await loadPane($)

    await loadAlarms($)
    await loadReminders($)
    await tick($)
    $.clock.every(TICK_MS, () => tick($).catch(() => {}))
    // Weather, only once there is a location: the last reading at once, then
    // a fresh one, then one every 20 minutes.
    await loadPlace($)
    const kept: any = await $.store.get('weather').catch(() => undefined)
    if (place && kept && kept.from === weatherKey() && kept.reading) await update($, weather, () => kept.reading as Weather)
    void fetchWeather($)
    $.clock.every(WEATHER_MS, () => fetchWeather($).catch(() => {}))

    await refresh($)
    $.clock.every(POLL_MS, () => refresh($).catch(() => {}))
    for (const problem of problems) $.ui.toast(`board: ${problem}`)
    if (Object.keys(commands).length) {
      // Not awaited: a command that hangs must not hold up the session's start.
      void runCommands($, commands).catch(() => {})
      $.clock.every(COMMAND_MS, () => runCommands($, commands).catch(() => {}))
    }
    // Ready-made blocks: the list, then each one that's on, on its own
    // schedule. The list is read again now and then, so one turned on or off
    // through the CLI shows here too. Not awaited: nothing here may hold up
    // the session's start.
    void loadReady($).then(() => runReady($)).catch(() => {})
    $.clock.every(READY_TICK_MS, () => runReady($).catch(() => {}))
    $.clock.every(60_000, () => loadReady($).catch(() => {}))
    // Presence: keeps this session's name while it is open, so no other
    // session can take it; leases stay tied to work (see tool.call below).
    $.clock.every(PRESENCE_MS, async () => {
      await cli($, ['register', name, '--session', session]).catch(() => {})
      if (toolsRunning > 0) await beat($)
    })

    return next(e)
  })

  for (const t of TOOLS)
    on('tool.call', { tool: `mcp__modboard__${t.name}` }, async ($, e) => {
      const out = await board($, t.args(e))
      await refresh($)
      return { result: out.ok ? out.text : `error: ${out.text}` }
    }).catch(() => ({ result: 'error: the board CLI could not run (is node on PATH?)' }))

  on('tool.call', { tool: 'mcp__modboard__board_location' } as any, async $ => ({ result: await askLocation($) })).catch(() => ({
    result: 'error: could not ask for the location',
  }))

  on('tool.call', { tool: 'mcp__modboard__board_alarm' } as any, async ($, e: any) => ({ result: await agentAlarm($, e) })).catch(() => ({
    result: 'error: the alarm could not be set',
  }))

  on('tool.call', { tool: 'mcp__modboard__board_alarm_off' } as any, async ($, e: any) => {
    const at = e.at === undefined || e.at === '' ? '' : String(e.at)
    if (at && !alarmTime(at)) return { result: `error: "${at}" is not a time; give HH:MM (14:00) or 2pm` }
    return { result: await alarmCommand($, `off ${at}`) }
  }).catch(() => ({ result: 'error: the alarm could not be turned off' }))

  // Leases need a heartbeat; an LLM won't send one, so tool activity does:
  // after each tool call, and, while one is still running (a 20-minute test
  // run in Bash), with each presence ping, so a long call can't outlast the
  // lease.
  on('tool.call', async ($, e, next) => {
    toolsRunning++
    let ran
    try {
      ran = await next(e)
    } finally {
      toolsRunning--
    }
    const now = await $.clock.now()
    if (now - lastBeat > HEARTBEAT_MS) {
      lastBeat = now
      await beat($)
    }
    return ran
  })

  // Each main-session request names the model and effort it runs with: the
  // truth when the person switched with /model or /effort themselves.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      try {
        await update($, model, () => e.model)
        if (e.effort !== undefined) await update($, effort, () => String(e.effort))
      } catch {}
    }
    return yield* next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => ({
      limits: e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
      context: e.context.percent,
      costUsd: e.cost?.usd,
    }))
    return next(e)
  })

  // A session that ends (exit, /clear, resume, logout) releases what it holds
  // and gives up its name, so neither sits orphaned until a lease runs out.
  on('session.end', async ($, e, next) => {
    await board($, ['release-all', '--session', session]).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'board' }, async ($, e) => {
    const [sub, ...rest] = (e.args ?? '').trim().split(/\s+/)
    if (sub === 'alarm') return { text: await alarmCommand($, rest.join(' ')) }
    if (sub === 'location') return { text: await askLocation($) }
    const opened = await openBoard($)
    if (opened.isPlaced) return { text: 'Board pane opened.' }
    const list = (await read($, tasks)).filter(t => t.status !== 'done')
    return { text: list.map(t => `${SYMBOL[t.status]} ${t.id}  ${t.title}${t.claim ? `  ${t.claim.owner}` : ''}`).join('\n') || '(no open tasks)' }
  })

  // The pane's own ✕ closes it too.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE && (result as any)?.deny === undefined) await update($, paneOpen, () => false)
    return result
  })

  // The band: one line above the prompt, quiet when no block has anything to say.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !band.length) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const c = await context($, e.props.bodyColumns, { Box, Text, Button }, actions($, cycles))
    const offered = band.map(b => b.band!(c)).filter((forms): forms is BandForm[] => forms !== null && forms.length > 0)
    // A part at the line's end is placed last but kept second only to the
    // first block: on a short line, the parts between it and the first go first.
    const ranked = offered.map((forms, at) => ({ forms, at })).sort((x, y) => (x.at === 0 ? -1 : y.at === 0 ? 1 : Number(!!y.forms[0]!.end) - Number(!!x.forms[0]!.end)))
    const kept = fit(ranked.map(r => r.forms), e.props.bodyColumns - CONTROL)
    const parts = kept.map((part, i) => ({ part, at: ranked[i]!.at })).sort((x, y) => x.at - y.at).map(r => r.part)
    if (!parts.length) return next(e)
    // A part marked `end` takes the room left over and sits at its right edge.
    // Claude Code keeps its [-] outside bodyColumns, so the line may run its
    // full width: the end part then sits a space from the [-].
    const ends = parts.some(part => part.end)
    return (
      <Box gap={GAP} flexWrap="nowrap" width={ends ? e.props.bodyColumns : undefined}>
        {parts.map(part =>
          part.end ? (
            <Box flexGrow={1} flexShrink={0} justifyContent="flex-end">
              {part.tree}
            </Box>
          ) : (
            <Box flexShrink={0}>{part.tree}</Box>
          ),
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [chosen, view] = await Promise.all([read($, paneBlocks), read($, paneView)])
    // The list of blocks, alone: each row ticks its block on or off; Done
    // turns the pane to the board, as modBOARD does.
    // The list of blocks, alone, on two tabs. Blocks: each row ticks its block
    // on or off. Order: the ticked blocks, numbered, with buttons to move them.
    // Done turns the pane to the board, as modBOARD does.
    if (view === 'blocks' || view === 'order') {
      const offered = choosable.filter(b => b.listed !== false)
      const names = offered.map(b => b.name)
      const ticked = chosen.filter(n => names.includes(n))
      const tab = (to: 'blocks' | 'order', label: string) => (
        <Button key={`tab-${to}`} plain onPress={() => update($, paneView, () => to)}>
          <Text bold={view === to} dimColor={view !== to}>
            {label}
          </Text>
        </Button>
      )
      // What changed since the list opened, in yellow at the right end of the
      // tabs' line. Each tick and move is saved as it is made: there is no Done.
      // The list needs only these two, not the whole board, so it opens fast.
      const [start, movedNow] = await Promise.all([read($, listStart), read($, moved)])
      const changed = changes(start, chosen)
      const tabs = (
        <Box flexDirection="column">
          <Box gap={4}>
            {tab('blocks', 'Blocks')}
            {tab('order', 'Order')}
            {changed ? (
              <Box flexGrow={1} justifyContent="flex-end">
                <Text color="warning" wrap="truncate">
                  {`saved · ${changed}`}
                </Text>
              </Box>
            ) : null}
          </Box>
          <Text color={CAP}>{view === 'blocks' ? '━━━━━━' : `${' '.repeat(10)}━━━━━`}</Text>
        </Box>
      )
      if (view === 'blocks') {
        // Grouped as the pane draws them: the bars under one `limits` row, and
        // the ready-made blocks and your own command blocks under `project`.
        // A group's row shows or hides the group; the rows under it pick
        // what's in it.
        const ready = await read($, readyList)
        const bars = offered.filter(b => BARS.has(b.name))
        const pad = Math.max(...offered.map(b => b.name.length), ...ready.map(b => b.id.length), ...commandNames.map(n => n.length), 'limits'.length) + 2
        const row = (key: string, ticked: boolean, name: string, about: string, depth: number, press?: () => unknown) => {
          const text = `${ticked ? '[x]' : '[ ]'} ${name.padEnd(pad - depth * 2)}${about}`
          return (
            <Box key={`row-${key}`} paddingLeft={depth * 4}>
              {press ? (
                <Button key={key} plain onPress={press}>
                  {/* One Text in one colour, so the pointer lights the row as one
                      bar: ticked rows orange, the rest grey. */}
                  <Text color={ticked ? CAP : undefined} dimColor={!ticked} wrap="truncate">
                    {text}
                  </Text>
                </Button>
              ) : (
                // Not pressable (your own block, set in /config): grey, as text is.
                <Text dimColor wrap="truncate">
                  {text}
                </Text>
              )}
            </Box>
          )
        }
        const rows: any[] = []
        for (const b of offered) {
          if (BARS.has(b.name)) {
            if (b !== bars[0]) continue
            const any = bars.some(x => chosen.includes(x.name))
            rows.push(row('pick-limits', any, 'limits', 'context and usage bars', 0, () => toggleBars($, bars.map(x => x.name))))
            for (const x of bars) rows.push(row(`pick-${x.name}`, chosen.includes(x.name), x.name, x.about ?? '', 1, () => toggleBlock($, x.name)))
            continue
          }
          rows.push(row(`pick-${b.name}`, chosen.includes(b.name), b.name, b.about ?? '', 0, () => toggleBlock($, b.name)))
          if (b.name === 'project') {
            for (const r of ready) rows.push(row(`pick-ready-${r.id}`, r.enabled, r.id, r.about, 1, () => toggleReady($, r.id)))
            for (const n of commandNames) rows.push(row(`mine-${n}`, true, n, 'your own · /config', 1))
          }
        }
        return (
          // A blank line under the last row, on both tabs.
          <Box flexDirection="column" paddingX={1} paddingBottom={1}>
            {tabs}
            <Box flexDirection="column" marginTop={1} paddingLeft={2}>
              {rows}
            </Box>
          </Box>
        )
      }
      // ▲ and ▼ on every row, in two fixed columns; where one would do nothing
      // (▲ on the first row, ▼ on the last) it is grey and can't be pressed.
      // The bars are one row, `limits (usage, compact)`: they draw together.
      const rows = orderRows(ticked).map(row => ({ ...row, label: row.names.length > 1 ? `limits (${row.names.join(', ')})` : row.key }))
      const pad = Math.max(0, ...rows.map(row => row.label.length)) + 3
      const last = rows.length - 1
      const slot = (key: string, label: string, show: boolean, to: number, name: string) =>
        show ? (
          <Button key={key} plain onPress={() => moveBlock($, name, to, names)}>
            <Text bold color={CAP}>
              {label}
            </Text>
          </Button>
        ) : (
          // Grey and not pressable: ▲ on the first row, ▼ on the last.
          <Text dimColor>{label}</Text>
        )
      return (
        <Box flexDirection="column" paddingX={1} paddingBottom={1}>
          {tabs}
          <Box flexDirection="column" marginTop={1} paddingLeft={2}>
            {rows.length ? (
              rows.map(({ key: name, label }, at) => (
                <Box gap={1}>
                  <Text color={movedNow === name ? CAP : undefined} bold={movedNow === name} wrap="truncate">
                    {`${String(at + 1).padStart(2)}  ${label.padEnd(pad)}`}
                  </Text>
                  <Box flexShrink={0} gap={1}>
                    {slot(`up-${name}`, '[ ▲ ]', at > 0, at - 1, name)}
                    {slot(`down-${name}`, '[ ▼ ]', at < last, at + 1, name)}
                  </Box>
                </Box>
              ))
            ) : (
              <Text dimColor>Nothing ticked yet: tick blocks on the Blocks tab.</Text>
            )}
          </Box>
        </Box>
      )
    }
    const c = await context($, e.props.bodyColumns ?? 40, { Box, Text, Button }, actions($, cycles))
    const pane = chosen.map(name => choosable.find(b => b.name === name)).filter(b => b !== undefined)
    // The board's error goes under the work block's title when work is first,
    // else on top of the pane, never both.
    const workFirst = pane[0]?.name === 'work'
    const drawn = workFirst ? c : { ...c, problem: '' }
    const parts = pane.map(b => ({ block: b, part: b.pane!(drawn) })).filter(p => p.part !== null)
    // Sections, in order: each block on its own, except that bars side by
    // side (context, the 5-hour limit) make one, under a Limits heading.
    // Every bar joins the one Limits section, where the first bar sits, even
    // with other blocks between them in the order: never two Limits headings.
    const sections: (typeof parts)[] = []
    for (const p of parts) {
      const bars = BARS.has(p.block.name) ? sections.find(s => BARS.has(s[0]!.block.name)) : undefined
      if (bars) bars.push(p)
      else sections.push([p])
    }
    const limits = (bars: typeof parts) => {
      const open = groupOpen(c.groupsOpen, 'limits')
      // Folded, the heading keeps the figures, each in its bar's colour.
      const seen = new Set<string>()
      const brief = bars
        .flatMap(b => b.block.brief?.(c) ?? [])
        .filter(f => !seen.has(f.name) && seen.add(f.name))
      return (
        <Box flexDirection="column">
          <Box>
            <Button key="group-limits" plain onPress={() => c.act.toggleGroup('limits')}>
              <Text bold>{`${open ? '▾' : '▸'} Limits`}</Text>
            </Button>
            {!open &&
              brief.flatMap(f => [
                <Text dimColor> · </Text>,
                <Text color={tone(f.percent)} dimColor={!tone(f.percent)}>{`${f.name} ${Math.round(f.percent)}%`}</Text>,
              ])}
          </Box>
          {open && (
            <Box flexDirection="column" marginTop={1} paddingLeft={2}>
              {bars.map((b, i) => (i ? <Box marginTop={1}>{b.part}</Box> : b.part))}
            </Box>
          )}
        </Box>
      )
    }
    const body = (section: typeof parts) => (BARS.has(section[0]!.block.name) ? limits(section) : section[0]!.part)
    // A grey rule between sections.
    const rule = '─'.repeat(Math.max(1, (e.props.bodyColumns ?? 40) - 2))
    return (
      <Box flexDirection="column" paddingX={1}>
        {/* In red when the board stopped answering: what is below is old. Under
            the work block's title when work comes first; else first of all. */}
        {workFirst ? null : Problem(c)}
        {sections.map((section, i) =>
          i === 0 ? (
            body(section)
          ) : (
            <Box flexDirection="column" marginTop={1}>
              <Box marginBottom={1}>
                <Text dimColor>{rule}</Text>
              </Box>
              {body(section)}
            </Box>
          ),
        )}
      </Box>
    )
  })
}
