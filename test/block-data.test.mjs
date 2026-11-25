// The block contract: the shape every renderer reads, and what a block may
// offer as an action.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SCHEMA_VERSION, blockData, checkBlock, lineBlock, safeBlock, tasksBlock } from '../lib/block-data.mjs'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const task = (id, over = {}) => ({ id, title: id, description: '', status: 'todo', claim: null, notes: [], ...over })

test('a block carries the contract fields and nothing a renderer must guess', () => {
  const b = blockData({ id: 'x', type: 'line', title: 'X', data: { text: 'hi' }, now: NOW })
  assert.deepEqual(Object.keys(b).sort(), ['actions', 'data', 'id', 'schemaVersion', 'status', 'title', 'type', 'updatedAt'])
  assert.equal(b.schemaVersion, SCHEMA_VERSION)
  assert.equal(b.updatedAt, '2026-11-25T12:00:00.000Z')
})

test('a block is refused without an id, a type and a title, or with an unknown status', () => {
  assert.throws(() => blockData({ type: 'line', title: 'X' }))
  assert.throws(() => blockData({ id: 'x', type: 'line', title: 'X', status: 'fine' }))
})

test('an action keeps only its name, label, target and a text input', () => {
  const b = blockData({ id: 'x', type: 't', title: 'X', actions: [{ id: 'claim', label: 'Claim', target: 'T-1', cmd: 'rm -rf /', input: 'shell' }, { id: 'note', label: 'Note', input: 'text' }] })
  assert.deepEqual(b.actions, [{ id: 'claim', label: 'Claim', target: 'T-1' }, { id: 'note', label: 'Note', input: 'text' }])
})

test('tasks: release and note are offered only on what `me` holds', () => {
  const held = (owner) => task('T-1', { status: 'claimed', claim: { owner, since: 'x' } })
  assert.deepEqual(tasksBlock([held('human')], { me: 'human' }).actions.map(a => a.id), ['note', 'release'])
  assert.deepEqual(tasksBlock([held('codex 1')], { me: 'human' }).actions, [])
  assert.deepEqual(tasksBlock([held('human')]).actions, [])
})

test('tasks: open tasks listed, done counted, claim offered only where it can succeed', () => {
  const b = tasksBlock(
    [
      task('T-001'),
      task('T-002', { status: 'claimed', claim: { owner: 'codex 1', since: '2026-11-25T11:00:00Z' }, labels: ['kind=bug'] }),
      task('T-003', { waitingOn: ['T-001'] }),
      task('T-004', { status: 'done' }),
      task('T-005', { notes: [{ at: 'x', by: 'claude 1', text: 'handoff', where: { worktree: '/w' } }] }),
    ],
    { now: NOW },
  )
  assert.deepEqual(b.data.counts, { inProgress: 1, waiting: 3, done: 1 })
  assert.deepEqual(b.data.tasks.map(t => t.id), ['T-001', 'T-002', 'T-003', 'T-005'])
  assert.deepEqual(b.data.tasks[1], { id: 'T-002', title: 'T-002', status: 'claimed', kind: 'bug', owner: 'codex 1', since: '2026-11-25T11:00:00Z', waitingOn: [], handedOff: false })
  assert.equal(b.data.tasks[3].handedOff, true)
  assert.deepEqual(b.actions.map(a => a.target), ['T-001', 'T-005'])
})

test('a ready block line: ok and empty are ready, anything else is an error with its reason', () => {
  assert.equal(lineBlock({ id: 'branch', state: 'ok', text: 'main' }).status, 'ready')
  assert.equal(lineBlock({ id: 'ci', state: 'empty', text: 'no runs' }).status, 'ready')
  const bad = lineBlock({ id: 'ci', state: 'missing', text: 'gh is not installed' }, { title: 'CI' })
  assert.equal(bad.status, 'error')
  assert.equal(bad.error, 'gh is not installed')
  assert.equal(bad.title, 'CI')
})

// v1 is stable: every block a display shows keeps it, and one that doesn't
// becomes an error card that says why, so it can only break itself.
test('every block modBOARD makes keeps the v1 contract', () => {
  const t = { id: 'T-001', title: 'x', status: 'todo', notes: [], labels: ['kind=bug'] }
  for (const b of [tasksBlock([t], { me: 'human' }), lineBlock({ id: 'ci', state: 'ok', text: 'green' }), lineBlock({ id: 'ci', state: 'auth', text: 'sign in' })])
    assert.deepEqual(checkBlock(b), [], b.id)
})

test('a malformed block is named and shown as an error card, not passed on', () => {
  const good = lineBlock({ id: 'ci', state: 'ok', text: 'green' })
  const cases = [
    [null, /not an object/],
    [{ ...good, schemaVersion: 2 }, /schemaVersion is 2/],
    [{ ...good, status: 'weird' }, /status/],
    [{ ...good, status: 'error', error: undefined }, /error is not a string/],
    [{ ...good, updatedAt: 'later' }, /updatedAt/],
    [{ ...good, actions: [{ id: 'claim' }] }, /needs an id and a label/],
    [{ ...good, actions: [{ id: 'run', label: 'Run', input: 'command' }] }, /malformed/],
    [{ ...good, title: '' }, /title/],
  ]
  for (const [b, why] of cases) {
    assert.match(checkBlock(b).join('; '), why)
    const shown = safeBlock(b)
    assert.deepEqual(checkBlock(shown), [])
    assert.equal(shown.status, 'error')
    assert.match(shown.error, /malformed/)
    assert.deepEqual(shown.actions, [])
  }
  assert.equal(safeBlock(good), good)
})
