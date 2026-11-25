// board mcp: the board as an MCP server and MCP App. Read-only, and nothing
// a host or widget sends can choose what runs.

import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lineBlock, tasksBlock } from '../lib/block-data.mjs'
import { UI_MIME, UI_URI, blocksText, createMcp, runStdio } from '../lib/mcp.mjs'

const BLOCKS = [
  tasksBlock([{ id: 'T-001', title: 'Fix login', status: 'claimed', claim: { owner: 'codex 1', since: 'x' }, notes: [] }]),
  lineBlock({ id: 'branch', state: 'ok', text: 'main' }, { title: 'Branch' }),
  lineBlock({ id: 'ci', state: 'missing', text: 'gh is not installed' }, { title: 'CI' }),
]
const mcp = (read = async () => BLOCKS) => createMcp({ read, version: '0.0.0', html: () => '<!doctype html><p>board</p>' })
const call = (handle, method, params, id = 1) => handle({ jsonrpc: '2.0', id, method, params })

test('initialize names the server and offers tools, resources and the UI extension', async () => {
  const { result } = await call(mcp(), 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })
  assert.equal(result.protocolVersion, '2025-06-18')
  assert.equal(result.serverInfo.name, 'modboard')
  assert.ok(result.capabilities.tools && result.capabilities.resources)
  assert.ok(result.capabilities.extensions['io.modelcontextprotocol/ui'])
})

test('an unknown protocol version gets one the server speaks', async () => {
  const { result } = await call(mcp(), 'initialize', { protocolVersion: '1999-01-01' })
  assert.equal(result.protocolVersion, '2025-06-18')
})

test('one read-only tool, linked to the board UI, visible to model and app', async () => {
  const { result } = await call(mcp(), 'tools/list')
  assert.deepEqual(result.tools.map(t => t.name), ['board_view'])
  const [tool] = result.tools
  assert.equal(tool._meta.ui.resourceUri, UI_URI)
  assert.deepEqual(tool._meta.ui.visibility, ['model', 'app'])
  assert.equal(tool.annotations.readOnlyHint, true)
})

test('board_view returns text for the model and the blocks for the widget', async () => {
  const { result } = await call(mcp(), 'tools/call', { name: 'board_view', arguments: {} })
  assert.deepEqual(result.structuredContent.blocks, BLOCKS)
  assert.equal(result.content[0].text, 'Tasks: 1 in progress · 0 waiting · 0 done\n  ● T-001  Fix login  (codex 1)\nBranch: main\nCI: gh is not installed')
})

test('board_view refuses any argument, so nothing can be smuggled in', async () => {
  const { error } = await call(mcp(), 'tools/call', { name: 'board_view', arguments: { cmd: 'rm -rf ~' } })
  assert.equal(error.code, -32602)
})

test('there is no other tool to call', async () => {
  const { error } = await call(mcp(), 'tools/call', { name: 'board_run', arguments: {} })
  assert.equal(error.code, -32602)
})

test('a board that fails to read is a tool error, not a crash', async () => {
  const { result } = await call(mcp(async () => { throw new Error('store unreadable') }), 'tools/call', { name: 'board_view' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /store unreadable/)
})

test('the UI resource is served as an MCP App, and no other resource is', async () => {
  const { result } = await call(mcp(), 'resources/read', { uri: UI_URI })
  assert.equal(result.contents[0].mimeType, UI_MIME)
  assert.match(result.contents[0].text, /^<!doctype html>/)
  assert.equal((await call(mcp(), 'resources/read', { uri: 'file:///etc/passwd' })).error.code, -32602)
})

test('notifications get no answer; unknown methods and bad messages get errors', async () => {
  const handle = mcp()
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  assert.equal((await call(handle, 'sampling/createMessage')).error.code, -32601)
  assert.equal((await handle({ id: 9, method: 'ping' })).error.code, -32600)
})

test('the real page reads as an MCP App', async () => {
  const { result } = await call(createMcp({ read: async () => [], version: '0' }), 'resources/read', { uri: UI_URI })
  assert.match(result.contents[0].text, /ui\/initialize/)
})

test('stdio: one message per line, and every answer is written before it exits', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let out = ''
  output.on('data', c => (out += c))
  const slow = createMcp({ read: () => new Promise(r => setTimeout(() => r(BLOCKS), 50)), version: '0' })
  const done = runStdio(slow, { input, output })
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"board_view"}}\n')
  input.write('not json\n')
  input.end()
  await done
  const replies = out.trim().split('\n').map(l => JSON.parse(l))
  assert.equal(replies.find(r => r.id === null).error.code, -32700)
  assert.equal(replies.find(r => r.id === 1).result.structuredContent.blocks.length, 3)
})

test('blocksText draws an unknown block type as its data', () => {
  assert.equal(blocksText([{ type: 'chart', title: 'Chart', status: 'ready', data: { n: 3 } }]), 'Chart: {"n":3}')
})

test('stdio: a host that hangs up mid-reply ends the session, not the process', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  output.write = () => {
    queueMicrotask(() => output.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
    return false
  }
  const done = runStdio(mcp(), { input, output })
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n')
  await done
})
