// What a display may ask the board to do for the person at it: claim, note,
// release, by name, on one task. Nothing else, and never a command.
//
// Every request is checked twice: here, that it is one the board would offer
// that person on that task right now (lib/block-data.mjs actionsFor), and
// then by the engine itself, whose ownership rules decide in the end.

import { BoardError } from './engine.mjs'
import { TASK_ACTIONS, actionsFor } from './block-data.mjs'

export const ACTION_IDS = Object.keys(TASK_ACTIONS)

// What each action does, once every check has passed; one per row of
// TASK_ACTIONS, or modBOARD refuses to start.
const RUN = {
  claim: (board, id, me, _, { leaseMs }) => board.claim(id, me, { leaseMs }),
  note: (board, id, me, text) => board.note(id, me, text),
  release: (board, id, me) => board.release(id, me),
}
const DID = { claim: 'claimed', note: 'noted on', release: 'released' }
const unrun = ACTION_IDS.filter(id => !RUN[id] || !DID[id])
if (unrun.length) throw new Error(`no run for the action(s) ${unrun.join(', ')}`)
const TASK_ID = /^T-\d{1,6}$/
const NOTE_MAX = 500
const REPEAT_MS = 10 * 60 * 1000

// The person's last note on the task says the same, within a few minutes.
function repeated(t, me, text) {
  const last = t.notes?.findLast(n => n.by === me)
  return !!last && last.text === text && Date.now() - Date.parse(last.at) < REPEAT_MS
}

// me: the name the person acts under. leaseMs: how long their claim lasts
// unasked; a person works in longer stretches than an agent's heartbeat.
export function boardActions(board, me, { leaseMs = 4 * 60 * 60 * 1000 } = {}) {
  if (!me) throw new Error('a display acts as someone')
  return async function act({ action, target, text } = {}) {
    if (typeof action !== 'string' || !Object.hasOwn(TASK_ACTIONS, action)) throw new BoardError(2, `no action "${action}"`)
    if (typeof target !== 'string' || !TASK_ID.test(target)) throw new BoardError(2, `"${target}" is not a task id`)
    if (TASK_ACTIONS[action].input === 'text') {
      if (typeof text !== 'string' || !text.trim()) throw new BoardError(2, `a ${action} needs some text`)
      if (text.length > NOTE_MAX) throw new BoardError(2, `a ${action} is at most ${NOTE_MAX} characters`)
    } else if (text !== undefined) throw new BoardError(2, `${action} takes no text`)

    const t = await board.show(target)
    // A host may deliver a call the widget already gave up on, and the person
    // may have asked again: the same claim or note twice is done once.
    if (action === 'claim' && t.status === 'claimed' && t.claim?.owner === me) return `${target} is already claimed by ${me}`
    if (!actionsFor(t, me).some(a => a.id === action))
      throw new BoardError(5, t.claim && t.claim.owner !== me ? `${t.id} is held by ${t.claim.owner}` : `can't ${action} ${t.id} now`)

    if (action === 'note' && repeated(t, me, text.trim())) return `already noted on ${target}`
    await RUN[action](board, target, me, text?.trim(), { leaseMs })
    return `${DID[action]} ${target} as ${me}`
  }
}
