import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, Task } from '../types'
import { BLOCKS, type BandForm, type Ctx } from './blocks'

// The mod is an adapter: every board read and write goes through bin/board.mjs,
// the same CLI Codex or a human runs, so it works whatever storage block holds
// the board. The mod adds what only Claude's host can: the session's identity,
// heartbeats, usage readings, and a display built from blocks (./blocks): a
// one-line band above the prompt, and the /board pane.

const PANE = 'agent-board'
const HEARTBEAT_MS = 60_000
const PRESENCE_MS = 60_000
const POLL_MS = 3_000
const NAME_TRIES = 9

const tasks = atom({ plugin: 'agent-board', key: 'tasks' } as const, [])
const agents = atom({ plugin: 'agent-board', key: 'agents' } as const, [])
const me = atom({ plugin: 'agent-board', key: 'me' } as const, '')
const usage = atom({ plugin: 'agent-board', key: 'usage' } as const, { limits: [] })
const model = atom({ plugin: 'agent-board', key: 'model' } as const, '')
const effort = atom({ plugin: 'agent-board', key: 'effort' } as const, '')

let session = ''
let lastBeat = 0

async function cli($: EngineInterface, args: string[]) {
  const run = await $.process.run(['node', `${$.plugin.root}/bin/board.mjs`, ...args])
  return { ok: run.exitCode === 0, code: run.exitCode, text: (run.exitCode === 0 ? run.stdout : run.stderr || run.stdout).trim() }
}

async function board($: EngineInterface, args: string[]) {
  return cli($, [...args, '--as', await read($, me)])
}

// Take the name asked for in BOARD_AGENT, or the next free one after it; with
// none asked for, a name from the session id, which no other session has.
async function takeName($: EngineInterface, wanted: string | undefined) {
  if (!wanted) {
    const name = `claude:${session.slice(0, 8)}`
    await cli($, ['register', name, '--session', session])
    return name
  }
  for (let i = 1; i <= NAME_TRIES; i++) {
    const name = i === 1 ? wanted : `${wanted}-${i}`
    const taken = await cli($, ['register', name, '--session', session])
    if (taken.ok) {
      if (i > 1) $.ui.toast(`board: "${wanted}" is in use by another live session, so this one is "${name}"`)
      return name
    }
    if (taken.code !== 7) break
  }
  const name = `claude:${session.slice(0, 8)}`
  $.ui.toast(`board: could not take the name "${wanted}", so this session is "${name}"`)
  await cli($, ['register', name, '--session', session])
  return name
}

async function refresh($: EngineInterface) {
  const out = await cli($, ['view', '--json'])
  if (!out.ok) return
  const view = JSON.parse(out.text) as { tasks: Task[]; agents: Agent[] }
  await update($, tasks, () => view.tasks)
  await update($, agents, () => view.agents)
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
    description: 'Show one task with its acceptance criteria, notes and handoffs. Read this before resuming a task someone else released.',
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
      'Give up a task you hold without finishing it. Always write a handoff: what is done, what is left, where to look — the next agent starts from it.',
    schema: { id: { type: 'string' }, handoff: { type: 'string' } },
    required: ['id', 'handoff'],
    args: (i: any) => ['release', i.id, '--handoff', i.handoff],
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

const pick = (setting: unknown, fallback: string) =>
  String(setting ?? fallback)
    .split(',')
    .map(name => BLOCKS.find(b => b.name === name.trim()))
    .filter(b => b !== undefined)

const GAP = 3

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

// Switch the way the person would, through Claude Code's own commands, so
// everything else in the session sees the change.
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
  }
}

async function context($: EngineInterface, width: number, ui: Ctx['ui'], act: Ctx['act']): Promise<Ctx> {
  return {
    ui,
    width,
    now: await $.clock.now(),
    who: await read($, me),
    tasks: await read($, tasks),
    agents: await read($, agents),
    usage: await read($, usage),
    model: await read($, model),
    effort: await read($, effort),
    act,
  }
}

export const register: Register = (on, options) => {
  const band = pick(options.band, 'summary,usage,model,effort').filter(b => b.band)
  const pane = pick(options.pane, 'tasks,usage').filter(b => b.pane)
  const cycles = { models: list(options.models, 'opus,sonnet,haiku'), efforts: list(options.efforts, 'low,medium,high,xhigh,max') }

  on('session.start', async ($, e, next) => {
    // Clears a status line an earlier version of this mod left behind.
    $.ui.status(undefined)
    const startModel = await $.session.model()
    const startEffort = (await $.env.get('CLAUDE_EFFORT')) ?? ''
    await update($, model, () => startModel)
    await update($, effort, () => startEffort)
    session = await $.session.id()
    const name = await takeName($, await $.env.get('BOARD_AGENT'))
    await update($, me, () => name)

    for (const t of TOOLS)
      await $.tool.register({
        name: t.name,
        description: t.description,
        inputSchema: { type: 'object', properties: t.schema ?? {}, required: t.required ?? [] },
        isDeferred: false,
      })
    await $.command.register({ name: 'board', description: 'Open the shared agent board pane' })

    await refresh($)
    $.clock.every(POLL_MS, () => refresh($).catch(() => {}))
    // Presence: keeps this session's name while it is open, so no other
    // session can take it; leases stay tied to work (see tool.call below).
    $.clock.every(PRESENCE_MS, () => cli($, ['register', name, '--session', session]).catch(() => {}))

    return next(e)
  })

  for (const t of TOOLS)
    on('tool.call', { tool: `mcp__agent-board__${t.name}` }, async ($, e) => {
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

  on('command.run', { command: 'board' }, async $ => {
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: 'Agent board' })
    if (opened.isPlaced) return { text: 'Board pane opened.' }
    const list = (await read($, tasks)).filter(t => t.status !== 'done')
    return { text: list.map(t => `${SYMBOL[t.status]} ${t.id}  ${t.title}${t.claim ? `  ${t.claim.owner}` : ''}`).join('\n') || '(no open tasks)' }
  })

  // The band: one line above the prompt, quiet when no block has anything to say.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !band.length) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const c = await context($, e.props.bodyColumns, { Box, Text, Button }, actions($, cycles))
    const offered = band.map(b => b.band!(c)).filter((forms): forms is BandForm[] => forms !== null && forms.length > 0)
    const parts = fit(offered, e.props.bodyColumns)
    if (!parts.length) return next(e)
    return (
      <Box gap={GAP} flexWrap="nowrap">
        {parts.map(part => (
          <Box flexShrink={0}>{part.tree}</Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const c = await context($, e.props.bodyColumns ?? 40, { Box, Text, Button }, actions($, cycles))
    const parts = pane.map(b => b.pane!(c)).filter(part => part !== null)
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {parts}
      </Box>
    )
  })
}
