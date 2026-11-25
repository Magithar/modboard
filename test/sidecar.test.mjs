// The board in Antigravity's side panel: the bridge its sidecar uses
// (lib/sidecar.mjs) and the installer (board antigravity). The bridge runs the
// real `board mcp`, so these go end to end.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { boardBridge, hasBoard, projectDir, sidecarPage } from '../lib/sidecar.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const BOARD = path.join(ROOT, 'bin', 'board.mjs')
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-')))
const run = (args, opts = {}) => execFileSync(process.execPath, [BOARD, ...args], { encoding: 'utf8', stdio: 'pipe', ...opts })

// A project folder with a board holding one free task, T-001.
function project() {
  const dir = tmp()
  const env = { ...process.env, BOARD_DIR: path.join(dir, '.modboard'), BOARD_SETTINGS_FILE: path.join(dir, 'settings.json') }
  delete env.BOARD_AGENT
  run(['add', 'free task'], { cwd: dir, env: { ...env, BOARD_AGENT: 'human' } })
  return { dir, uri: pathToFileURL(dir).href, env }
}

test('the page loads the host bridge before its own script', () => {
  const page = sidecarPage()
  const bridge = page.indexOf('<script src="/preload.js"></script>')
  assert.ok(bridge > 0)
  assert.ok(bridge < page.indexOf('<script type="module">'))
})

test('only a folder that exists, named by a file:// URI, is a project', () => {
  const dir = tmp()
  assert.equal(projectDir(pathToFileURL(dir).href), dir)
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'a')
  for (const bad of [undefined, '', dir, 'https://example.com/x', pathToFileURL(file).href, pathToFileURL(path.join(dir, 'nope')).href])
    assert.throws(() => projectDir(bad), { code: -32602 }, String(bad))
})

test('the panel shows the board and its buttons act, through board mcp', async t => {
  const p = project()
  // The bridge's board mcp reads this project's board.
  const prior = { BOARD_DIR: process.env.BOARD_DIR, BOARD_SETTINGS_FILE: process.env.BOARD_SETTINGS_FILE, BOARD_AGENT: process.env.BOARD_AGENT }
  Object.assign(process.env, { BOARD_DIR: p.env.BOARD_DIR, BOARD_SETTINGS_FILE: p.env.BOARD_SETTINGS_FILE })
  delete process.env.BOARD_AGENT
  const bridge = boardBridge({ bin: BOARD })
  t.after(() => {
    bridge.close()
    for (const [k, v] of Object.entries(prior)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  })

  const view = await bridge.call({ workspace: p.uri, name: 'board_view', arguments: {} })
  assert.deepEqual(view.structuredContent.blocks[0].data.tasks.map(t => t.id), ['T-001'])
  assert.deepEqual(view.structuredContent.blocks[0].actions.map(a => a.id), ['claim'])

  const claimed = await bridge.call({ workspace: p.uri, name: 'board_act', arguments: { action: 'claim', target: 'T-001' } })
  assert.equal(claimed.content[0].text, 'claimed T-001 as human')
  assert.match(run(['list'], { cwd: p.dir, env: p.env }), /T-001 {2}free task {2}human/)

  const refused = await bridge.call({ workspace: p.uri, name: 'board_act', arguments: { action: 'claim', target: '../../etc' } })
  assert.equal(refused.isError, true)
})

test('the panel passes only board_view and board_act, with object arguments', async t => {
  const bridge = boardBridge({ bin: BOARD })
  t.after(() => bridge.close())
  const uri = pathToFileURL(tmp()).href
  for (const name of ['board_run', 'toString', undefined])
    await assert.rejects(bridge.call({ workspace: uri, name, arguments: {} }), { code: -32602 })
  await assert.rejects(bridge.call({ workspace: uri, name: 'board_view', arguments: [] }), { code: -32602 })
  await assert.rejects(bridge.call({ workspace: 'https://evil.example/', name: 'board_view' }), { code: -32602 })
})

test('a folder has a board when it or its repo holds one', () => {
  const p = project()
  assert.equal(hasBoard(p.dir), true)
  const inside = path.join(p.dir, 'src', 'deep')
  fs.mkdirSync(inside, { recursive: true })
  assert.equal(hasBoard(inside), true)
  const repo = tmp()
  execFileSync('git', ['init', '-q'], { cwd: repo })
  fs.mkdirSync(path.join(repo, 'pkg'))
  assert.equal(hasBoard(path.join(repo, 'pkg')), false)
  fs.mkdirSync(path.join(repo, '.modboard'))
  assert.equal(hasBoard(path.join(repo, 'pkg')), true)
  assert.equal(hasBoard(tmp()), false)
})

test("the panel shows the conversation's board, else the default one, and names it", async t => {
  const home = project()
  const other = project()
  const bare = tmp()
  const prior = { BOARD_DIR: process.env.BOARD_DIR, BOARD_SETTINGS_FILE: process.env.BOARD_SETTINGS_FILE }
  delete process.env.BOARD_DIR
  process.env.BOARD_SETTINGS_FILE = home.env.BOARD_SETTINGS_FILE
  // Each project's board is the .modboard inside it (no BOARD_DIR, not a repo).
  run(['add', 'only in other'], { cwd: other.dir, env: { ...other.env, BOARD_DIR: path.join(other.dir, '.modboard'), BOARD_AGENT: 'human' } })
  const bridge = boardBridge({ bin: BOARD, fallback: home.dir })
  t.after(() => {
    bridge.close()
    for (const [k, v] of Object.entries(prior)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  })
  const titles = r => r.structuredContent.blocks[0].data.tasks.map(t => t.title)

  const own = await bridge.call({ workspace: other.uri, name: 'board_view' })
  assert.equal(own._meta.project, path.basename(other.dir))
  assert.deepEqual(titles(own), ['free task', 'only in other'])

  for (const workspace of [null, undefined, pathToFileURL(bare).href]) {
    const r = await bridge.call({ workspace, name: 'board_view' })
    assert.equal(r._meta.project, path.basename(home.dir), String(workspace))
    assert.deepEqual(titles(r), ['free task'])
  }
  assert.deepEqual(fs.readdirSync(bare), [], 'showing a fallback board writes nothing in the folder')
})

test('with no default board, a panel outside any project says so', async t => {
  const bridge = boardBridge({ bin: BOARD })
  t.after(() => bridge.close())
  await assert.rejects(bridge.call({ workspace: null, name: 'board_view' }), { code: 'no-project' })
})

test('board antigravity installs the panel, names this install, and updates it', () => {
  const plugins = tmp()
  const env = { ...process.env, BOARD_ANTIGRAVITY_PLUGINS: plugins }
  assert.match(run(['antigravity'], { env, cwd: ROOT }), /installed the modBOARD panel/)
  const dir = path.join(plugins, 'modboard')
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'sidecars', 'board', 'sidecar.json'), 'utf8'))
  assert.equal(sidecar.env.MODBOARD_HOME, fs.realpathSync(ROOT))
  assert.equal(sidecar.env.MODBOARD_DEFAULT_DIR, fs.realpathSync(ROOT))
  assert.equal(sidecar.ui_config.views[0].entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE')
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'logo.svg')))
  const elsewhere = tmp()
  assert.match(run(['antigravity', '--dir', elsewhere], { env }), /updated the modBOARD panel/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'sidecars', 'board', 'sidecar.json'), 'utf8')).env.MODBOARD_DEFAULT_DIR, elsewhere)
  assert.throws(() => run(['antigravity', '--dir', path.join(elsewhere, 'nope')], { env }), /usage: board antigravity/)
})

test("board antigravity won't overwrite someone else's plugin", () => {
  const plugins = tmp()
  fs.mkdirSync(path.join(plugins, 'modboard'))
  fs.writeFileSync(path.join(plugins, 'modboard', 'plugin.json'), JSON.stringify({ name: 'modboard' }))
  assert.throws(() => run(['antigravity'], { env: { ...process.env, BOARD_ANTIGRAVITY_PLUGINS: plugins } }), /holds another plugin/)
  assert.ok(fs.existsSync(path.join(plugins, 'modboard', 'plugin.json')))
})
