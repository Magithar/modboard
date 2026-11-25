// The localhost bench: the board as a web page, for building and checking the
// shared renderer without any host (board serve). Read-only for now.
//
// Only this machine can reach it: it listens on 127.0.0.1, and a request
// whose Host isn't 127.0.0.1 or localhost on this port is refused, so a web
// page can't reach it through DNS rebinding. It answers GET and nothing else.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { safeBlock } from './block-data.mjs'

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web', 'board.html')

const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// read() → the blocks to show (lib/block-data.mjs), read fresh each request.
export function createBench(read) {
  // Whatever a request sets off, the bench answers it and keeps serving.
  const answer = async (req, res) => {
    const port = req.socket.localPort
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, 'text/plain', 'not from this machine')
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'read-only', { allow: 'GET' })
    let url
    try {
      url = new URL(req.url, `http://${host}`)
    } catch {
      return send(res, 400, 'text/plain', 'bad request')
    }
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(PAGE), { 'content-security-policy': CSP })
    if (url.pathname === '/blocks.json') {
      try {
        return send(res, 200, 'application/json', JSON.stringify({ blocks: (await read()).map(b => safeBlock(b)) }))
      } catch (err) {
        return send(res, 500, 'application/json', JSON.stringify({ error: String(err?.message ?? err) }))
      }
    }
    return send(res, 404, 'text/plain', 'not found')
  }
  return http.createServer((req, res) =>
    answer(req, res).catch(err => (res.headersSent ? res.destroy() : send(res, 500, 'text/plain', String(err?.message ?? err)))),
  )
}

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'content-type': type, ...HEADERS, ...extra })
  res.end(body)
}

// Start listening on 127.0.0.1; resolves with the page's address.
export function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`))
  })
}
