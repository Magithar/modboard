// What a display's buttons may do: claim, note, release one task for the
// person, by name. The board's own rules decide; a request can't stretch them.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createEngine } from '../lib/engine.mjs'
import { boardActions } from '../lib/board-actions.mjs'
import { tasksBlock } from '../lib/block-data.mjs'
import { createMcp } from '../lib/mcp.mjs'
import { memoryStore } from '../examples/store-memory.mjs'

async function setup() {
  const board = createEngine(memoryStore())
  await board.add('human', { title: 'free' }) // T-001
  await board.add('human', { title: 'held' }) // T-002
  await board.add('human', { title: 'blocked', after: ['T-001'] }) // T-003
  await board.claim('T-002', 'codex 1')
  return { board, act: boardActions(board, 'human') }
}
const refused = async (promise, re) => assert.match(await promise.then(() => 'went through', e => e.message), re)

test('claim, note and release a free task as the person', async () => {
  const { board, act } = await setup()
  assert.equal(await act({ action: 'claim', target: 'T-001' }), 'claimed T-001 as human')
  assert.equal((await board.show('T-001')).claim.owner, 'human')
  await act({ action: 'note', target: 'T-001', text: '  looked at it  ' })
  assert.equal((await board.show('T-001')).notes.at(-1).text, 'looked at it')
  await act({ action: 'release', target: 'T-001' })
  assert.equal((await board.show('T-001')).status, 'todo')
})

test("a person's claim from a display lasts hours, not an agent's minutes", async () => {
  const { board, act } = await setup()
  await act({ action: 'claim', target: 'T-001' })
  const { claim } = await board.show('T-001')
  assert.ok(Date.parse(claim.expiresAt) - Date.now() > 3 * 60 * 60 * 1000)
})

test("another agent's task can't be claimed, noted or released", async () => {
  const { board, act } = await setup()
  for (const action of ['claim', 'release']) await refused(act({ action, target: 'T-002' }), /held by codex 1/)
  await refused(act({ action: 'note', target: 'T-002', text: 'hi' }), /held by codex 1/)
  assert.equal((await board.show('T-002')).claim.owner, 'codex 1')
})

test('a task waiting on another, or one already done, is not offered', async () => {
  const { board, act } = await setup()
  await refused(act({ action: 'claim', target: 'T-003' }), /can't claim T-003/)
  await board.claim('T-001', 'codex 2')
  await board.done('T-001', 'codex 2', 'tested')
  await refused(act({ action: 'claim', target: 'T-001' }), /can't claim T-001/)
})

test('only the three actions, on a task id, with text only for a note', async () => {
  const { act } = await setup()
  await refused(act({ action: 'done', target: 'T-001' }), /no action "done"/)
  await refused(act({ action: 'run', target: 'T-001' }), /no action/)
  await refused(act({ action: 'claim', target: '../../etc/passwd' }), /not a task id/)
  await refused(act({ action: 'claim', target: 'T-001; rm -rf ~' }), /not a task id/)
  await refused(act({ action: 'claim', target: 'T-001', text: 'x' }), /takes no text/)
  await refused(act({ action: 'note', target: 'T-001' }), /needs some text/)
  await refused(act({ action: 'note', target: 'T-001', text: 'x'.repeat(501) }), /at most 500/)
})

test('a note on a task the person does not hold is refused', async () => {
  const { act } = await setup()
  await refused(act({ action: 'note', target: 'T-001', text: 'hi' }), /can't note T-001/)
})

test('the board offers what the person may do, and nothing on other tasks', async () => {
  const { board, act } = await setup()
  await act({ action: 'claim', target: 'T-001' })
  const b = tasksBlock(await board.list({ all: true }), { me: 'human' })
  assert.deepEqual(b.actions.map(a => `${a.id} ${a.target}`), ['note T-001', 'release T-001'])
})

// Over MCP: board_act is app-only, and a refusal comes back as the board's
// reason with the board as it is, not as a protocol error.
test('mcp: board_act is for the widget only and refuses with the reason', async () => {
  const { board, act } = await setup()
  const read = async () => [tasksBlock(await board.list({ all: true }), { me: 'human' })]
  const handle = createMcp({ read, act, version: '0' })
  const call = (name, args) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

  const { result: list } = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const tool = list.tools.find(t => t.name === 'board_act')
  assert.deepEqual(tool._meta.ui.visibility, ['app'])

  const ok = (await call('board_act', { action: 'claim', target: 'T-001' })).result
  assert.equal(ok.content[0].text, 'claimed T-001 as human')
  assert.equal(ok.structuredContent.blocks[0].data.tasks.find(t => t.id === 'T-001').owner, 'human')

  const no = (await call('board_act', { action: 'claim', target: 'T-002' })).result
  assert.equal(no.isError, true)
  assert.match(no.content[0].text, /held by codex 1/)
  assert.ok(no.structuredContent.blocks)

  assert.equal((await call('board_act', { action: 'claim', target: 'T-001', as: 'codex 1' })).error.code, -32602)
  assert.equal((await call('board_act', [])).error.code, -32602)
})

test('mcp: without act the server is read-only and has no board_act', async () => {
  const handle = createMcp({ read: async () => [], version: '0' })
  const { result } = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.deepEqual(result.tools.map(t => t.name), ['board_view'])
  const res = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'board_act', arguments: { action: 'claim', target: 'T-001' } } })
  assert.equal(res.error.code, -32602)
  const proto = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'toString', arguments: {} } })
  assert.equal(proto.error.code, -32602)
})

// A host may deliver a call the widget gave up on, after the person asked
// again: the second copy does nothing.
test('the same claim or note twice is done once', async () => {
  const { board, act } = await setup()
  await act({ action: 'claim', target: 'T-001' })
  assert.equal(await act({ action: 'claim', target: 'T-001' }), 'T-001 is already claimed by human')
  await act({ action: 'note', target: 'T-001', text: 'looked at it' })
  assert.equal(await act({ action: 'note', target: 'T-001', text: ' looked at it ' }), 'already noted on T-001')
  await act({ action: 'note', target: 'T-001', text: 'and fixed it' })
  assert.deepEqual((await board.show('T-001')).notes.map(n => n.text), ['looked at it', 'and fixed it'])
  await refused(act({ action: 'note', target: 'T-002', text: 'hi' }), /held by codex 1/)
})

// One table (TASK_ACTIONS) drives the buttons, the checks and the schema.
test('the buttons, the checks and the tool schema all come from one table', async () => {
  const { TASK_ACTIONS } = await import('../lib/block-data.mjs')
  const { ACTION_IDS } = await import('../lib/board-actions.mjs')
  const { board, act } = await setup()
  const handle = createMcp({ read: async () => [], act, version: '0' })
  const { result } = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const schema = result.tools.find(t => t.name === 'board_act').inputSchema.properties.action.enum
  assert.deepEqual(schema, Object.keys(TASK_ACTIONS))
  assert.deepEqual(ACTION_IDS, Object.keys(TASK_ACTIONS))
  for (const bad of [['claim'], { toString: () => 'claim' }, 'toString', 'hasOwnProperty'])
    await refused(act({ action: bad, target: 'T-001' }), /no action/)
  assert.equal((await board.show('T-001')).status, 'todo')
})
