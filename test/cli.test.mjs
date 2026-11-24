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
  const run = (args, extra = {}, cwd = dir) => {
    try {
      return { code: 0, out: execFileSync('node', [BOARD, ...args], { env: { ...env, ...extra }, cwd, encoding: 'utf8', stdio: 'pipe' }) }
    } catch (err) {
      return { code: err.status, out: String(err.stderr) }
    }
  }
  const json = (args, extra, cwd) => JSON.parse(run([...args, '--json'], extra, cwd).out)
  return { dir, env, run, json }
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
  // A plain CLI agent that never registered keeps its claim while its process lives.
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

// A fake CLI agent: its own process runs board commands, without a shell, and
// stays alive until it is killed.
function agent(b, calls, extra = {}) {
  const code = `
    const { execFileSync } = require('node:child_process')
    for (const args of ${JSON.stringify(calls)}) execFileSync('node', [${JSON.stringify(BOARD)}, ...args], { stdio: 'ignore' })
    console.log('ready')
    setInterval(() => {}, 1000)`
  const child = execFile('node', ['-e', code], { env: { ...b.env, BOARD_HOLDER_AGE_MS: '0', ...extra }, cwd: b.dir })
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', d => String(d).includes('ready') && resolve())
    child.on('exit', code => reject(new Error(`agent exited (${code}) before it was ready`)))
  })
  const kill = () => new Promise(resolve => (child.on('exit', resolve), child.kill('SIGKILL')))
  return { ready, kill }
}

test('a CLI agent whose process ends frees its claims at once, not at the end of its lease', async () => {
  const b = fresh()
  for (const title of ['worked', 'untouched', 'codex']) b.run(['add', title])
  const plain = agent(b, [['claim', 'T-001', '--as', 'shell'], ['note', 'T-001', 'form done', '--as', 'shell'], ['claim', 'T-002', '--as', 'shell']])
  const codex = agent(b, [['claim', 'T-003']], { CODEX_THREAD_ID: 'thread-a' })
  await Promise.all([plain.ready, codex.ready])
  // Alive, they keep their claims.
  assert.deepEqual(b.json(['list']).map(t => t.claim?.owner), ['shell', 'shell', 'codex 1'])
  await Promise.all([plain.kill(), codex.kill()])
  const tasks = b.json(['list'])
  assert.deepEqual(tasks.map(t => t.status), ['todo', 'todo', 'todo'])
  // Work recorded before it died comes back as a handoff, like a silent session's.
  assert.match(tasks[0].notes.at(-1).text, /^HANDOFF: shell stopped responding \(its process, node, exited\); read the notes above/)
  assert.match(tasks[1].notes.at(-1).text, /^shell stopped responding/)
  assert.ok(b.json(['events']).some(e => e.type === 'expire' && e.task === 'T-003' && e.reason === 'exited'))
  assert.equal(b.json(['doctor']).ok, true)
})

test('a claim whose holder is unsure, or that has a presence ping, is not freed by a process ending', async () => {
  const b = fresh()
  for (const title of ['two trees', 'registered']) b.run(['add', title])
  // Calls under one name from two processes: what they share is the parent, which lives on.
  const first = agent(b, [['claim', 'T-001', '--as', 'pair']])
  await first.ready
  const second = agent(b, [['note', 'T-001', 'more', '--as', 'pair']])
  await second.ready
  // A Claude session's own presence ping, not its process, says when it is gone.
  b.run(['register', 'claude 1', '--session', 's1'])
  const claude = agent(b, [['claim', 'T-002', '--as', 'claude 1']])
  await claude.ready
  await Promise.all([first.kill(), second.kill(), claude.kill()])
  assert.deepEqual(b.json(['list']).map(t => t.claim?.owner), ['pair', 'claude 1'])
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
  assert.match(r.out, /board: add doesn't take --description; it takes --as, --json, --desc, --accept, --ring/)
  assert.deepEqual(b.json(['list', '--all']), [])
  // The flags every command takes still work everywhere, as the mod relies on.
  assert.equal(b.run(['add', 'right', '--desc', 'the details', '--as', 'alice']).code, 0)
  assert.equal(b.json(['show', 'T-001', '--as', 'alice']).description, 'the details')
})

// A git checkout on its own branch, with one commit, as an agent's worktree is.
function checkout(b) {
  const wt = path.join(b.dir, 'wt-login')
  fs.mkdirSync(wt)
  const git = (...args) => execFileSync('git', args, { cwd: wt, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q', '-b', 'login')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'start')
  return { wt: fs.realpathSync(wt), commit: git('rev-parse', '--short', 'HEAD') }
}

test('a handoff records the worktree, branch and commit the work is in', () => {
  const b = fresh()
  const { wt, commit } = checkout(b)
  b.run(['add', 'login form'])
  b.run(['claim', 'T-001', '--as', 'alice'])
  fs.writeFileSync(path.join(wt, 'form.tsx'), '')
  const said = b.run(['release', 'T-001', '--as', 'alice', '--handoff', 'form done; api left'], {}, wt)
  assert.match(said.out, new RegExp(`the work is in ${wt} · login @ ${commit}, uncommitted changes`))
  assert.deepEqual(b.json(['show', 'T-001']).notes.at(-1).where, { worktree: wt, branch: 'login', commit, dirty: true, files: ['form.tsx'] })
  // Outside a git repo there is nowhere to record.
  b.run(['claim', 'T-001', '--as', 'bob'])
  b.run(['release', 'T-001', '--as', 'bob', '--handoff', 'nothing'])
  assert.equal(b.json(['show', 'T-001']).notes.at(-1).where, undefined)
})

test('check runs the command and records it only when it passes, with where it ran', () => {
  const b = fresh()
  const { wt, commit } = checkout(b)
  b.run(['add', 'login form'])
  b.run(['claim', 'T-001', '--as', 'alice'])
  const failed = b.run(['check', 'T-001', 'exit 3', '--as', 'alice'], {}, wt)
  assert.equal(failed.code, 8)
  assert.match(failed.out, /check failed: exit 3 exited 3; nothing recorded/)
  assert.equal(b.json(['show', 'T-001']).notes.length, 0)
  // Its output goes to stderr; stdout stays the board's JSON.
  const passed = b.json(['check', 'T-001', 'echo running; test -d .git', '--as', 'alice'], {}, wt)
  assert.deepEqual(passed.notes.at(-1).check, { cmd: 'echo running; test -d .git', ran: true })
  assert.deepEqual(passed.notes.at(-1).where, { worktree: wt, branch: 'login', commit, dirty: false, files: [] })
  // --passed records a check the agent ran itself, without running it.
  const reported = b.json(['check', 'T-001', 'exit 1', '--passed', '--as', 'alice'], {}, wt)
  assert.deepEqual(reported.notes.at(-1).check, { cmd: 'exit 1', ran: false })
  // Only the holder can record a check, and nothing is run for anyone else.
  const marker = path.join(b.dir, 'ran')
  assert.equal(b.run(['check', 'T-001', `touch ${marker}`, '--as', 'mallory'], {}, wt).code, 5)
  assert.equal(fs.existsSync(marker), false)
  assert.match(b.run(['show', 'T-001']).out, /CHECKED: echo running; test -d \.git \(run by the board, passed\)\n {4}in .* · login @ /)
  assert.equal(b.json(['doctor']).ok, true)
})

test('release-all records where the ending session worked', () => {
  const b = fresh()
  const { wt } = checkout(b)
  b.run(['add', 'one'])
  b.run(['claim', 'T-001', '--as', 'alice'])
  b.run(['release-all', '--as', 'alice'], {}, wt)
  assert.equal(b.json(['show', 'T-001']).notes.at(-1).where.branch, 'login')
})

test('a session that went away after doing work leaves a handoff, with where it was last seen, marked stale', async () => {
  const b = fresh()
  const { wt, commit } = checkout(b)
  const quick = { BOARD_PRESENCE_MS: '1500' }
  for (const title of ['worked on', 'only claimed']) b.run(['add', title])
  b.run(['register', 'ghost', '--session', 's1'], quick)
  b.run(['claim', 'T-001', '--as', 'ghost'], quick)
  b.run(['claim', 'T-002', '--as', 'ghost'], quick)
  b.run(['check', 'T-001', 'true', '--as', 'ghost'], quick, wt)
  await new Promise(resolve => setTimeout(resolve, 2000))
  const t1 = b.json(['show', 'T-001'], quick)
  assert.equal(t1.status, 'todo')
  const left = t1.notes.at(-1)
  assert.equal(left.by, 'board')
  assert.match(left.text, /^HANDOFF: ghost stopped responding \(its session went silent\); read the notes above$/)
  assert.deepEqual(left.where, { worktree: wt, branch: 'login', commit, dirty: false, files: [], stale: true })
  assert.match(b.run(['show', 'T-001'], quick).out, /login @ .*\(last known, may be stale\)/)
  // Claimed and gone with nothing recorded: back to not started, no handoff.
  assert.doesNotMatch(b.json(['show', 'T-002'], quick).notes.at(-1).text, /^HANDOFF/)
})

test('a lease that runs out after work leaves a handoff too', async () => {
  const b = fresh()
  b.run(['add', 'long job'])
  b.run(['claim', 'T-001', '--as', 'codex'], { BOARD_LEASE_MS: '300' })
  b.run(['note', 'T-001', 'half done', '--as', 'codex'], { BOARD_LEASE_MS: '300' })
  await new Promise(resolve => setTimeout(resolve, 500))
  const left = b.json(['show', 'T-001']).notes.at(-1)
  assert.equal(left.text, 'HANDOFF: lease of codex expired; read the notes above')
  assert.equal(left.where, undefined)
})

test('a task flagged to ring says so, and the flag can be set and taken off later', () => {
  const b = fresh()
  assert.match(b.run(['add', 'ship it', '--ring', '--as', 'lead']).out, /rings an alarm when done/)
  assert.equal(b.json(['show', 'T-001']).ring, true)
  assert.match(b.run(['show', 'T-001']).out, /Rings an alarm when done\./)
  b.run(['add', 'plain', '--as', 'lead'])
  assert.equal(b.json(['show', 'T-002']).ring, undefined)
  assert.match(b.run(['ring', 'T-002', '--as', 'lead']).out, /T-002 rings an alarm when done/)
  assert.equal(b.json(['show', 'T-002']).ring, true)
  assert.match(b.run(['ring', 'T-002', '--off', '--as', 'lead']).out, /no longer rings/)
  assert.equal(b.json(['show', 'T-002']).ring, undefined)
  assert.equal(b.run(['ring', 'T-404', '--as', 'lead']).code !== 0, true)
})

// A repo on main with two files, and a worktree on its own branch, as an
// agent's is: the branch commits one change and leaves another uncommitted.
function worktree(b) {
  const main = path.join(b.dir, 'app')
  fs.mkdirSync(path.join(main, 'src'), { recursive: true })
  fs.mkdirSync(path.join(main, 'api'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim()
  git(main, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(main, 'src', 'login.tsx'), 'a')
  fs.writeFileSync(path.join(main, 'api', 'auth.ts'), 'b')
  fs.writeFileSync(path.join(main, 'README.md'), 'c')
  git(main, 'add', '.')
  git(main, 'commit', '-q', '-m', 'start')
  const wt = path.join(b.dir, 'app-login')
  git(main, 'worktree', 'add', '-q', '-b', 'login', wt)
  fs.appendFileSync(path.join(wt, 'src', 'login.tsx'), 'x')
  git(wt, 'commit', '-qam', 'form')
  fs.appendFileSync(path.join(wt, 'api', 'auth.ts'), 'y')
  return fs.realpathSync(wt)
}

test('a handoff records the files the work changed, committed or not, and board who finds who changed a file', () => {
  const b = fresh()
  const wt = worktree(b)
  b.run(['add', 'login page'])
  b.run(['add', 'docs'])
  b.run(['claim', 'T-001', '--as', 'claude 2'])
  b.run(['release', 'T-001', '--as', 'claude 2', '--handoff', 'form done; api left'], {}, wt)
  // The branch's commit and the uncommitted change; not README.md, which nobody touched.
  assert.deepEqual(b.json(['show', 'T-001']).notes.at(-1).where.files, ['api/auth.ts', 'src/login.tsx'])
  assert.match(b.run(['show', 'T-001']).out, /files: api\/auth\.ts, src\/login\.tsx/)
  const who = b.json(['who', 'src/login.tsx'], {}, wt)
  assert.equal(who.hits.length, 1)
  assert.deepEqual([who.hits[0].task, who.hits[0].by, who.hits[0].kind], ['T-001', 'claude 2', 'handoff'])
  // Asked from inside src/, the path is taken from there.
  assert.equal(b.json(['who', 'login.tsx'], {}, path.join(wt, 'src')).hits[0].task, 'T-001')
  assert.match(b.run(['who', 'README.md'], {}, wt).out, /no handoff or check recorded a change to README\.md/)
  assert.equal(b.run(['who']).code, 2)
})

test('a task that waits on another can be claimed only once that one is done', () => {
  const b = fresh()
  b.run(['add', 'fix'])
  b.run(['add', 'ship', '--after', 'T-001'])
  assert.match(b.run(['list']).out, /T-002 {2}ship {2}waits on T-001/)
  assert.deepEqual(b.json(['show', 'T-002']).waitingOn, ['T-001'])
  assert.equal(b.run(['claim', 'T-002', '--as', 'alice']).code, 9)
  b.run(['claim', 'T-001', '--as', 'alice'])
  b.run(['done', 'T-001', '--as', 'alice', '--note', 'ran it'])
  assert.equal(b.json(['show', 'T-002']).waitingOn, undefined)
  assert.equal(b.run(['claim', 'T-002', '--as', 'alice']).code, 0)
  // Waiting on a task that doesn't exist is refused when it's added.
  assert.equal(b.run(['add', 'orphan', '--after', 'T-099']).code, 4)
})

test('claim --next picks and claims the first ready task, and racers never get the same one', async () => {
  const b = fresh()
  for (const t of ['one', 'two', 'three']) b.run(['add', t])
  b.run(['add', 'later', '--after', 'T-001'])
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      new Promise(resolve =>
        execFile('node', [BOARD, 'claim', '--next', '--json', '--as', `a${i}`], { env: b.env }, (err, out) => resolve(err ? err.code : JSON.parse(out).id)),
      ),
    ),
  )
  const won = results.filter(r => typeof r === 'string')
  assert.deepEqual([...won].sort(), ['T-001', 'T-002', 'T-003'])
  assert.deepEqual(results.filter(r => typeof r !== 'string'), [10, 10])
  assert.equal(b.json(['doctor']).ok, true)
})

test('labels filter list and claim --next', () => {
  const b = fresh()
  b.run(['add', 'docs', '--label', 'kind=docs'])
  b.run(['add', 'bug', '--label', 'kind=bug', '--label', 'area=api'])
  assert.match(b.run(['list']).out, /bug {2}\[kind=bug area=api\]/)
  assert.deepEqual(b.json(['list', '--label', 'kind=bug']).map(t => t.id), ['T-002'])
  assert.equal(b.json(['claim', '--next', '--label', 'kind=bug,area=api', '--as', 'alice']).id, 'T-002')
  assert.equal(b.run(['claim', '--next', '--label', 'kind=bug', '--as', 'bob']).code, 10)
  assert.deepEqual(b.json(['list', '--ready']).map(t => t.id), ['T-001'])
})

test('claim --next --wait takes a task that comes ready while it waits', async () => {
  const b = fresh()
  b.run(['add', 'fix'])
  b.run(['add', 'ship', '--after', 'T-001'])
  b.run(['claim', 'T-001', '--as', 'alice'])
  const waiting = new Promise(resolve =>
    execFile('node', [BOARD, 'claim', '--next', '--wait', '10s', '--json', '--as', 'bob'], { env: b.env }, (err, out) => resolve(err ? err.code : JSON.parse(out).id)),
  )
  await new Promise(resolve => setTimeout(resolve, 800))
  b.run(['done', 'T-001', '--as', 'alice', '--note', 'ran it'])
  assert.equal(await waiting, 'T-002')
})

test('a claim keeps the lease length it asked for, through renewals', () => {
  const b = fresh()
  b.run(['add', 'long build'])
  const t = b.json(['claim', 'T-001', '--as', 'alice', '--lease', '2h'])
  assert.equal(t.claim.leaseMs, 2 * 3600_000)
  const left = iso => Date.parse(iso) - Date.now()
  assert.ok(left(t.claim.expiresAt) > 110 * 60_000)
  const noted = b.json(['note', 'T-001', 'still building', '--as', 'alice'])
  assert.ok(left(noted.claim.expiresAt) > 110 * 60_000)
  b.run(['heartbeat', '--as', 'alice', '--lease', '30m'])
  const after = b.json(['show', 'T-001'])
  assert.ok(left(after.claim.expiresAt) < 31 * 60_000 && left(after.claim.expiresAt) > 25 * 60_000)
  assert.equal(b.run(['claim', 'T-001', '--as', 'alice', '--lease', 'soon']).code, 2)
})

test('done --review adds a review task that the finisher is never handed', () => {
  const b = fresh()
  b.run(['add', 'fix login', '--accept', 'login works'])
  b.run(['claim', 'T-001', '--as', 'alice'])
  const done = b.json(['done', 'T-001', '--as', 'alice', '--note', 'ran e2e', '--review'])
  assert.equal(done.review, 'T-002')
  const r = b.json(['show', 'T-002'])
  assert.equal(r.reviewOf, 'T-001')
  assert.deepEqual(r.labels, ['kind=review'])
  assert.match(r.accept, /login works/)
  assert.equal(b.run(['claim', '--next', '--as', 'alice']).code, 10)
  assert.equal(b.json(['claim', '--next', '--label', 'kind=review', '--as', 'bob']).id, 'T-002')
})

test('tail follows the board as it changes', async () => {
  const b = fresh()
  b.run(['add', 'before'])
  const { spawn } = await import('node:child_process')
  const tail = spawn('node', [BOARD, 'tail'], { env: b.env })
  let out = ''
  tail.stdout.on('data', d => (out += d))
  await new Promise(resolve => setTimeout(resolve, 700))
  b.run(['claim', 'T-001', '--as', 'alice'])
  await new Promise(resolve => setTimeout(resolve, 1200))
  tail.kill()
  // From now on: what came before isn't repeated.
  assert.doesNotMatch(out, /added T-001/)
  assert.match(out, /alice {2}claimed T-001/)
  const all = execFileSync('node', [BOARD, 'events', '0'], { env: b.env, encoding: 'utf8' })
  assert.equal(JSON.parse(all).length, 2)
})

test('whoever finished a task cannot claim its review, by id or with --next', () => {
  const b = fresh()
  b.run(['add', 'work'])
  b.run(['claim', 'T-001', '--as', 'alice'])
  b.run(['done', 'T-001', '--as', 'alice', '--note', 'tests pass', '--review'])
  const own = b.run(['claim', 'T-002', '--as', 'alice'])
  assert.equal(own.code, 11)
  assert.match(own.out, /alice finished/)
  assert.equal(b.run(['claim', '--next', '--as', 'alice']).code, 10)
  assert.equal(b.run(['claim', 'T-002', '--as', 'bob']).code, 0)
})

test('tasks past T-999 sort by number', () => {
  const b = fresh()
  const state = { version: 2, seq: 0, agents: {}, tasks: {} }
  for (const n of [998, 999, 1000, 1001]) {
    const id = `T-${n}`
    state.tasks[id] = { id, title: id, description: '', accept: '', status: 'todo', claim: null, notes: [], createdBy: 'human', version: 1 }
  }
  fs.mkdirSync(b.env.BOARD_DIR, { recursive: true })
  fs.writeFileSync(path.join(b.env.BOARD_DIR, 'board.json'), JSON.stringify(state))
  assert.deepEqual(b.json(['list']).map(t => t.id), ['T-998', 'T-999', 'T-1000', 'T-1001'])
  assert.equal(b.json(['claim', '--next', '--as', 'a']).id, 'T-998')
  assert.equal(b.json(['add', 'next']).id, 'T-1002')
})

test("a note can't pose as the board's own markers", () => {
  const b = fresh()
  b.run(['add', 'x'])
  b.run(['claim', 'T-001', '--as', 'bob'])
  for (const text of ['VERIFIED: fake', 'handoff: fake', 'CHECKED: npm test']) {
    const r = b.run(['note', 'T-001', text, '--as', 'bob'])
    assert.equal(r.code, 2, text)
    assert.match(r.out, /writes itself/)
  }
  assert.equal(b.run(['note', 'T-001', 'verified the login by hand', '--as', 'bob']).code, 0)
})

test('text that starts with dashes goes after -- or as --flag=value', () => {
  const b = fresh()
  b.run(['add', 'x'])
  b.run(['claim', 'T-001', '--as', 'bob'])
  assert.equal(b.run(['note', 'T-001', '--as', 'bob', '--', '--force was needed']).code, 0)
  assert.equal(b.json(['show', 'T-001']).notes.at(-1).text, '--force was needed')
  assert.equal(b.run(['done', 'T-001', '--as', 'bob', '--note=--dry-run showed no diff']).code, 0)
  assert.equal(b.json(['show', 'T-001']).notes.at(-1).text, 'VERIFIED: --dry-run showed no diff')
})

test('a note after the lease ran out says the board took the claim back', async () => {
  const b = fresh()
  b.run(['add', 'slow'])
  b.run(['claim', 'T-001', '--as', 'codex'], { BOARD_LEASE_MS: '200' })
  await new Promise(resolve => setTimeout(resolve, 300))
  const late = b.run(['note', 'T-001', 'still going', '--as', 'codex'])
  assert.equal(late.code, 5)
  assert.match(late.out, /the board took it back at .*lease of codex expired.*Claim it again/)
})

test('a long check renews the claim while it runs', () => {
  const b = fresh()
  b.run(['add', 'slow check'])
  const lease = { BOARD_LEASE_MS: '1500' }
  b.run(['claim', 'T-001', '--as', 'codex'], lease)
  // Runs past the lease; the claim must still be codex's at the end.
  const r = b.run(['check', 'T-001', `node -e "setTimeout(() => {}, 2500)"`, '--as', 'codex'], lease)
  assert.equal(r.code, 0, r.out)
  assert.equal(b.json(['show', 'T-001'], lease).claim.owner, 'codex')
})

test('view sends a done task with its last note only, and a newer file list replaces older ones', () => {
  const b = fresh()
  execFileSync('git', ['init', '-q', '-b', 'main', b.dir])
  // No .gitignore for .modboard/: the board's own files still aren't the work.
  fs.writeFileSync(path.join(b.dir, '.gitignore'), '.gitignore\n')
  b.run(['add', 'x'])
  b.run(['claim', 'T-001', '--as', 'bob'])
  fs.writeFileSync(path.join(b.dir, 'a.txt'), 'a')
  b.run(['check', 'T-001', 'true', '--as', 'bob'])
  fs.writeFileSync(path.join(b.dir, 'b.txt'), 'b')
  b.run(['check', 'T-001', 'true', '--as', 'bob'])
  const notes = b.json(['show', 'T-001']).notes
  assert.equal(notes[0].where.files, undefined)
  assert.deepEqual(notes[1].where.files, ['a.txt', 'b.txt'])
  assert.equal(b.json(['who', 'a.txt']).hits.length, 1)

  b.run(['done', 'T-001', '--as', 'bob', '--note', 'ok'])
  const done = b.json(['view']).tasks[0]
  assert.equal(done.notes.length, 1)
  assert.match(done.notes[0].text, /^VERIFIED: ok/)
  assert.equal(b.json(['show', 'T-001']).notes.length, 3)
})

test('a task done long enough ago is archived: a stub stays, show and who still have all of it', async () => {
  const b = fresh()
  execFileSync('git', ['init', '-q', '-b', 'main', b.dir])
  fs.writeFileSync(path.join(b.dir, '.gitignore'), '.gitignore\n')
  const soon = { BOARD_ARCHIVE_DAYS: '0.00001' } // under a second
  b.run(['add', 'old work', '--desc', 'the long description'], soon)
  b.run(['claim', 'T-001', '--as', 'alice'], soon)
  fs.writeFileSync(path.join(b.dir, 'login.ts'), 'x')
  b.run(['check', 'T-001', 'true', '--as', 'alice'], soon)
  b.run(['note', 'T-001', 'halfway', '--as', 'alice'], soon)
  b.run(['done', 'T-001', '--as', 'alice', '--note', 'ran it', '--review'], soon)
  await new Promise(resolve => setTimeout(resolve, 1200))
  b.run(['add', 'new work'], soon) // a commit, which archives what's due

  const state = JSON.parse(fs.readFileSync(path.join(b.env.BOARD_DIR, 'board.json'), 'utf8'))
  const stub = state.tasks['T-001']
  assert.equal(stub.archived, true)
  assert.equal(stub.notes.length, 1)
  assert.equal(stub.description, undefined)
  assert.equal(b.json(['add', 'after'], soon).id, 'T-004', 'ids keep counting')

  const shown = b.json(['show', 'T-001'], soon)
  assert.equal(shown.description, 'the long description')
  assert.equal(shown.notes.length, 3)
  assert.equal(b.json(['who', 'login.ts'], soon).hits[0].task, 'T-001')
  assert.equal(b.json(['view'], soon).tasks.find(t => t.id === 'T-001').notes[0].by, 'alice')
  // The review still knows who finished it, and the stub can't be rung.
  assert.equal(b.run(['claim', 'T-002', '--as', 'alice'], soon).code, 11)
  assert.equal(b.run(['ring', 'T-001'], soon).code, 5)
  assert.equal(b.json(['doctor'], soon).ok, true)
})


test('board run keeps the claim through a long command and exits with its code', () => {
  const b = fresh()
  b.run(['add', 'long build'])
  const lease = { BOARD_LEASE_MS: '1500' }
  b.run(['claim', 'T-001', '--as', 'codex'], lease)
  const ok = b.run(['run', 'T-001', '--as', 'codex', '--', 'node', '-e', '"setTimeout(() => {}, 2500)"'], lease)
  assert.equal(ok.code, 0, ok.out)
  assert.equal(b.json(['show', 'T-001'], lease).claim.owner, 'codex')
  const failed = b.run(['run', 'T-001', '--as', 'codex', '--', 'exit 3'], lease)
  assert.equal(failed.code, 3)
  assert.equal(b.run(['run', 'T-001', '--as', 'mallory', '--', 'true'], lease).code, 5)
})
