// Every renderer draws every view (plan 2.7): the widget and the bench page
// (lib/web/board.html), and the text a model or a terminal gets
// (lib/mcp.mjs blocksText). And the widget and the bench are handed exactly
// the same blocks.

import fs from 'node:fs'
import http from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VIEW_TYPES, checkBlock, lineBlock, tasksBlock } from '../lib/block-data.mjs'
import { blocksText, createMcp } from '../lib/mcp.mjs'
import { createBench, listen } from '../lib/serve.mjs'
import { registry } from '../lib/ready-blocks.mjs'

const PAGE = fs.readFileSync(new URL('../lib/web/board.html', import.meta.url), 'utf8')

// The views the page defines: the method names inside `const VIEWS = { … }`.
const pageViews = () => {
  const body = PAGE.slice(PAGE.indexOf('const VIEWS = {'))
  const end = body.indexOf('\n}\n')
  return [...body.slice(0, end).matchAll(/^ {2}(\w+)\(block, body\)/gm)].map(m => m[1])
}

// One block of every view, the way modBOARD makes them.
const SAMPLES = {
  tasks: tasksBlock([{ id: 'T-001', title: 'Fix login', status: 'claimed', claim: { owner: 'codex 1', since: 'x' }, notes: [] }], { me: 'human' }),
  line: lineBlock({ id: 'branch', state: 'ok', text: 'main' }, { title: 'Branch' }),
}

test('every view has a sample here, and every sample keeps the contract', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...VIEW_TYPES].sort())
  for (const b of Object.values(SAMPLES)) assert.deepEqual(checkBlock(b), [], b.id)
})

test('the page draws every view, and no view the contract lacks', () => {
  assert.deepEqual(pageViews().sort(), [...VIEW_TYPES].sort())
})

test('the text renderer draws every view as words, not raw data', () => {
  for (const [type, b] of Object.entries(SAMPLES)) {
    const text = blocksText([b])
    assert.ok(text.length > 0, type)
    assert.doesNotMatch(text, /[{}]/, `${type} fell back to raw data: ${text}`)
  }
  assert.match(blocksText([{ ...SAMPLES.line, type: 'chart', data: { n: 1 } }]), /\{"n":1\}/)
})

test('every ready-made block names a view the renderers draw', () => {
  for (const def of registry()) assert.ok(VIEW_TYPES.includes(def.view), `${def.id}: ${def.view}`)
})

test('the widget and the bench are handed the same blocks', async t => {
  const blocks = Object.values(SAMPLES)
  const read = async () => blocks
  const handle = createMcp({ read, version: '0', html: () => '' })
  const viaMcp = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'board_view', arguments: {} } })).result.structuredContent.blocks

  const server = createBench(read)
  const url = await listen(server, 0)
  t.after(() => server.close())
  const viaBench = await new Promise((resolve, reject) =>
    http.get(`${url}blocks.json`, res => {
      let body = ''
      res.on('data', c => (body += c))
      res.on('end', () => resolve(JSON.parse(body).blocks))
    }).on('error', reject),
  )
  assert.deepEqual(viaMcp, viaBench)
  assert.deepEqual(viaMcp, JSON.parse(JSON.stringify(blocks)))
})
