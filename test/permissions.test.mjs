// Permission enforcement, end to end (plan 1.6): a hostile widget or host
// talking to `board mcp` over JSON-RPC, and a hostile web page aiming at the
// localhost bench. Every refusal must leave the board exactly as it was.
//
// Unit-level refusals live beside their code (board-actions, mcp, serve);
// this suite drives the whole stack the way a real host does.

import fs from 'node:fs'
import http from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createEngine } from '../lib/engine.mjs'
import { boardActions } from '../lib/board-actions.mjs'
import { tasksBlock } from '../lib/block-data.mjs'
import { createMcp } from '../lib/mcp.mjs'
import { createBench, listen } from '../lib/serve.mjs'
import { memoryStore } from '../examples/store-memory.mjs'

async function setup() {
  const board = createEngine(memoryStore())
  await board.add('human', { title: 'free' }) // T-001
  await board.add('human', { title: 'held' }) // T-002
  await board.add('human', { title: 'blocked', after: ['T-001'] }) // T-003
  await board.claim('T-002', 'codex 1')
  const read = async () => [tasksBlock(await board.list({ all: true }), { me: 'human' })]
  const handle = createMcp({ read, act: boardActions(board, 'human'), version: '0', html: () => '<p>board</p>' })
  let id = 0
  const rpc = (method, params) => handle({ jsonrpc: '2.0', id: ++id, method, params })
  const snapshot = async () => JSON.stringify(await board.list({ all: true }))
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } })
  return { board, rpc, snapshot }
}

// A call that must not go through: either a protocol error, or a tool
// result marked isError. Either way, the board is unchanged.
async function refusedUnchanged({ rpc, snapshot }, params) {
  const before = await snapshot()
  const res = await rpc('tools/call', params)
  const refused = res.error !== undefined || res.result?.isError === true
  assert.ok(refused, `went through: ${JSON.stringify(params)}`)
  assert.equal(await snapshot(), before, `board changed after ${JSON.stringify(params)}`)
  return res
}

test("the widget can't act on someone else's task, a blocked one, or one it doesn't hold", async () => {
  const s = await setup()
  for (const args of [
    { action: 'claim', target: 'T-002' },
    { action: 'release', target: 'T-002' },
    { action: 'note', target: 'T-002', text: 'mine now' },
    { action: 'claim', target: 'T-003' },
    { action: 'release', target: 'T-001' },
    { action: 'note', target: 'T-001', text: 'not held' },
    { action: 'claim', target: 'T-999' },
  ])
    await refusedUnchanged(s, { name: 'board_act', arguments: args })
})

test('only named actions on a task id: no commands, paths, odd ids or odd types', async () => {
  const s = await setup()
  const bad = [
    { action: 'done', target: 'T-001' },
    { action: 'add', target: 'T-001' },
    { action: '__proto__', target: 'T-001' },
    { action: 'constructor', target: 'T-001' },
    { action: ['claim'], target: 'T-001' },
    { action: 'claim', target: '../../etc/passwd' },
    { action: 'claim', target: 'T-001; rm -rf ~' },
    { action: 'claim', target: '$(whoami)' },
    { action: 'claim', target: 'T-001\n' },
    { action: 'claim', target: 't-001' },
    { action: 'claim', target: 'T-1234567' },
    { action: 'claim', target: 'T-١' },
    { action: 'claim', target: 1 },
    { action: 'claim', target: { id: 'T-001' } },
    { action: 'claim' },
    { target: 'T-001' },
    { action: 'claim', target: 'T-001', text: 'x' },
    { action: 'note', target: 'T-001', text: { toString: 'x' } },
  ]
  for (const args of bad) await refusedUnchanged(s, { name: 'board_act', arguments: args })
})

test("a request can't name who acts, how long a claim lasts, or anything extra", async () => {
  const s = await setup()
  for (const extra of [{ as: 'codex 1' }, { actor: 'codex 1' }, { leaseMs: 1e12 }, { command: 'ls' }, { cwd: '/' }]) {
    const res = await refusedUnchanged(s, { name: 'board_act', arguments: { action: 'claim', target: 'T-001', ...extra } })
    assert.equal(res.error.code, -32602)
  }
})

test('a note over 500 characters, or only spaces, is refused', async () => {
  const s = await setup()
  await s.rpc('tools/call', { name: 'board_act', arguments: { action: 'claim', target: 'T-001' } })
  await refusedUnchanged(s, { name: 'board_act', arguments: { action: 'note', target: 'T-001', text: 'x'.repeat(501) } })
  await refusedUnchanged(s, { name: 'board_act', arguments: { action: 'note', target: 'T-001', text: '   ' } })
})

test('a note is kept as text, never run or read as markup', async () => {
  const s = await setup()
  const text = '<img src=x onerror=alert(1)> $(rm -rf ~) `id`'
  await s.rpc('tools/call', { name: 'board_act', arguments: { action: 'claim', target: 'T-001' } })
  const res = await s.rpc('tools/call', { name: 'board_act', arguments: { action: 'note', target: 'T-001', text } })
  assert.equal(res.result.isError, undefined)
  assert.equal((await s.board.show('T-001')).notes.at(-1).text, text)
  // The page sets text with textContent only.
  const page = fs.readFileSync(new URL('../lib/web/board.html', import.meta.url), 'utf8')
  assert.doesNotMatch(page, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/)
})

test('no tool, method or resource outside the list, inherited names included', async () => {
  const s = await setup()
  for (const name of ['board_run', 'toString', '__proto__', 'constructor', 'hasOwnProperty', ''])
    assert.equal((await refusedUnchanged(s, { name, arguments: {} })).error.code, -32602)
  await refusedUnchanged(s, { name: 'board_act', arguments: null }) // null → {} → no action
  for (const method of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf', 'tools/run'])
    assert.equal((await s.rpc(method, {})).error?.code, -32601, method)
  for (const uri of ['file:///etc/passwd', 'ui://modboard/../../etc/passwd', 'ui://other/board.html'])
    assert.equal((await s.rpc('resources/read', { uri })).error?.code, -32602, uri)
})

test('the model is offered board_view only; board_act is marked for the widget', async () => {
  const s = await setup()
  const { tools } = (await s.rpc('tools/list')).result
  const vis = Object.fromEntries(tools.map(t => [t.name, t._meta.ui.visibility]))
  assert.deepEqual(vis, { board_view: ['model', 'app'], board_act: ['app'] })
  assert.equal(tools.find(t => t.name === 'board_act').inputSchema.additionalProperties, false)
})

// The bench: a web page in the person's browser must not read it from
// another origin, nor change anything through it.
const ask = (url, { method = 'GET', host, origin } = {}) =>
  new Promise((resolve, reject) => {
    const u = new URL(url)
    const headers = { host: host ?? u.host, ...(origin ? { origin } : {}) }
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, res => {
      let body = ''
      res.on('data', c => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })

test('the bench: this machine only, read-only, nothing for other origins', async t => {
  const s = await setup()
  const server = createBench(async () => [tasksBlock(await s.board.list({ all: true }), { me: 'human' })])
  const url = await listen(server, 0)
  t.after(() => server.close())
  const port = new URL(url).port
  const before = await s.snapshot()

  for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `localhost`, `[::1]:${port}`])
    assert.equal((await ask(`${url}blocks.json`, { host })).status, 403, `host ${host}`)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
    for (const path of ['', 'blocks.json', 'act'])
      assert.equal((await ask(`${url}${path}`, { method })).status, 405, `${method} /${path}`)
  for (const path of ['../package.json', '%2e%2e/package.json', 'lib/serve.mjs', 'act?action=claim&target=T-001'])
    assert.equal((await ask(`${url}${path}`)).status, 404, path)

  const json = await ask(`${url}blocks.json`, { origin: 'https://evil.example' })
  assert.equal(json.status, 200) // same-machine Host; the browser still won't hand it over:
  assert.equal(json.headers['access-control-allow-origin'], undefined)
  assert.match((await ask(url)).headers['content-security-policy'], /frame-ancestors 'none'/)
  assert.equal(await s.snapshot(), before)
})
