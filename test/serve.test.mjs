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
