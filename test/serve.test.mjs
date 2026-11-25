// The localhost bench: this machine only, read-only, blocks in the contract
// shape.

import http from 'node:http'
import net from 'node:net'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tasksBlock } from '../lib/block-data.mjs'
import { createBench, listen } from '../lib/serve.mjs'

// A raw request, so the Host header is exactly what a test sends.
const ask = (url, { method = 'GET', host } = {}) =>
  new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers: { host: host ?? u.host } }, res => {
      let body = ''
      res.on('data', c => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })

async function bench(read = async () => [tasksBlock([])]) {
  const server = createBench(read)
  const url = await listen(server, 0)
  return { url, close: () => server.close() }
}

test('serves the blocks and the page', async t => {
  const b = await bench()
  t.after(b.close)
  const json = await ask(`${b.url}blocks.json`)
  assert.equal(json.status, 200)
  assert.equal(JSON.parse(json.body).blocks[0].type, 'tasks')
  const page = await ask(b.url)
  assert.equal(page.status, 200)
  assert.match(page.headers['content-security-policy'], /default-src 'none'/)
})

test('listens on 127.0.0.1 only', async t => {
  const b = await bench()
  t.after(b.close)
  assert.match(b.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
})

test('refuses a Host that is not this machine (DNS rebinding)', async t => {
  const b = await bench()
  t.after(b.close)
  const port = new URL(b.url).port
  assert.equal((await ask(`${b.url}blocks.json`, { host: `evil.example:${port}` })).status, 403)
  assert.equal((await ask(`${b.url}blocks.json`, { host: 'localhost:1' })).status, 403)
  assert.equal((await ask(`${b.url}blocks.json`, { host: `localhost:${port}` })).status, 200)
})

test('answers GET and nothing else', async t => {
  const b = await bench()
  t.after(b.close)
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await ask(`${b.url}blocks.json`, { method })).status, 405)
})

test('a board that fails to read says why, and the page keeps serving', async t => {
  const b = await bench(async () => {
    throw new Error('store unreadable')
  })
  t.after(b.close)
  const res = await ask(`${b.url}blocks.json`)
  assert.equal(res.status, 500)
  assert.equal(JSON.parse(res.body).error, 'store unreadable')
  assert.equal((await ask(b.url)).status, 200)
})

test('a request it cannot parse gets 400, and the bench keeps serving', async t => {
  const b = await bench()
  t.after(b.close)
  const { port } = new URL(b.url)
  const raw = await new Promise((resolve, reject) => {
    const s = net.connect(Number(port), '127.0.0.1', () => s.write(`GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`))
    let out = ''
    s.on('data', c => (out += c))
    s.on('end', () => resolve(out))
    s.on('error', reject)
  })
  assert.match(raw, /^HTTP\/1\.1 400/)
  assert.equal((await ask(`${b.url}blocks.json`)).status, 200)
})

// The dashboard's buttons: one POST, only with this run's token, from this
// page's origin, as small JSON, and then only what the board allows.
import { createEngine } from '../lib/engine.mjs'
import { boardActions } from '../lib/board-actions.mjs'
import { memoryStore } from '../examples/store-memory.mjs'

async function dashboard(t) {
  const board = createEngine(memoryStore())
  await board.add('human', { title: 'free' }) // T-001
  await board.add('human', { title: 'held' }) // T-002
  await board.claim('T-002', 'codex 1')
  const server = createBench(async () => [tasksBlock(await board.list({ all: true }), { me: 'human' })], { act: boardActions(board, 'human') })
  const url = await listen(server, 0)
  t.after(() => server.close())
  const page = (await ask(url)).body
  const token = /name="modboard-token" content="([0-9a-f]{48})"/.exec(page)?.[1]
  const post = (body, { headers = {}, host, method = 'POST' } = {}) =>
    new Promise((resolve, reject) => {
      const u = new URL(`${url}api/act`)
      const data = typeof body === 'string' ? body : JSON.stringify(body)
      const req = http.request(
        { host: u.hostname, port: u.port, path: u.pathname, method, headers: { host: host ?? u.host, 'content-type': 'application/json', 'x-modboard-token': token, ...headers } },
        res => {
          let out = ''
          res.on('data', c => (out += c))
          res.on('end', () => resolve({ status: res.statusCode, body: out }))
        },
      )
      req.on('error', reject)
      req.end(data)
    })
  return { board, url, token, post }
}

test("the dashboard's page carries a token, and its buttons act through it", async t => {
  const d = await dashboard(t)
  assert.ok(d.token)
  const claimed = await d.post({ action: 'claim', target: 'T-001' })
  assert.equal(claimed.status, 200)
  const body = JSON.parse(claimed.body)
  assert.equal(body.said, 'claimed T-001 as human')
  assert.equal(body.blocks[0].data.tasks.find(t => t.id === 'T-001').owner, 'human')
  assert.equal((await d.board.show('T-001')).claim.owner, 'human')

  const refused = await d.post({ action: 'claim', target: 'T-002' })
  assert.equal(refused.status, 409)
  assert.match(JSON.parse(refused.body).said, /held by codex 1/)
})

test('without the token, from another origin, as a form, too big or with extras: refused, board unchanged', async t => {
  const d = await dashboard(t)
  const before = JSON.stringify(await d.board.list({ all: true }))
  const claim = { action: 'claim', target: 'T-001' }
  const cases = [
    [claim, { headers: { 'x-modboard-token': undefined } }, 403],
    [claim, { headers: { 'x-modboard-token': 'f'.repeat(48) } }, 403],
    [claim, { headers: { 'x-modboard-token': 'short' } }, 403],
    [claim, { headers: { origin: 'https://evil.example' } }, 403],
    [claim, { headers: { origin: 'null' } }, 403],
    [claim, { host: 'evil.example:1' }, 403],
    ['action=claim&target=T-001', { headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 415],
    ['{"action":"claim","target":"T-001","text":"' + 'x'.repeat(5000) + '"}', {}, 413],
    ['not json', {}, 400],
    [[claim], {}, 400],
    [{ ...claim, as: 'codex 1' }, {}, 400],
    [claim, { method: 'GET' }, 405],
  ]
  for (const [body, opts, status] of cases) {
    if (opts.headers && 'x-modboard-token' in opts.headers && opts.headers['x-modboard-token'] === undefined) {
      const { 'x-modboard-token': _, ...rest } = opts.headers
      opts.headers = { ...rest, 'x-modboard-token': '' }
    }
    assert.equal((await d.post(body, opts)).status, status, JSON.stringify([typeof body === 'string' ? body.slice(0, 40) : body, opts]))
  }
  assert.equal(JSON.stringify(await d.board.list({ all: true })), before)
})

test('each run has its own token; a read-only dashboard has none and no buttons', async t => {
  const a = await dashboard(t)
  const b = await dashboard(t)
  assert.notEqual(a.token, b.token)
  assert.equal((await b.post({ action: 'claim', target: 'T-001' }, { headers: { 'x-modboard-token': a.token } })).status, 403)
  const ro = await bench()
  t.after(ro.close)
  assert.doesNotMatch((await ask(ro.url)).body, /<meta name="modboard-token"/)
  assert.equal((await ask(`${ro.url}api/act`, { method: 'POST' })).status, 405)
})
