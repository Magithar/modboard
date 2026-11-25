// The localhost dashboard (board serve): the board as a web page in your own
// browser, the same page Codex and Claude Desktop draw.
//
// Only this machine can reach it: it listens on 127.0.0.1, and a request
// whose Host isn't 127.0.0.1 or localhost on this port is refused, so a web
// page can't reach it through DNS rebinding. Reading is GET.
//
// Its buttons (claim, note, release, for the person) are one POST,
// /api/act, and only when all of these hold:
//   - it carries this run's token, which only the page this run served has
//     (another site can't read that page: there's no CORS, and the Host
//     check stops rebinding);
//   - it comes from this page's origin, as JSON, and is small;
//   - lib/board-actions.mjs and then the engine allow it.
// Without act (createBench(read)), the dashboard is read-only.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { safeBlock } from './block-data.mjs'

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web', 'board.html')
const MAX_BODY = 4096

const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// The page, carrying this run's token for its buttons.
const pageWith = token =>
  fs.readFileSync(PAGE, 'utf8').replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta name="modboard-token" content="${token}">`)

const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

// The request's body, at most MAX_BODY bytes; past that it is read to the
// end and dropped, so the answer (413) still reaches the page.
function body(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size <= MAX_BODY) chunks.push(c)
    })
    req.on('end', () => (size > MAX_BODY ? reject(Object.assign(new Error('too large'), { status: 413 })) : resolve(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', reject)
  })
}

// read() → the blocks to show (lib/block-data.mjs), read fresh each request.
// act({ action, target, text }) → what it did; throws with the board's reason.
export function createBench(read, { act } = {}) {
  const token = crypto.randomBytes(24).toString('hex')
  const blocks = async () => (await read()).map(b => safeBlock(b))

  // Whatever a request sets off, the bench answers it and keeps serving.
  const answer = async (req, res) => {
    const port = req.socket.localPort
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, 'text/plain', 'not from this machine')
    let url
    try {
      url = new URL(req.url, `http://${host}`)
    } catch {
      return send(res, 400, 'text/plain', 'bad request')
    }

    if (url.pathname === '/api/act' && act) {
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'POST only', { allow: 'POST' })
      const origin = req.headers.origin
      if (origin !== undefined && origin !== `http://${host}`) return send(res, 403, 'text/plain', 'not from this page')
      if (!same(req.headers['x-modboard-token'], token)) return send(res, 403, 'text/plain', 'not from this page')
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, 'text/plain', 'JSON only')
      let args
      try {
        args = JSON.parse(await body(req))
      } catch (err) {
        return send(res, err.status ?? 400, 'text/plain', err.status ? 'too large' : 'bad JSON')
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return send(res, 400, 'text/plain', 'bad request')
      const extra = Object.keys(args).filter(k => !['action', 'target', 'text'].includes(k))
      if (extra.length) return send(res, 400, 'text/plain', `takes action, target and text (got ${extra.join(', ')})`)
      try {
        const said = await act(args)
        return json(res, 200, { ok: true, said, blocks: await blocks() })
      } catch (err) {
        if (typeof err?.code !== 'number') throw err
        // The board said no: the page shows why, and the board as it is.
        return json(res, 409, { ok: false, said: err.message, blocks: await blocks().catch(() => undefined) })
      }
    }

    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'read-only', { allow: 'GET' })
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', act ? pageWith(token) : fs.readFileSync(PAGE), { 'content-security-policy': CSP })
    if (url.pathname === '/blocks.json') {
      try {
        return json(res, 200, { blocks: await blocks() })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
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
const json = (res, status, value) => send(res, status, 'application/json', JSON.stringify(value))

// Start listening on 127.0.0.1; resolves with the page's address.
export function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`))
  })
}
