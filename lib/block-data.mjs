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
export function actionsFor(t, me) {
  if (t.status === 'todo' && !(t.waitingOn ?? []).length) return [{ id: 'claim', label: 'Claim', target: t.id }]
  if (me && t.status === 'claimed' && t.claim?.owner === me)
    return [
      { id: 'note', label: 'Note', target: t.id, input: 'text' },
      { id: 'release', label: 'Release', target: t.id },
    ]
  return []
}

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
export function lineBlock({ id, state, text }, { title, now } = {}) {
  const fine = state === 'ok' || state === 'empty'
  return blockData({
    id,
    type: 'line',
    title: title ?? id,
    now,
    status: fine ? 'ready' : 'error',
    error: fine ? undefined : text,
    data: { text, state },
  })
}
