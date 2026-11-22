import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, Task, TaskFile, Weather } from '../types'
import { BLOCKS, type BandForm, type Block, type Ctx } from './blocks'
import { CAP } from './blocks/board'
import { hhmm } from './blocks/clock'
import { commandBlock, firstLine, parseCommandBlocks } from './blocks/command'
import { groupOpen, type GroupName } from './blocks/tasks'
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
const NAME_TRIES = 9

const tasks = atom({ plugin: 'modboard', key: 'tasks' } as const, [])
const agents = atom({ plugin: 'modboard', key: 'agents' } as const, [])
const me = atom({ plugin: 'modboard', key: 'me' } as const, '')
const usage = atom({ plugin: 'modboard', key: 'usage' } as const, { limits: [] })
const model = atom({ plugin: 'modboard', key: 'model' } as const, '')
const effort = atom({ plugin: 'modboard', key: 'effort' } as const, '')
const custom = atom({ plugin: 'modboard', key: 'custom' } as const, {} as Record<string, string>)
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
const paneBlocks = atom({ plugin: 'modboard', key: 'paneBlocks' } as const, [] as string[])

// The pixel clock's minute, written when it turns, so the clock redraws then
// and not on every poll; the weather; the alarm times; and the one ringing.
const minute = atom({ plugin: 'modboard', key: 'minute' } as const, '')
const weather = atom({ plugin: 'modboard', key: 'weather' } as const, null as Weather | null)
const alarms = atom({ plugin: 'modboard', key: 'alarms' } as const, [] as string[])
const ringing = atom({ plugin: 'modboard', key: 'ringing' } as const, '')
const TICK_MS = 5_000
const WEATHER_MS = 20 * 60_000
const RING_MS = 60_000
const ALARM_SOUND = 'hooks/sounds/alarm.wav'

let session = ''
let lastBeat = 0

async function cli($: EngineInterface, args: string[]) {
  const run = await $.process.run(['node', `${$.plugin.root}/bin/board.mjs`, ...args])
  return { ok: run.exitCode === 0, code: run.exitCode, text: (run.exitCode === 0 ? run.stdout : run.stderr || run.stdout).trim() }
}

async function board($: EngineInterface, args: string[]) {
  return cli($, [...args, '--as', await read($, me)])
}

// The board names the session by what it runs and when it joined ("claude 1",
// "claude 2"), unless BOARD_AGENT asks for a name: then that one, or the next
// free one after it.
async function joined($: EngineInterface) {
  const out = await cli($, ['join', 'claude', '--session', session, '--json'])
  try {
    if (out.ok) return (JSON.parse(out.text) as { name: string }).name
  } catch {}
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
      ? (kept.blocks as unknown[]).filter((n): n is string => typeof n === 'string' && paneChoosable.includes(n))
      : paneFromSetting
  await update($, paneBlocks, () => names)
  reads(names)
}

// A row on the list of blocks pressed: ticked, the block goes last, below
// the others; unticked, it leaves the pane. Kept between sessions.
async function toggleBlock($: EngineInterface, name: string) {
  const now = await read($, paneBlocks)
  const names = now.includes(name) ? now.filter(n => n !== name) : [...now, name]
  // The tick changes first; saving follows.
  await update($, paneBlocks, () => names)
  reads(names)
  await $.store.set('paneBlocks', { from: paneSetting, blocks: names }).catch(() => $.ui.toast('board: could not save the list of blocks'))
  if (name === 'todo' && names.includes('todo')) await refresh($)
}

// What went wrong, in one line: the board's own message, or the error line of
// a crash ("EACCES: permission denied, open '…/board.json'"), not its stack.
function reason(text: string) {
  const lines = text.split('\n').map(l => l.trim())
  const line = lines.find(l => /^board:/.test(l)) ?? lines.find(l => /^\w*Error\b/.test(l)) ?? lines.find(Boolean) ?? ''
  return line.replace(/^board:\s*/, '').replace(/^\w*Error:\s*/, '')
}

// A polled value is written only when it changed: each write redraws its
// readers, and a pane redrawn every few seconds for nothing scrolls in jerks.
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function refresh($: EngineInterface) {
  let problem = ''
  try {
    const out = await cli($, ['view', '--json'])
    if (out.ok) {
      const view = JSON.parse(out.text) as { tasks: Task[]; agents: Agent[] }
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
    schema: { title: { type: 'string' }, description: { type: 'string' }, accept: { type: 'string' } },
    required: ['title'],
    args: (i: any) => [
      'add',
      i.title,
      ...(i.description ? ['--desc', i.description] : []),
      ...(i.accept ? ['--accept', i.accept] : []),
    ],
  },
  {
    name: 'board_claim',
    description:
      'Claim a task before working on it. Fails if another agent holds it — then pick another task. Your lease renews automatically while you work.',
    schema: { id: { type: 'string' } },
    required: ['id'],
    args: (i: any) => ['claim', i.id],
  },
  {
    name: 'board_note',
    description: 'Record progress on a task you hold (what is done, what is next, decisions).',
    schema: { id: { type: 'string' }, text: { type: 'string' } },
    required: ['id', 'text'],
    args: (i: any) => ['note', i.id, i.text],
  },
  {
    name: 'board_release',
    description:
      'Give up a task you hold without finishing it. Always write a handoff: what is done, what is left, where to look, each part separated by a semicolon ("done X; left Y; see Z") — the next agent starts from it. ' +
      'The board records the worktree, branch and commit with it; record your last passing check with board_check first.',
    schema: { id: { type: 'string' }, handoff: { type: 'string' } },
    required: ['id', 'handoff'],
    args: (i: any) => ['release', i.id, '--handoff', i.handoff],
  },
  {
    name: 'board_check',
    description:
      'Record a check that just passed on a task you hold: the command you ran (tests, build, lint) and saw succeed. ' +
      'The board adds the worktree, branch and commit, so whoever picks the task up knows what was green and where. ' +
      'Record only checks that passed.',
    schema: { id: { type: 'string' }, command: { type: 'string' } },
    required: ['id', 'command'],
    args: (i: any) => ['check', i.id, i.command, '--passed'],
  },
  {
    name: 'board_done',
    description:
      'Mark a task you hold as done. Only after you have checked it against its acceptance criteria (board_show lists them). ' +
      'The note says how you verified it: what you ran or checked and what you saw.',
    schema: { id: { type: 'string' }, note: { type: 'string' } },
    required: ['id', 'note'],
    args: (i: any) => ['done', i.id, '--note', i.note ?? ''],
  },
]

const SYMBOL = { todo: '○', claimed: '◐', done: '●' } as const

// Names blocks had before they were renamed, so a setting written then still
// shows them. They stay taken: a command block can't use them either.
const RENAMED: Record<string, string> = { tasks: 'work', taskfile: 'todo' }

const pick = (all: Block[], setting: unknown, fallback: string) =>
  String(setting ?? fallback)
    .split(',')
    .map(name => name.trim())
    .map(name => all.find(b => b.name === (RENAMED[name] ?? name)))
    .filter(b => b !== undefined)

// Each command block's first line of output; a failing command shows nothing.
async function runCommands($: EngineInterface, commands: Record<string, string>) {
  const out: Record<string, string> = {}
  for (const [name, command] of Object.entries(commands)) {
    const run = await $.process.run(['sh', '-c', command]).catch(() => undefined)
    if (run && run.exitCode === 0) out[name] = firstLine(run.stdout)
  }
  if (!same(await read($, custom), out)) await update($, custom, () => out)
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
// Open-Meteo needs no key. Only the location set in /config is sent, through
// Claude Code's own fetch, so the organization's network policy holds.

type Place = { latitude: number; longitude: number; name: string }
let place: Place | null = null
let weatherSetting = ''
let fahrenheit = false

// "Bengaluru" is looked up once a session; "12.97,77.59" is used as it is.
async function locate($: EngineInterface): Promise<Place | null> {
  if (place) return place
  const coords = weatherSetting.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/)
  if (coords) return (place = { latitude: Number(coords[1]), longitude: Number(coords[2]), name: weatherSetting.trim() })
  const found = await $.http.fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(weatherSetting.trim())}`)
  if (!found.ok) return null
  const first = (JSON.parse(found.text) as { results?: Place[] }).results?.[0]
  if (!first) {
    $.ui.toast(`board: no place called "${weatherSetting.trim()}" for the weather`)
    return null
  }
  return (place = { latitude: first.latitude, longitude: first.longitude, name: first.name })
}

// A failed fetch keeps the last reading; the block says how old it is.
async function fetchWeather($: EngineInterface) {
  if (!weatherSetting.trim()) return
  try {
    const at = await locate($)
    if (!at) return
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
    await $.store.set('weather', { from: `${weatherSetting}|${fahrenheit}`, reading }).catch(() => {})
  } catch {}
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

async function ring($: EngineInterface, at: string) {
  await update($, ringing, () => at)
  $.ui.toast(`⏰ ${at}`)
  $.ui.notify(`It's ${at}.`, { title: '⏰ Alarm', key: `alarm-${at}` }).catch(() => {})
  stopSound?.abort()
  const stop = (stopSound = new AbortController())
  $.audio.play({ asset: ALARM_SOUND }, { shouldLoop: true, signal: stop.signal }).catch(() => {})
  // Rings a minute, unless stopped first.
  await $.clock.sleep(RING_MS)
  if (stopSound === stop) await stopAlarm($)
}

async function stopAlarm($: EngineInterface) {
  stopSound?.abort()
  stopSound = null
  await update($, ringing, () => '')
}

// Every few seconds: when the minute turns, the clock redraws, and an alarm
// set for it rings.
async function tick($: EngineInterface) {
  const now = hhmm(await $.clock.now())
  if ((await read($, minute)) === now) return
  await update($, minute, () => now)
  if ((await read($, alarms)).includes(now)) void ring($, now)
}

// /board alarm 7:30 · /board alarm off · /board alarm off 7:30 · /board alarm
async function alarmCommand($: EngineInterface, args: string) {
  const now = await read($, alarms)
  const words_ = args.trim().split(/\s+/).filter(Boolean)
  const listed = (times: string[]) => (times.length ? `Alarm set for ${times.join(', ')}.` : 'No alarm set.')
  if (!words_.length) return listed(now)
  if (words_[0] === 'off' || words_[0] === 'clear') {
    await stopAlarm($)
    if (words_.length === 1) {
      await saveAlarms($, [])
      return 'Alarm off.'
    }
    const drop = alarmList(words_.slice(1).join(','))
    const left = now.filter(t => !drop.includes(t))
    await saveAlarms($, left)
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
    nextEffort: async () => {
      const to = after(cycles.efforts, await read($, effort))
      await $.command.run({ command: 'effort', args: to }).catch(() => $.ui.toast(`board: could not set effort to ${to}`))
      await update($, effort, () => to)
    },
    // modBOARD on the band: opens the pane, or closes it when it is already open.
    // Open at the list of blocks, it turns the pane to the board instead.
    openBoard: async () => {
      if (!(await read($, paneOpen))) return void (await openBoard($))
      if ((await read($, paneView)) !== 'board') return void (await update($, paneView, () => 'board'))
      await $.ui.close({ id: PANE }).catch(() => {})
      await update($, paneOpen, () => false)
    },
    // blocks on the band: the pane, open at the list of blocks alone.
    // Pressed again while the list shows, it closes the pane.
    openBlocks: async () => {
      if ((await read($, paneOpen)) && (await read($, paneView)) === 'blocks') {
        await $.ui.close({ id: PANE }).catch(() => {})
        return void (await update($, paneOpen, () => false))
      }
      await update($, paneView, () => 'blocks')
      if (await read($, paneOpen)) return
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
    copyPath: async (id: string, path: string, surface: string) => {
      const out = await $.ui.copy({ text: `cd '${path.replace(/'/g, `'\\''`)}'`, surface: surface as any }).catch(() => ({ isCopied: false }))
      if (!out.isCopied) return void $.ui.toast(`board: couldn't copy; the worktree is ${path}`)
      await update($, copied, () => id)
      await $.clock.sleep(COPIED_MS)
      await update($, copied, now => (now === id ? '' : now))
    },
    stopAlarm: () => stopAlarm($),
    toggleGroup: async (name: string) => {
      await update($, groupsOpen, chosen => ({ ...chosen, [name]: !groupOpen(chosen, name as GroupName) }))
    },
    // A press reads the file again first, so what was just added is there.
    toggleTaskfile: async () => {
      await refresh($)
      await update($, taskfileOpen, open => !open)
    },
    // Turn to the next priority the file has, wrapping through "all", and
    // show it: like effort, one press, one step.
    nextTier: async () => {
      await refresh($)
      const items = openItems((await read($, taskfile)).items)
      const to = nextTier(items, await read($, taskfileTier))
      await update($, taskfileTier, () => to)
      await update($, taskfileOpen, () => true)
    },
  }
}

// Everything a drawing reads, asked for at once: a pane is drawn again on
// every wheel tick, so reads one after another would slow scrolling.
async function context($: EngineInterface, width: number, ui: Ctx['ui'], act: Ctx['act']): Promise<Ctx> {
  const [now, who, tasksNow, agentsNow, usageNow, modelNow, effortNow, customNow, taskfileNow, taskfileOpenNow, taskfileTierNow, groupsOpenNow, homeNow, copiedNow, weatherNow, alarmsNow, ringingNow] =
    await Promise.all([
      $.clock.now(),
      read($, me),
      read($, tasks),
      read($, agents),
      read($, usage),
      read($, model),
      read($, effort),
      read($, custom),
      read($, taskfile),
      read($, taskfileOpen),
      read($, taskfileTier),
      read($, groupsOpen),
      read($, home),
      read($, copied),
      read($, weather),
      read($, alarms),
      read($, ringing),
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
    taskfile: taskfileNow,
    taskfileOpen: taskfileOpenNow,
    taskfileTier: taskfileTierNow,
    groupsOpen: groupsOpenNow,
    home: homeNow,
    copied: copiedNow,
    weather: weatherNow,
    alarms: alarmsNow,
    ringing: ringingNow,
    act,
  }
}

export const register: Register = (on, options) => {
  const { commands, problems } = parseCommandBlocks(options.blocks, [...BLOCKS.map(b => b.name), ...Object.keys(RENAMED)])
  const all = [...BLOCKS, ...Object.entries(commands).map(([name, command]) => commandBlock(name, command))]
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
  weatherSetting = String(options.location ?? '')
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
    await $.command.register({ name: 'board', description: 'Open the modboard pane · /board alarm 7:30 sets an alarm, /board alarm off clears it' })
    await estimateContext($)
    await loadPane($)

    await loadAlarms($)
    await tick($)
    $.clock.every(TICK_MS, () => tick($).catch(() => {}))
    // Weather, only once a location is set: the last reading at once, then
    // a fresh one, then one every 20 minutes.
    if (weatherSetting.trim()) {
      const kept: any = await $.store.get('weather').catch(() => undefined)
      if (kept && kept.from === `${weatherSetting}|${fahrenheit}` && kept.reading) await update($, weather, () => kept.reading as Weather)
      void fetchWeather($)
      $.clock.every(WEATHER_MS, () => fetchWeather($).catch(() => {}))
    }

    await refresh($)
    $.clock.every(POLL_MS, () => refresh($).catch(() => {}))
    for (const problem of problems) $.ui.toast(`board: ${problem}`)
    if (Object.keys(commands).length) {
      await runCommands($, commands)
      $.clock.every(COMMAND_MS, () => runCommands($, commands).catch(() => {}))
    }
    // Presence: keeps this session's name while it is open, so no other
    // session can take it; leases stay tied to work (see tool.call below).
    $.clock.every(PRESENCE_MS, () => cli($, ['register', name, '--session', session]).catch(() => {}))

    return next(e)
  })

  for (const t of TOOLS)
    on('tool.call', { tool: `mcp__modboard__${t.name}` }, async ($, e) => {
      const out = await board($, t.args(e))
      await refresh($)
      return { result: out.ok ? out.text : `error: ${out.text}` }
    }).catch(() => ({ result: 'error: the board CLI could not run (is node on PATH?)' }))

  // Leases need a heartbeat; an LLM won't send one, so tool activity does.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const now = await $.clock.now()
    if (now - lastBeat > HEARTBEAT_MS) {
      lastBeat = now
      const who = await read($, me)
      // A failed heartbeat must never fail the tool call it rode in on.
      if ((await read($, tasks)).some(t => t.claim?.owner === who)) await board($, ['heartbeat']).catch(() => {})
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
    const [c, chosen, view, problem] = await Promise.all([
      context($, e.props.bodyColumns ?? 40, { Box, Text, Button }, actions($, cycles)),
      read($, paneBlocks),
      read($, paneView),
      read($, boardError),
    ])
    // The list of blocks, alone: each row ticks its block on or off; Done
    // turns the pane to the board, as modBOARD does.
    if (view === 'blocks') {
      const listed = choosable.filter(b => b.listed !== false)
      const pad = Math.max(...listed.map(b => b.name.length)) + 2
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>What should the board show?</Text>
          <Box flexDirection="column" marginTop={1} paddingLeft={2}>
            {listed.map(b => (
              <Box>
                <Button key={`pick-${b.name}`} plain onPress={() => toggleBlock($, b.name)}>
                  {/* One Text in one colour, so the pointer lights the row as one
                      bar: ticked rows orange, the rest grey. */}
                  <Text color={chosen.includes(b.name) ? CAP : undefined} dimColor={!chosen.includes(b.name)} wrap="truncate">
                    {`${chosen.includes(b.name) ? '[x]' : '[ ]'} ${b.name.padEnd(pad)}${b.about ?? ''}`}
                  </Text>
                </Button>
              </Box>
            ))}
          </Box>
          <Box marginTop={1} paddingLeft={2}>
            <Button key="blocks-done" plain onPress={() => update($, paneView, () => 'board')}>
              <Text bold color="success">Done</Text>
            </Button>
          </Box>
        </Box>
      )
    }
    const pane = chosen.map(name => choosable.find(b => b.name === name)).filter(b => b !== undefined)
    const parts = pane.map(b => ({ block: b, part: b.pane!(c) })).filter(p => p.part !== null)
    // Sections, in order: each block on its own, except that bars side by
    // side (context, the 5-hour limit) make one, under a Limits heading.
    const sections: (typeof parts)[] = []
    for (const p of parts) {
      const last = sections.at(-1)
      if (last && BARS.has(p.block.name) && BARS.has(last[0]!.block.name)) last.push(p)
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
        {/* First, in red, when the board stopped answering: what is below is old. */}
        {problem ? (
          <Box marginBottom={1}>
            <Text color="error" wrap="truncate">{`board not updating: ${problem}`}</Text>
          </Box>
        ) : null}
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
