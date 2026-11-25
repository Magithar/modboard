// board mcp: the board as a local MCP server over stdio, with the board as an
// MCP App (io.modelcontextprotocol/ui). A host that draws MCP Apps (the Codex
// and Claude desktop apps) shows lib/web/board.html with the blocks; one
// that doesn't (a terminal) gets the same blocks as text.
//
// Two tools. board_view (the model and the widget) shows the board and takes
// no input; the widget refreshes by calling it. board_act (the widget only)
// claims, notes or releases one task for the person, by name, checked by
// lib/board-actions.mjs and then the engine. Nothing the host or the widget
// sends can name a command, a path or a block to run.
//
// Hand-written JSON-RPC, no SDK: the server needs six methods. Everything is
// one JSON message per line on stdin and stdout; logs go to stderr only.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

import { TASK_ACTIONS, safeBlock } from './block-data.mjs'

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web', 'board.html')
export const UI_URI = 'ui://modboard/board.html'
export const UI_MIME = 'text/html;profile=mcp-app'
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

// The blocks as plain text, for the model and for hosts that can't draw.
export function blocksText(blocks) {
  return blocks
    .map(b => {
      if (b.status === 'error') return `${b.title}: ${b.error}`
      if (b.type === 'tasks') {
        const { counts, tasks } = b.data
        const head = `Tasks: ${counts.inProgress} in progress · ${counts.waiting} waiting · ${counts.done} done`
        const rows = tasks.map(t => `  ${t.status === 'claimed' ? '●' : '○'} ${t.id}  ${t.title}${t.owner ? `  (${t.owner})` : t.waitingOn.length ? `  (after ${t.waitingOn.join(', ')})` : ''}`)
        return [head, ...rows].join('\n')
      }
      // A clock or a timer runs in the page; as text, its line says what it is.
      if (['line', 'clock', 'timer'].includes(b.type)) return `${b.title}: ${b.data.text}`
      return `${b.title}: ${JSON.stringify(b.data)}`
    })
    .join('\n')
}

const TOOL = {
  name: 'board_view',
  title: 'modBOARD',
  description:
    "Show the modBOARD shared board: open tasks (who holds each), and the project blocks the user turned on (branch, changes, CI, pull requests, tests). Read-only. To claim or release tasks, use the `board` CLI.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: UI_URI, visibility: ['model', 'app'] }, 'ui/resourceUri': UI_URI },
}

// Only the widget calls this: hosts keep app-only tools from the model.
const ACT = {
  name: 'board_act',
  title: 'modBOARD action',
  description: "The board widget's buttons: claim, note on or release one task for the person using it. Only the widget calls this; agents use the board CLI.",
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: Object.keys(TASK_ACTIONS) },
      target: { type: 'string', pattern: '^T-\\d{1,6}$' },
      text: { type: 'string', maxLength: 500 },
    },
    required: ['action', 'target'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: UI_URI, visibility: ['app'] } },
}

// Whether a host draws MCP Apps, from the capabilities it sent with
// initialize: the io.modelcontextprotocol/ui extension, taking our page's
// MIME type when it names the types it takes.
export function drawsMcpApps(capabilities) {
  const ui = capabilities?.extensions?.['io.modelcontextprotocol/ui']
  if (!ui || typeof ui !== 'object') return false
  return !Array.isArray(ui.mimeTypes) || ui.mimeTypes.includes(UI_MIME)
}

const RESOURCE = { uri: UI_URI, name: 'modboard_board', title: 'modBOARD', description: 'The board, drawn', mimeType: UI_MIME }

class RpcError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// One JSON-RPC message in, its response out (null for a notification).
// read() → the blocks (lib/block-data.mjs), fresh on every call.
// act({ action, target, text }) → what it did; throws with the board's reason.
// Without act, the server is read-only and offers board_view alone.
export function createMcp({ read, act, version, html = () => fs.readFileSync(PAGE, 'utf8') }) {
  const view = async () => {
    const blocks = (await read()).map(b => safeBlock(b))
    return { content: [{ type: 'text', text: blocksText(blocks) }], structuredContent: { blocks } }
  }
  const tools = {
    board_view: async args => {
      const extra = Object.keys(args)
      if (extra.length) throw new RpcError(-32602, `board_view takes no arguments (got ${extra.join(', ')})`)
      try {
        return await view()
      } catch (err) {
        return { content: [{ type: 'text', text: `the board could not be read: ${err?.message ?? err}` }], isError: true }
      }
    },
    ...(act && {
      board_act: async args => {
        const extra = Object.keys(args).filter(k => !['action', 'target', 'text'].includes(k))
        if (extra.length) throw new RpcError(-32602, `board_act takes action, target and text (got ${extra.join(', ')})`)
        let did
        try {
          did = await act(args)
        } catch (err) {
          if (typeof err?.code !== 'number') throw err
          // The board said no: the widget shows why, and the board as it is.
          const now = await view().catch(() => null)
          return { content: [{ type: 'text', text: err.message }], ...(now ? { structuredContent: now.structuredContent } : {}), isError: true }
        }
        const now = await view()
        return { ...now, content: [{ type: 'text', text: did }] }
      },
    }),
  }
  // The buttons' tool is offered only to a host that said, when it
  // connected, that it draws MCP Apps: only its widget can press them. A host
  // that doesn't (a terminal, Antigravity) would hand the tool to the model,
  // which could then act for the person.
  let drawsApps = false
  const canAct = () => !!act && drawsApps
  const methods = {
    initialize: params => {
      drawsApps = drawsMcpApps(params?.capabilities)
      return {
        protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[1],
        capabilities: { tools: {}, resources: {}, extensions: { 'io.modelcontextprotocol/ui': {} } },
        serverInfo: { name: 'modboard', title: 'modBOARD', version },
        instructions: 'modBOARD is the shared task board for every agent and person on this project. Call board_view to show it.',
      }
    },
    ping: () => ({}),
    'tools/list': () => ({ tools: canAct() ? [TOOL, ACT] : [TOOL] }),
    'tools/call': async params => {
      const tool = Object.hasOwn(tools, params?.name) && (params.name !== 'board_act' || canAct()) && tools[params.name]
      if (!tool) throw new RpcError(-32602, `no tool "${params?.name}"`)
      const args = params.arguments ?? {}
      if (typeof args !== 'object' || Array.isArray(args)) throw new RpcError(-32602, 'arguments must be an object')
      return tool(args)
    },
    'resources/list': () => ({ resources: [RESOURCE] }),
    'resources/read': params => {
      if (params?.uri !== UI_URI) throw new RpcError(-32602, `no resource "${params?.uri}"`)
      return { contents: [{ uri: UI_URI, mimeType: UI_MIME, text: html(), _meta: { ui: { prefersBorder: true } } }] }
    },
  }

  return async function handle(msg) {
    const isRequest = msg && msg.id !== undefined && msg.id !== null
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return isRequest ? { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'invalid request' } } : null
    }
    if (!isRequest) return null // notifications (initialized, cancelled…) need no answer
    const method = Object.hasOwn(methods, msg.method) && methods[msg.method]
    if (!method) return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no method "${msg.method}"` } }
    try {
      return { jsonrpc: '2.0', id: msg.id, result: await method(msg.params) }
    } catch (err) {
      return { jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: String(err?.message ?? err) } }
    }
  }
}

// Serve one handler on stdin/stdout until stdin closes and every answer
// still being worked out has been written.
export function runStdio(handle, { input = process.stdin, output = process.stdout } = {}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  const pending = new Set()
  // A host that hangs up mid-reply (EPIPE) ends the session, not the process
  // with an uncaught error.
  let gone = false
  const write = reply => reply && !gone && output.write(JSON.stringify(reply) + '\n')
  return new Promise(resolve => {
    output.on('error', () => {
      gone = true
      lines.close()
    })
    lines.on('line', line => {
      if (!line.trim()) return
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      }
      const p = handle(msg).then(write)
      pending.add(p)
      p.finally(() => pending.delete(p))
    })
    lines.on('close', () => Promise.allSettled([...pending]).then(() => resolve()))
  })
}
