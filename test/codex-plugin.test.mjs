// The Codex plugin (integrations/codex) and the marketplace that lists it
// (.agents/plugins/marketplace.json): what Codex reads, and what must never
// drift from the package itself.
//
// Learned by installing it (Codex 0.172): a plugin's local server starts in
// the session's project folder, ${PLUGIN_ROOT} is not expanded, and a
// symlink in the plugin is not copied on install. So the server is the
// installed `board` CLI, and the skill is a real copy of skills/modboard.

import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.join(ROOT, 'integrations', 'codex')
const json = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'))
const manifest = () => json('integrations/codex/.codex-plugin/plugin.json')

// Every file under a folder, as relative paths with their contents.
const tree = dir =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort()
    .map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')])

test('the marketplace lists the plugin at a folder that exists', () => {
  const m = json('.agents/plugins/marketplace.json')
  assert.equal(m.name, 'modboard')
  const entry = m.plugins.find(p => p.name === 'modboard')
  assert.ok(entry.source.path.startsWith('./'))
  assert.ok(fs.statSync(path.join(ROOT, entry.source.path, '.codex-plugin', 'plugin.json')).isFile())
})

test("the plugin's name and version are the package's", () => {
  const pkg = json('package.json')
  assert.equal(manifest().name, pkg.name)
  assert.equal(manifest().version, pkg.version)
})

test('every path the manifest names starts with ./, stays inside and exists', () => {
  for (const key of ['skills', 'mcpServers']) {
    const p = manifest()[key]
    assert.ok(p.startsWith('./') && !p.includes('..'), `${key}: ${p}`)
    assert.ok(fs.existsSync(path.join(PLUGIN, p)), `${key}: ${p} is missing`)
  }
})

test('the server is the installed board CLI, started in the project', () => {
  const { mcpServers } = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.mcp.json'), 'utf8'))
  assert.deepEqual(Object.keys(mcpServers), ['modboard'])
  const s = mcpServers.modboard
  assert.equal(s.command, 'board')
  assert.deepEqual(s.args, ['mcp'])
  // A cwd would start it outside the project, on the wrong board.
  assert.equal(s.cwd, undefined)
  assert.doesNotMatch(JSON.stringify(s), /PLUGIN_ROOT|\.\.\//)
})

test('the skill in the plugin is an exact copy of skills/modboard, not a link', () => {
  const copy = path.join(PLUGIN, 'skills', 'modboard')
  assert.equal(fs.lstatSync(copy).isSymbolicLink(), false)
  assert.deepEqual(tree(copy), tree(path.join(ROOT, 'skills', 'modboard')), 'run: cp -R skills/modboard integrations/codex/skills/')
})

test('nothing in the plugin is a symlink (Codex drops them on install)', () => {
  for (const e of fs.readdirSync(PLUGIN, { recursive: true, withFileTypes: true }))
    assert.equal(e.isSymbolicLink(), false, path.join(e.parentPath, e.name))
})
