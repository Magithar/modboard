// The block contract: what any renderer gets for one block. The localhost
// page, an MCP App and the Claude Code mod all draw from this same shape, so
// nothing here knows about any of them.
//
//   { id, type, schemaVersion, title, status: ready|loading|error, error?,
//     data, updatedAt, actions: [{ id, label, target?, input? }] }
//
// `type` picks the renderer. An action is a name the server knows and checks
// (claim T-005), never a command: a renderer can only ask. `input: 'text'`
// says the action needs a line of text from the person (a note).

export const SCHEMA_VERSION = 1

// The views every renderer draws (the widget, the bench, the text for a
// model or a terminal). A block's `type` is one of these; a renderer shows
// any other type as its raw data. A new view is added to each renderer and
// here together (test/renderers.test.mjs checks they agree).
export const VIEW_TYPES = ['tasks', 'line']

// v1 is stable. Within v1 a field may be added, never removed, renamed or
// given a new meaning; a renderer ignores fields it doesn't know. Anything
// else is v2, and a renderer shows a block of a version it doesn't speak as
// "needs a newer modBOARD" rather than guess.

const STATUSES = new Set(['ready', 'loading', 'error'])

export function blockData({ id, type, title, status = 'ready', error, data = null, actions = [], now = Date.now() }) {
  if (!id || !type || !title) throw new Error('a block needs an id, a type and a title')
  if (!STATUSES.has(status)) throw new Error(`a block's status is ready, loading or error, not "${status}"`)
  return {
    id,
    type,
    schemaVersion: SCHEMA_VERSION,
    title,
    status,
    ...(status === 'error' ? { error: error || 'failed' } : {}),
    data,
    updatedAt: new Date(now).toISOString(),
    actions: actions.map(({ id, label, target, input }) => ({ id, label, ...(target ? { target } : {}), ...(input === 'text' ? { input } : {}) })),
  }
}

const kindOf = t => (t.labels ?? []).find(l => l.startsWith('kind='))?.slice(5) ?? null

// A task released with a handoff: back to todo, its last note says where.
const handedOff = t => t.status === 'todo' && !!t.notes?.at(-1)?.where

// The board's tasks as one block. Open tasks are listed; done ones are only
// counted. `me` is who the person at this display acts as: claim is offered
// on a task nobody holds and nothing blocks; release and note on one `me`
// holds. Offering is only a hint: the server checks every action again.
// Every action a task can offer, in one table: what its button says, whether
// it needs a line of text, and when it is offered to the person at a
// display. The server's checks (lib/board-actions.mjs) and the widget tool's
// schema (lib/mcp.mjs) read this same table, so a button, its check and its
// schema can't drift apart. A new action is a new row here and its run there.
export const TASK_ACTIONS = {
  claim: { label: 'Claim', offered: t => t.status === 'todo' && !(t.waitingOn ?? []).length },
  note: { label: 'Note', input: 'text', offered: (t, me) => !!me && t.status === 'claimed' && t.claim?.owner === me },
  release: { label: 'Release', offered: (t, me) => !!me && t.status === 'claimed' && t.claim?.owner === me },
}

export const actionsFor = (t, me) =>
  Object.entries(TASK_ACTIONS)
    .filter(([, a]) => a.offered(t, me))
    .map(([id, a]) => ({ id, label: a.label, target: t.id, ...(a.input ? { input: a.input } : {}) }))

export function tasksBlock(tasks, { now, me } = {}) {
  const open = tasks.filter(t => t.status !== 'done')
  return blockData({
    id: 'tasks',
    type: 'tasks',
    title: 'Tasks',
    now,
    data: {
      counts: {
        inProgress: tasks.filter(t => t.status === 'claimed').length,
        waiting: open.filter(t => t.status === 'todo').length,
        done: tasks.length - open.length,
      },
      tasks: open.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        kind: kindOf(t),
        owner: t.claim?.owner ?? null,
        since: t.claim?.since ?? null,
        waitingOn: t.waitingOn ?? [],
        handedOff: handedOff(t),
      })),
    },
    actions: open.flatMap(t => actionsFor(t, me)),
  })
}

// A ready-made block's line (lib/ready-blocks.mjs) as a block. ok and empty
// are both ready; every other state is an error that says why.
export function lineBlock({ id, state, text }, { title, now, type = 'line' } = {}) {
  const fine = state === 'ok' || state === 'empty'
  return blockData({
    id,
    type,
    title: title ?? id,
    now,
    status: fine ? 'ready' : 'error',
    error: fine ? undefined : text,
    data: { text, state },
  })
}

// What is wrong with a block, as a list of reasons; empty when it keeps the
// v1 contract. A display runs this on every block before it shows it, so a
// block someone else wrote can only break its own card.
export function checkBlock(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return ['not an object']
  const why = []
  const str = (k, v = b[k]) => (typeof v === 'string' && v.length > 0) || why.push(`${k} is not a string`)
  str('id')
  str('type')
  str('title')
  if (b.schemaVersion !== SCHEMA_VERSION) why.push(`schemaVersion is ${JSON.stringify(b.schemaVersion)}, not ${SCHEMA_VERSION}`)
  if (!STATUSES.has(b.status)) why.push(`status is ${JSON.stringify(b.status)}`)
  if (b.status === 'error') str('error')
  if (typeof b.updatedAt !== 'string' || Number.isNaN(Date.parse(b.updatedAt))) why.push('updatedAt is not a time')
  if (!('data' in b)) why.push('data is missing')
  if (!Array.isArray(b.actions)) why.push('actions is not a list')
  else
    b.actions.forEach((a, i) => {
      if (!a || typeof a.id !== 'string' || !a.id || typeof a.label !== 'string' || !a.label) why.push(`action ${i} needs an id and a label`)
      else if ((a.target !== undefined && typeof a.target !== 'string') || (a.input !== undefined && a.input !== 'text')) why.push(`action ${i} (${a.id}) is malformed`)
    })
  return why
}

// A block as a display may show it: itself when it keeps the contract,
// otherwise an error card that says what is wrong with it.
export function safeBlock(b, { now } = {}) {
  const why = checkBlock(b)
  if (!why.length) return b
  const id = typeof b?.id === 'string' && b.id ? b.id : 'unknown'
  return blockData({ id, type: 'line', title: typeof b?.title === 'string' && b.title ? b.title : id, status: 'error', error: `this block is malformed: ${why.join('; ')}`, now })
}
