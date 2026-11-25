// The board in a host's own side panel (Antigravity's UI extensions), where
// the host doesn't draw MCP Apps. The panel's server (a "sidecar") uses this:
// it starts `board mcp --dir <project>` for the folder the conversation is in
// and passes the page's tool calls to it, so every check board mcp makes (the
// action table, the engine's rules, the contract) applies here unchanged.
//
// The page is lib/web/board.html, the same one Codex and Claude Desktop draw;
// in a sidecar it calls /api/call instead of speaking MCP over postMessage.
// Only board_view and board_act pass, and only for a folder that exists.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { UI_MIME } from './mcp.mjs'

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web', 'board.html')
const TOOLS = new Set(['board_view', 'board_act'])
const MAX_BOARDS = 8

// The board page, with the host's bridge script loaded before it.
export function sidecarPage({ html = fs.readFileSync(PAGE, 'utf8') } = {}) {
  return html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<script src="/preload.js"></script>')
}

const fail = (message, code) => Object.assign(new Error(message), { code })

// The project folder a workspace URI names: a file:// URI of a folder that
// exists, resolved to its real path.
export function projectDir(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) throw fail('no project folder: open a conversation in a folder', -32602)
  let dir
  try {
    dir = fs.realpathSync(fileURLToPath(uri))
  } catch {
    throw fail(`${uri} is not a folder on this machine`, -32602)
  }
  if (!fs.statSync(dir).isDirectory()) throw fail(`${dir} is not a folder`, -32602)
  return dir
}

// Whether a folder's project has a board: a .modboard (or older .agent-board)
// in the folder or above it, up to its git repo's root. A worktree's board is
// its main checkout's, as `board` itself finds it.
export function hasBoard(dir) {
  const here = d => ['.modboard', '.agent-board'].some(n => fs.existsSync(path.join(d, n)))
  for (let d = dir; ; d = path.dirname(d)) {
    if (here(d)) return true
    const git = path.join(d, '.git')
    if (fs.existsSync(git)) {
      if (fs.statSync(git).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, 'utf8'))
        const common = m && path.resolve(d, m[1].trim()).split(`${path.sep}.git${path.sep}worktrees${path.sep}`)[0]
        return !!common && common !== d && here(common)
      }
      return false
    }
    if (path.dirname(d) === d) return false
  }
}

// One `board mcp` per project folder, started on first use and kept, at most
// MAX_BOARDS at once (the oldest goes). bin: the path to bin/board.mjs.
// fallback: the project to show when the conversation's folder has no board
// (or there is no conversation), set when the panel was installed.
export function boardBridge({ bin, fallback, node = process.execPath, start = spawn } = {}) {
  const boards = new Map()

  function open(dir) {
    const have = boards.get(dir)
    if (have) return have
    if (boards.size >= MAX_BOARDS) {
      const [oldest] = boards.keys()
      boards.get(oldest).child.kill()
      boards.delete(oldest)
    }
    const child = start(node, [bin, 'mcp', '--dir', dir], { stdio: ['pipe', 'pipe', 'ignore'] })
    const waiting = new Map()
    let next = 1
    const request = (method, params) =>
      new Promise((resolve, reject) => {
        const id = next++
        waiting.set(id, { resolve, reject })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      const w = waiting.get(msg.id)
      if (!w) return
      waiting.delete(msg.id)
      msg.error ? w.reject(fail(msg.error.message, msg.error.code)) : w.resolve(msg.result)
    })
    const gone = () => {
      boards.delete(dir)
      for (const w of waiting.values()) w.reject(fail('the board stopped; try again', -32603))
      waiting.clear()
    }
    child.on('exit', gone)
    child.on('error', gone)
    // This panel draws the board, so it says so: board mcp offers the
    // buttons' tool only to a host that draws MCP Apps.
    const ready = request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [UI_MIME] } } },
      clientInfo: { name: 'modboard-sidecar', version: '1' },
    }).then(() => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'))
    const board = { child, request, ready }
    boards.set(dir, board)
    return board
  }

  return {
    // A tool call from the page, for the project its conversation is in.
    // The conversation's project when it has a board, else the fallback; the
    // result says which, in _meta.project, so the page can name it.
    async call({ workspace, name, arguments: args } = {}) {
      if (!TOOLS.has(name)) throw fail(`no tool "${name}"`, -32602)
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) throw fail('arguments must be an object', -32602)
      const own = workspace == null ? null : projectDir(workspace)
      const dir = own && hasBoard(own) ? own : fallback ? projectDir(pathToFileURL(fallback).href) : own
      if (!dir) throw fail('open a conversation in a project folder to see its board', 'no-project')
      const board = open(dir)
      await board.ready
      const result = await board.request('tools/call', { name, arguments: args ?? {} })
      return { ...result, _meta: { ...(result._meta ?? {}), project: path.basename(dir), projectDir: dir } }
    },
    close() {
      for (const b of boards.values()) b.child.kill()
      boards.clear()
    },
  }
}
