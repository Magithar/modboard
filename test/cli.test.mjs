import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const BOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'board.mjs')

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'))
  const env = { ...process.env, BOARD_DIR: path.join(dir, '.modboard') }
  // Run from inside Codex or a named session, the tests would inherit its name.
  delete env.BOARD_AGENT
  delete env.CODEX_THREAD_ID
  const run = (args, extra = {}) => {
    try {
      return { code: 0, out: execFileSync('node', [BOARD, ...args], { env: { ...env, ...extra }, encoding: 'utf8', stdio: 'pipe' }) }
    } catch (err) {
      return { code: err.status, out: String(err.stderr) }
    }
  }
  const json = (args, extra) => JSON.parse(run([...args, '--json'], extra).out)
  return { env, run, json }
}

test('exactly one of twenty simultaneous claims wins', async () => {
  const b = fresh()
  b.run(['add', 'contested'])
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      new Promise(resolve => execFile('node', [BOARD, 'claim', 'T-001', '--as', `a${i}`], { env: b.env }, err => resolve(err ? err.code : 0))),
    ),
  )
  assert.equal(results.filter(code => code === 0).length, 1)
  assert.ok(results.filter(code => code !== 0).every(code => code === 6))
  assert.equal(b.json(['doctor']).ok, true)
})

test('only the owner can note, release or finish a task', () => {
  const b = fresh()
  b.run(['add', 'mine'])
  b.run(['claim', 'T-001', '--as', 'alice'])
  assert.equal(b.run(['note', 'T-001', 'hi', '--as', 'mallory']).code, 5)
  assert.equal(b.run(['release', 'T-001', '--as', 'mallory']).code, 5)
  assert.equal(b.run(['done', 'T-001', '--as', 'mallory', '--note', 'x']).code, 5)
  assert.equal(b.run(['done', 'T-001', '--as', 'alice', '--note', 'ran it']).code, 0)
})

test('a handoff written on release reaches the next agent', () => {
  const b = fresh()
  b.run(['add', 'two parts'])
  b.run(['claim', 'T-001', '--as', 'alice'])
  b.run(['release', 'T-001', '--as', 'alice', '--handoff', 'part 1 done, part 2 left'])
  b.run(['claim', 'T-001', '--as', 'bob'])
  const t = b.json(['show', 'T-001'])
  assert.equal(t.claim.owner, 'bob')
  assert.match(t.notes.at(-1).text, /^HANDOFF: part 1 done/)
})

test('an expired lease frees the task for every reader and is recorded', async () => {
  const b = fresh()
  b.run(['add', 'abandoned'])
  b.run(['claim', 'T-001', '--as', 'ghost'], { BOARD_LEASE_MS: '200' })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(b.json(['show', 'T-001']).status, 'todo')
  const state = JSON.parse(fs.readFileSync(path.join(b.env.BOARD_DIR, 'board.json'), 'utf8'))
  assert.equal(state.tasks['T-001'].status, 'todo')
  const ledger = fs.readFileSync(path.join(b.env.BOARD_DIR, 'ledger.jsonl'), 'utf8')
  assert.match(ledger, /"type":"expire"/)
  assert.equal(b.run(['claim', 'T-001', '--as', 'bob']).code, 0)
})

test('a registered session that goes silent loses its claims before the lease runs out', async () => {
  const b = fresh()
  // Wide margins: each CLI call is a new Node process, slower when suites run in parallel.
  const quick = { BOARD_PRESENCE_MS: '1500' }
  for (const title of ['crashed', 'alive', 'plain']) b.run(['add', title])
  b.run(['register', 'ghost', '--session', 's1'], quick)
  b.run(['register', 'alive', '--session', 's2'], quick)
  b.run(['claim', 'T-001', '--as', 'ghost'], quick)
  b.run(['claim', 'T-002', '--as', 'alive'], quick)
  // A plain CLI agent that never registered keeps its lease alone.
  b.run(['claim', 'T-003', '--as', 'codex'], quick)
  await new Promise(resolve => setTimeout(resolve, 1000))
  b.run(['register', 'alive', '--session', 's2'], quick)
  await new Promise(resolve => setTimeout(resolve, 1000))
  const tasks = b.json(['list'], quick)
  const by = id => tasks.find(t => t.id === id)
  assert.equal(by('T-001').status, 'todo')
  assert.match(by('T-001').notes.at(-1).text, /ghost stopped responding/)
  assert.equal(by('T-002').claim.owner, 'alive')
  assert.equal(by('T-003').claim.owner, 'codex')
})

test('a heartbeat keeps a lease alive', async () => {
  const b = fresh()
  b.run(['add', 'long'])
  b.run(['claim', 'T-001', '--as', 'alice'], { BOARD_LEASE_MS: '400' })
  await new Promise(resolve => setTimeout(resolve, 250))
  b.run(['heartbeat', '--as', 'alice'], { BOARD_LEASE_MS: '400' })
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(b.json(['show', 'T-001']).claim.owner, 'alice')
})

test('a lost claim is recorded in the ledger with who held the task', () => {
  const b = fresh()
  b.run(['add', 'contested'])
  b.run(['claim', 'T-001', '--as', 'alice'])
  assert.equal(b.run(['claim', 'T-001', '--as', 'bob']).code, 6)
  const events = fs.readFileSync(path.join(b.env.BOARD_DIR, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(
    { type: events.at(-1).type, actor: events.at(-1).actor, holder: events.at(-1).holder },
    { type: 'claim-rejected', actor: 'bob', holder: 'alice' },
  )
  assert.equal(b.json(['doctor']).ok, true)
})

test('done needs a note saying how the task was verified, against its acceptance', () => {
  const b = fresh()
  b.run(['add', 'greet', '--accept', './greet.sh prints hello'])
  assert.match(b.run(['show', 'T-001']).out, /Accept when: \.\/greet\.sh prints hello/)
  b.run(['claim', 'T-001', '--as', 'alice'])
  const refused = b.run(['done', 'T-001', '--as', 'alice'])
  assert.equal(refused.code, 2)
  assert.match(refused.out, /against: \.\/greet\.sh prints hello/)
  assert.equal(b.run(['done', 'T-001', '--as', 'alice', '--note', 'ran ./greet.sh, got hello']).code, 0)
  assert.equal(b.json(['show', 'T-001']).notes.at(-1).text, 'VERIFIED: ran ./greet.sh, got hello')
})

test('release-all frees every task an ending session holds, with a handoff', () => {
  const b = fresh()
  for (const title of ['one', 'two', 'three']) b.run(['add', title])
  b.run(['claim', 'T-001', '--as', 'alice'])
  b.run(['claim', 'T-002', '--as', 'alice'])
  b.run(['claim', 'T-003', '--as', 'bob'])
  assert.deepEqual(b.json(['release-all', '--as', 'alice']).released, ['T-001', 'T-002'])
  assert.equal(b.json(['show', 'T-001']).status, 'todo')
  assert.match(b.json(['show', 'T-002']).notes.at(-1).text, /^HANDOFF: alice ended without releasing/)
  assert.equal(b.json(['show', 'T-003']).claim.owner, 'bob')
  assert.equal(b.json(['doctor']).ok, true)
})

test('a new board goes in .modboard/; one made before the rename keeps working in .agent-board/', () => {
  const env = { ...process.env }
  delete env.BOARD_DIR
  const add = cwd => execFileSync('node', [BOARD, 'add', 'x', '--as', 'lead'], { cwd, env, stdio: 'pipe' })
  // Outside any git repo, the board sits in the folder the CLI runs in.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'))
  add(fresh)
  assert.ok(fs.existsSync(path.join(fresh, '.modboard', 'board.json')))
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'))
  fs.mkdirSync(path.join(old, '.agent-board'))
  add(old)
  assert.ok(fs.existsSync(path.join(old, '.agent-board', 'board.json')))
  assert.ok(!fs.existsSync(path.join(old, '.modboard')))
})

test('taskfile reads the project task.md without touching the board', () => {
  const b = fresh()
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'))
  const env = { BOARD_TASKFILE_DIR: project }
  assert.deepEqual(b.json(['taskfile'], env), { file: null, items: [] })
  fs.writeFileSync(
    path.join(project, 'TASK.md'),
    '# Sprint\n\nSome prose.\n\n- [ ] Write the parser\n- [x] Sketch the pane\n  - [ ] nested step\n- a note, not a task\n\n```\n- [ ] not an item\n```\n',
  )
  const read = b.json(['taskfile'], env)
  assert.equal(read.file, 'TASK.md')
  // Once a file checks things off, its plain bullets are notes and left out.
  assert.deepEqual(read.items, [
    { text: 'Write the parser', done: false, section: 'Sprint', depth: 0, priority: null },
    { text: 'Sketch the pane', done: true, section: 'Sprint', depth: 0, priority: null },
    { text: 'nested step', done: false, section: 'Sprint', depth: 1, priority: null },
  ])
  assert.match(b.run(['taskfile'], env).out, /^TASK\.md\n\[ \] Write the parser\n\[x\] Sketch the pane\n  \[ \] nested step\n$/)
  // Nothing was added to the board, and no board was made.
  assert.equal(fs.existsSync(b.env.BOARD_DIR), false)
})

test('taskfile reads priority from headings, items and tables, and looks in docs/', () => {
  const b = fresh()
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'))
  fs.mkdirSync(path.join(project, 'docs'))
  fs.writeFileSync(
    path.join(project, 'docs', 'TASKS.md'),
    [
      '## ✅ P0 — foundation COMPLETE',
      '- [ ] **Fix** the `ledger`',
      '- [ ] P2 Benchmarks, its own priority',
      '### Detail',
      '- [ ] still under P0',
      '## Sync (P1)',
      '- [ ] [Supabase](https://supabase.com) project',
      '- [ ] ~~Old plan~~ superseded',
      '## Later',
      '- [ ] no priority here',
      '',
      '| ID | Priority | Task | Status |',
      '| --- | --- | --- | --- |',
      '| A-1 | P0 | Table task | todo |',
      '| A-2 | P1 | Finished row | done |',
      '| A-3 | | No priority row | ✅ |',
    ].join('\n'),
  )
  const read = b.json(['taskfile'], { BOARD_TASKFILE_DIR: project })
  assert.equal(read.file, path.join('docs', 'TASKS.md'))
  assert.deepEqual(
    read.items.map(i => [i.text, i.done, i.priority, i.section]),
    [
      ['Fix the ledger', false, 0, 'P0 — foundation'],
      ['Benchmarks, its own priority', false, 2, 'P0 — foundation'],
      ['still under P0', false, 0, 'Detail'],
      ['Supabase project', false, 1, 'Sync (P1)'],
      ['Old plan superseded', true, 1, 'Sync (P1)'],
      ['no priority here', false, null, 'Later'],
      ['Table task', false, 0, 'Later'],
      ['Finished row', true, 1, 'Later'],
      ['No priority row', true, null, 'Later'],
    ],
  )
})

test('a Codex thread is named "codex 1" by when it joined, and keeps its name', () => {
  const b = fresh()
  b.run(['add', 'one'])
  b.run(['add', 'two'])
  assert.equal(b.run(['claim', 'T-001'], { CODEX_THREAD_ID: 'thread-a' }).code, 0)
  assert.equal(b.run(['claim', 'T-002'], { CODEX_THREAD_ID: 'thread-b' }).code, 0)
  assert.equal(b.json(['show', 'T-001']).claim.owner, 'codex 1')
  assert.equal(b.json(['show', 'T-002']).claim.owner, 'codex 2')
  assert.equal(b.run(['whoami'], { CODEX_THREAD_ID: 'thread-a' }).out.trim(), 'you are codex 1')
  // Codex sends no presence ping, so silence never ends its claim; only the lease does.
  assert.equal(b.json(['show', 'T-001'], { BOARD_PRESENCE_MS: '1' }).claim.owner, 'codex 1')
  // Outside Codex, with no name, it still asks who you are.
  assert.equal(b.run(['claim', 'T-001']).code, 2)
})

test('a flag the command does not take is refused, and nothing is saved', () => {
  const b = fresh()
  const r = b.run(['add', 'guessed', '--description', 'the details'])
  assert.equal(r.code, 2)
  assert.match(r.out, /board: add doesn't take --description; it takes --as, --json, --desc, --accept/)
  assert.deepEqual(b.json(['list', '--all']), [])
  // The flags every command takes still work everywhere, as the mod relies on.
  assert.equal(b.run(['add', 'right', '--desc', 'the details', '--as', 'alice']).code, 0)
  assert.equal(b.json(['show', 'T-001', '--as', 'alice']).description, 'the details')
})
