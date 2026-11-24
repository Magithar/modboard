// Ready-made blocks (board blocks): what they show, and what a project can't
// make them do.

import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { githubRepo, ghFailure, safePath } from '../lib/ready-blocks.mjs'

const BOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'board.mjs')
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'blocks-')))
const which = tool => path.dirname(execFileSync('/usr/bin/which', [tool], { encoding: 'utf8' }).trim())
const GIT_DIR = which('git')
const NODE_DIR = path.dirname(process.execPath)

// A git repo on `branch`, with a GitHub origin.
function repo(branch = 'main') {
  const root = tmp()
  const g = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  g('init', '-q', '-b', branch)
  g('config', 'user.email', 't@t')
  g('config', 'user.name', 't')
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
  g('add', '.')
  g('commit', '-qm', 'one')
  g('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  return root
}

// A program that leaves a marker when it runs, then does what `then` says.
function fake(dir, name, marker, then = 'exit 0') {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\n${then}\n`)
  fs.chmodSync(file, 0o755)
  return file
}

function board(cwd, args, env = {}) {
  const settings = env.BOARD_SETTINGS_FILE ?? path.join(tmp(), 'settings.json')
  const base = { ...process.env, BOARD_SETTINGS_FILE: settings, BOARD_DIR: path.join(cwd, '.modboard'), PATH: [GIT_DIR, NODE_DIR, '/usr/bin', '/bin'].join(':') }
  delete base.BOARD_AGENT
  try {
    return { code: 0, out: execFileSync(process.execPath, [BOARD, ...args], { cwd, env: { ...base, ...env }, encoding: 'utf8', stdio: 'pipe' }) }
  } catch (err) {
    return { code: err.status, out: String(err.stderr) }
  }
}
const json = (cwd, args, env) => {
  const r = board(cwd, [...args, '--json'], env)
  assert.equal(r.code, 0, r.out)
  return JSON.parse(r.out)
}

test('branch, changes and tests show what they say', () => {
  const root = repo('feature-x')
  assert.deepEqual(json(root, ['blocks', 'run', 'branch']), { id: 'branch', state: 'ok', text: 'feature-x' })
  assert.equal(json(root, ['blocks', 'run', 'changes']).text, 'clean')
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n')
  fs.writeFileSync(path.join(root, 'new.txt'), 'n\n')
  assert.equal(json(root, ['blocks', 'run', 'changes']).text, '1 modified · 1 untracked')
  assert.equal(json(tmp(), ['blocks', 'run', 'branch']).text, 'not a git repo')
})

test('on and off are kept in your own settings, and --all lists every block', () => {
  const root = repo()
  const settings = path.join(tmp(), 'settings.json')
  assert.deepEqual(json(root, ['blocks', 'on', 'ci'], { BOARD_SETTINGS_FILE: settings }), { id: 'ci', enabled: true })
  json(root, ['blocks', 'on', 'branch'], { BOARD_SETTINGS_FILE: settings })
  json(root, ['blocks', 'off', 'ci'], { BOARD_SETTINGS_FILE: settings })
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).blocks.enabled, ['branch'])
  const all = json(root, ['blocks', '--all'], { BOARD_SETTINGS_FILE: settings }).all
  assert.deepEqual(all.map(b => [b.id, b.enabled]), [['branch', true], ['changes', false], ['ci', false], ['prs', false], ['tests', false]])
  assert.equal(board(root, ['blocks', 'on', 'nope'], { BOARD_SETTINGS_FILE: settings }).code, 4)
})

// ── Security ─────────────────────────────────────────────────────────────────

test("a project's own git and gh never run, even first on PATH", () => {
  const root = repo('main')
  const marker = path.join(tmp(), 'ran')
  fake(path.join(root, 'bin'), 'git', marker, 'echo evil')
  fake(path.join(root, 'node_modules', '.bin'), 'gh', marker, 'echo evil')
  const PATH = [path.join(root, 'bin'), path.join(root, 'node_modules', '.bin'), '.', GIT_DIR, NODE_DIR, '/usr/bin', '/bin'].join(':')
  assert.equal(json(root, ['blocks', 'run', 'branch'], { PATH }).text, 'main')
  assert.equal(json(root, ['blocks', 'run', 'changes'], { PATH }).state, 'ok')
  // The only gh is the project's: the block says gh is missing, and doesn't run it.
  assert.equal(json(root, ['blocks', 'run', 'ci'], { PATH }).state, 'missing')
  assert.equal(fs.existsSync(marker), false)
  // A node_modules folder anywhere, or a relative entry, is never on the tools' PATH.
  assert.equal(safePath(root, ['/x/node_modules/.bin', 'rel/bin', '/usr/bin'].join(':')), '/usr/bin')
})

test("a repo's own git config can't run a program: fsmonitor is switched off, filters stop the block", () => {
  const root = repo()
  const marker = path.join(tmp(), 'ran')
  const hook = fake(path.join(tmp(), 'hooks'), 'evil', marker)
  execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: root })
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n')
  assert.equal(json(root, ['blocks', 'run', 'changes']).text, '1 modified')
  assert.equal(json(root, ['blocks', 'run', 'branch']).state, 'ok')
  assert.equal(fs.existsSync(marker), false, 'fsmonitor never ran')

  execFileSync('git', ['config', 'filter.evil.clean', hook], { cwd: root })
  fs.writeFileSync(path.join(root, '.gitattributes'), '* filter=evil\n')
  const r = json(root, ['blocks', 'run', 'changes'])
  assert.equal(r.state, 'unsafe')
  assert.match(r.text, /git config can run code \(filter\.evil\.clean\)/)
  assert.equal(fs.existsSync(marker), false, 'the filter never ran')

  // The same, pulled in through an include in the repo's config.
  const other = repo()
  const included = path.join(other, 'extra.config')
  fs.writeFileSync(included, `[filter "sneaky"]\n\tprocess = ${hook}\n`)
  execFileSync('git', ['config', 'include.path', included], { cwd: other })
  assert.equal(json(other, ['blocks', 'run', 'changes']).state, 'unsafe')
  assert.equal(fs.existsSync(marker), false)
})

test('two projects at once each get their own lines', async () => {
  const a = repo('alpha')
  const b = repo('beta')
  const run = cwd =>
    new Promise((resolve, reject) =>
      execFile(process.execPath, [BOARD, 'blocks', 'run', 'branch', '--json'], { cwd, env: { ...process.env, PATH: [GIT_DIR, '/usr/bin', '/bin'].join(':') } }, (err, out) => (err ? reject(err) : resolve(JSON.parse(out).text))),
    )
  const [ra, rb] = await Promise.all([run(a), run(b)])
  assert.equal(ra, 'alpha')
  assert.equal(rb, 'beta')
})

test('a block that is off never runs: nothing executes', () => {
  const root = repo()
  const marker = path.join(tmp(), 'ran')
  const tools = path.join(tmp(), 'tools')
  fake(tools, 'git', marker, `exec ${JSON.stringify(path.join(GIT_DIR, 'git'))} "$@"`)
  fake(tools, 'gh', marker)
  const PATH = [tools, NODE_DIR, '/usr/bin', '/bin'].join(':')
  assert.deepEqual(json(root, ['blocks'], { PATH }), { lines: [] })
  json(root, ['blocks', '--all'], { PATH })
  assert.equal(fs.existsSync(marker), false)
})

test('a hanging tool times out, and the other blocks still show', () => {
  const root = repo('main')
  const settings = path.join(tmp(), 'settings.json')
  const tools = path.join(tmp(), 'tools')
  fake(tools, 'gh', path.join(tmp(), 'log'), 'sleep 30')
  const env = { BOARD_SETTINGS_FILE: settings, BOARD_BLOCK_TIMEOUT_MS: '800', PATH: [tools, GIT_DIR, NODE_DIR, '/usr/bin', '/bin'].join(':') }
  json(root, ['blocks', 'on', 'ci'], env)
  json(root, ['blocks', 'on', 'branch'], env)
  const started = Date.now()
  const { lines } = json(root, ['blocks'], env)
  assert.ok(Date.now() - started < 10_000, 'came back long before the tool would')
  assert.deepEqual(lines.find(l => l.id === 'ci'), { id: 'ci', state: 'timeout', text: 'timed out' })
  assert.equal(lines.find(l => l.id === 'branch').text, 'main')
})

test('gh missing, not signed in, and offline each say so', () => {
  const root = repo()
  const tools = path.join(tmp(), 'tools')
  const log = path.join(tmp(), 'log')
  const withGh = then => {
    fake(tools, 'gh', log, then)
    return { PATH: [tools, GIT_DIR, NODE_DIR, '/usr/bin', '/bin'].join(':') }
  }
  assert.deepEqual(json(root, ['blocks', 'run', 'prs']), { id: 'prs', state: 'missing', text: 'needs gh (GitHub CLI)' })
  const auth = json(root, ['blocks', 'run', 'ci'], withGh('echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4'))
  assert.equal(auth.state, 'auth')
  assert.equal(auth.text, 'gh not signed in · run gh auth login')
  const offline = json(root, ['blocks', 'run', 'ci'], withGh('echo "error connecting to api.github.com" >&2; exit 1'))
  assert.equal(offline.state, 'offline')
  // gh runs outside the project, with the repo named.
  const seen = path.join(tmp(), 'seen')
  const shown = json(root, ['blocks', 'run', 'ci'], withGh(`pwd > ${JSON.stringify(seen)}; echo "$@" >> ${JSON.stringify(seen)}; echo '[{"status":"completed","conclusion":"success","workflowName":"CI","createdAt":"${new Date().toISOString()}"}]'`))
  assert.equal(shown.text, 'success · CI · just now')
  const [cwd, args] = fs.readFileSync(seen, 'utf8').trim().split('\n')
  assert.ok(!cwd.startsWith(root), `gh ran in ${cwd}`)
  assert.match(args, /--repo acme\/widgets/)
  assert.match(args, /--branch main/)
})

test('a repo not on GitHub says so instead of asking gh', () => {
  const root = repo()
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://gitlab.com/acme/widgets.git'], { cwd: root })
  const tools = path.join(tmp(), 'tools')
  const marker = path.join(tmp(), 'ran')
  fake(tools, 'gh', marker)
  const r = json(root, ['blocks', 'run', 'prs'], { PATH: [tools, GIT_DIR, NODE_DIR, '/usr/bin', '/bin'].join(':') })
  assert.deepEqual(r, { id: 'prs', state: 'empty', text: 'origin is not on GitHub' })
  assert.equal(fs.existsSync(marker), false)
  assert.equal(githubRepo('git@github.com:acme/widgets.git'), 'acme/widgets')
  assert.equal(githubRepo('https://github.com/acme/widgets'), 'acme/widgets')
  assert.equal(githubRepo('https://github.com.evil.com/acme/widgets'), null)
  assert.equal(ghFailure('HTTP 404: Not Found').text, 'no access to this repo on GitHub')
})

test('the tests block shows the last recorded check and never runs it', () => {
  const root = repo()
  const env = { BOARD_AGENT: 'bot' }
  assert.equal(json(root, ['blocks', 'run', 'tests'], env).text, 'no checks recorded yet')
  const marker = path.join(tmp(), 'ran')
  board(root, ['add', 'work'], env)
  board(root, ['claim', 'T-001'], env)
  // Recorded as passed without running it, so the marker would show any run.
  assert.equal(board(root, ['check', 'T-001', `touch ${marker}`, '--passed'], env).code, 0)
  const r = json(root, ['blocks', 'run', 'tests'], env)
  assert.equal(r.state, 'ok')
  assert.equal(r.text, `touch ${marker} passed (reported) · just now · T-001`)
  assert.equal(fs.existsSync(marker), false)
})

test("GIT_* settings in the environment don't reach the blocks' git", () => {
  const root = repo('mine')
  const other = repo('theirs')
  const env = { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: '/nonexistent' }
  assert.equal(json(root, ['blocks', 'run', 'branch'], env).text, 'mine')
  assert.equal(json(root, ['blocks', 'run', 'changes'], env).text, 'clean')
})
