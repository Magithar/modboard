// Approved command execution through a display (plan 2.6): `board mcp`, run
// as a host runs it. A display may run only the fixed, reviewed commands of
// the ready-made blocks the person turned on in their own settings, at most
// once per the block's interval, and nothing a host or widget sends changes
// which. Fake git and gh leave a marker each time they run.

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const BOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'board.mjs')
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exec-')))
const GIT = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()

function repo() {
  const root = tmp()
  const g = (...args) => execFileSync(GIT, args, { cwd: root, stdio: 'ignore' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@t')
  g('config', 'user.name', 't')
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
  g('add', '.')
  g('commit', '-qm', 'one')
  g('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  return root
}

// A program that writes its name to the marker each time it runs.
function fake(dir, name, marker, then = 'exit 0') {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\necho ${name} >> ${JSON.stringify(marker)}\n${then}\n`)
  fs.chmodSync(file, 0o755)
}
const ran = marker => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : [])

// A machine: the person's settings (blocks on), tools on PATH that leave a
// marker (git still works, through the real one), a project with a board.
function machine({ enabled = [] } = {}) {
  const root = repo()
  const marker = path.join(tmp(), 'ran')
  const tools = path.join(tmp(), 'tools')
  fake(tools, 'git', marker, `exec ${JSON.stringify(GIT)} "$@"`)
  fake(tools, 'gh', marker, 'exit 1')
  fs.symlinkSync(process.execPath, path.join(tools, 'node'))
  const settings = path.join(tmp(), 'settings.json')
  fs.writeFileSync(settings, JSON.stringify({ blocks: { enabled } }))
  const env = { ...process.env, PATH: tools, BOARD_SETTINGS_FILE: settings, BOARD_DIR: path.join(root, '.modboard'), BOARD_HOLDER_PS: '' }
  delete env.BOARD_AGENT
  execFileSync(process.execPath, [BOARD, 'add', 'free task'], { cwd: root, env, stdio: 'ignore' })
  return { root, marker, tools, env }
}

// Talk to `board mcp` as a host does: one JSON message per line, then hang up.
async function session({ root, env }, messages) {
  const child = spawn(process.execPath, [BOARD, 'mcp'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', c => (out += c))
  const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }
  for (const m of [init, ...messages]) child.stdin.write(JSON.stringify(m) + '\n')
  child.stdin.end()
  await new Promise(resolve => child.on('close', resolve))
  return Object.fromEntries(out.trim().split('\n').map(l => JSON.parse(l)).map(r => [r.id, r]))
}
const view = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'board_view', arguments: {} } })
const act = (id, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'board_act', arguments: args } })

test('with no block on, showing the board and pressing its buttons runs nothing', async () => {
  const m = machine()
  const r = await session(m, [
    view(1),
    act(2, { action: 'claim', target: 'T-001' }),
    act(3, { action: 'note', target: 'T-001', text: 'x' }),
    act(4, { action: 'release', target: 'T-001' }),
    view(5),
  ])
  assert.equal(r[2].result.content[0].text, 'claimed T-001 as human')
  assert.deepEqual(r[5].result.structuredContent.blocks.map(b => b.id), ['tasks'])
  assert.deepEqual(ran(m.marker), [])
})

test("a project can't turn a block on for a display", async () => {
  const m = machine()
  // What a cloned repo could carry: its own settings, config and env file.
  fs.mkdirSync(path.join(m.root, '.modboard'), { recursive: true })
  for (const f of ['settings.json', 'config.json'])
    fs.writeFileSync(path.join(m.root, '.modboard', f), JSON.stringify({ store: 'file', blocks: { enabled: ['branch', 'ci', 'prs'] } }))
  fs.writeFileSync(path.join(m.root, 'settings.json'), JSON.stringify({ blocks: { enabled: ['branch', 'ci'] } }))
  const r = await session(m, [view(1)])
  assert.deepEqual(r[1].result.structuredContent.blocks.map(b => b.id), ['tasks'])
  assert.deepEqual(ran(m.marker), [])
})

test('the blocks the person turned on run their own tools, and only those', async () => {
  const m = machine({ enabled: ['branch'] })
  const r = await session(m, [view(1)])
  const branch = r[1].result.structuredContent.blocks.find(b => b.id === 'branch')
  assert.equal(branch.data.text, 'main')
  assert.ok(ran(m.marker).length > 0)
  assert.ok(ran(m.marker).every(t => t === 'git'), `ran: ${ran(m.marker)}`)
})

test("a project's own git never runs for a display, even first on PATH", async () => {
  const m = machine({ enabled: ['branch', 'changes'] })
  const planted = path.join(tmp(), 'planted')
  fake(path.join(m.root, 'bin'), 'git', planted)
  fake(path.join(m.root, 'node_modules', '.bin'), 'git', planted)
  const env = { ...m.env, PATH: [path.join(m.root, 'bin'), path.join(m.root, 'node_modules', '.bin'), m.tools].join(':') }
  await session({ ...m, env }, [view(1)])
  assert.deepEqual(ran(planted), [])
})

test('many reads in a row run each block once per its interval', async () => {
  const m = machine({ enabled: ['branch'] })
  await session(m, [view(1)])
  const once = ran(m.marker).length
  fs.rmSync(m.marker)
  await session(m, [view(1), view(2), view(3), view(4), view(5)])
  assert.equal(ran(m.marker).length, once)
})

test('nothing a host sends picks a block or a command', async () => {
  const m = machine()
  const r = await session(m, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'board_view', arguments: { blocks: ['branch'] } } },
    act(2, { action: 'run', target: 'T-001' }),
    act(3, { action: 'claim', target: 'T-001', command: 'git status' }),
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'board_run', arguments: { id: 'branch' } } },
    { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'file:///usr/bin/git' } },
  ])
  assert.equal(r[1].error.code, -32602)
  assert.equal(r[2].result.isError, true)
  assert.equal(r[3].error.code, -32602)
  assert.equal(r[4].error.code, -32602)
  assert.equal(r[5].error.code, -32602)
  assert.deepEqual(ran(m.marker), [])
})

test("finding the board never runs a project's own git", async () => {
  const m = machine()
  const planted = path.join(tmp(), 'planted')
  fake(path.join(m.root, 'bin'), 'git', planted, `exec ${JSON.stringify(GIT)} "$@"`)
  const env = { ...m.env, PATH: [path.join(m.root, 'bin'), m.tools].join(':') }
  delete env.BOARD_DIR
  const r = await session({ ...m, env }, [view(1)])
  assert.ok(r[1].result.structuredContent.blocks[0].data.tasks.length >= 0)
  assert.deepEqual(ran(planted), [])
})
