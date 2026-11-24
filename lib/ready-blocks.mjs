// Ready-made blocks: reviewed, fixed commands that show one line about the
// project (its branch, CI, pull requests, changes, last test), for any agent
// through `board blocks`, and in Claude Code's band and pane.
//
// The registry is one list of definitions. Which ones are on is yours, kept in
// your own settings (~/.config/modboard/settings.json, or BOARD_SETTINGS_FILE),
// never in a project, so a project can't switch a block on. Every block has
// the same shape, so a block from the Store can join the list later:
//
//   { id, title, about, needs: ['git', 'gh'], every: ms, timeout: ms,
//     source: 'built-in', run(ctx) → { text, state } }
//
// state: ok · empty (nothing to show) · missing (a tool isn't installed) ·
// auth (gh isn't signed in) · offline · unsafe (the repo's own git config
// could run code) · timeout · error. `text` is one short line for people.
//
// Running a project's tools safely takes more than fixed arguments:
//   - git and gh are looked up on PATH with the project's own folders left
//     out (its bin/, node_modules/.bin, `.`), so a `git` the project ships
//     never runs.
//   - The environment is rebuilt from a short list: no GIT_* or GH_REPO
//     overrides, no pager, no prompts, no optional locks.
//   - git runs with -c overrides that switch off what can run code
//     (core.fsmonitor, hooks, external diff, pagers, network protocols),
//     and before `git status` the repo's own config is read: a local setting
//     that can run a program (a filter, fsmonitor, textconv, an include…)
//     stops the block with "unsafe" rather than run it.
//   - gh never reads the project: it runs outside it, with --repo named.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── Settings: which blocks are on ────────────────────────────────────────────

export const settingsFile = () =>
  process.env.BOARD_SETTINGS_FILE ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'modboard', 'settings.json')

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    return {}
  }
}

export const enabledIds = () => {
  const on = readSettings().blocks?.enabled
  return Array.isArray(on) ? on.filter(id => typeof id === 'string' && BLOCKS.some(b => b.id === id)) : []
}

export function setEnabled(id, on) {
  if (!BLOCKS.some(b => b.id === id)) throw Object.assign(new Error(`no block "${id}"; board blocks --all lists them`), { code: 4 })
  const settings = readSettings()
  const now = new Set(enabledIds())
  on ? now.add(id) : now.delete(id)
  settings.blocks = { ...(settings.blocks ?? {}), enabled: BLOCKS.map(b => b.id).filter(b => now.has(b)) }
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
  const tmp = `${settingsFile()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n')
  fs.renameSync(tmp, settingsFile())
  return { id, enabled: on }
}

// ── Finding tools outside the project ────────────────────────────────────────

const real = p => {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}
const within = (p, root) => !!p && !!root && (p === root || p.startsWith(root + path.sep))

// The project's root: the nearest folder above cwd with a .git, else cwd.
// Found by looking, not by running git.
export function projectRoot(cwd) {
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return real(d) ?? d
    if (path.dirname(d) === d) return real(cwd) ?? path.resolve(cwd)
  }
}

// PATH with what a project could plant in it left out: relative entries, `.`,
// anything inside the project, and any node_modules folder.
export function safePath(root, pathEnv = process.env.PATH ?? '') {
  return pathEnv
    .split(path.delimiter)
    .filter(d => d && path.isAbsolute(d) && !d.split(path.sep).includes('node_modules'))
    .filter(d => !within(real(d) ?? d, root))
    .join(path.delimiter)
}

// A tool's absolute path on the safe PATH, its real file outside the project,
// or null.
export function findTool(name, root, pathEnv) {
  for (const dir of safePath(root, pathEnv).split(path.delimiter)) {
    if (!dir) continue
    const at = path.join(dir, name)
    try {
      fs.accessSync(at, fs.constants.X_OK)
    } catch {
      continue
    }
    const target = real(at)
    if (target && fs.statSync(target).isFile() && !within(target, root)) return at
  }
  return null
}

// The environment a tool runs with: a short list kept from yours, the rest
// set so nothing prompts, pages or takes a lock another agent needs.
const KEEP = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'XDG_CONFIG_HOME', 'SSH_AUTH_SOCK',
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_CONFIG_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']

export function toolEnv(root) {
  const env = {}
  for (const k of KEEP) if (process.env[k] !== undefined) env[k] = process.env[k]
  return {
    ...env,
    PATH: safePath(root),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GH_PAGER: 'cat',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  }
}

// Run a tool by its absolute path, never a shell. Resolves with its output,
// or a timeout, however it ends.
function run(file, args, { cwd, env, timeout }) {
  return new Promise(resolve => {
    execFile(file, args, { cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err?.killed || err?.signal === 'SIGKILL') return resolve({ status: null, stdout: '', stderr: '', timedOut: true })
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), error: err && typeof err.code !== 'number' ? err : null })
    })
  })
}

// ── git, hardened ────────────────────────────────────────────────────────────

// -c overrides that beat the repo's own config for anything our commands
// could be made to run.
const GIT_SAFE = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.pager=cat',
  '-c', 'core.untrackedCache=false',
  '-c', 'diff.external=',
  '-c', 'protocol.allow=never',
  '-c', 'submodule.recurse=false',
  '--no-optional-locks',
]

// Settings in a repo's own config (or a file it includes) that can make the
// commands we run start a program and that -c can't switch off by name:
// filter drivers, which `git status` may run to check whether a file
// changed, and diff drivers. (core.fsmonitor, hooks, pagers, external diff
// and protocols are overridden in GIT_SAFE; the rest of git's program-running
// settings, such as editors, ssh, credential helpers and merge drivers, are
// used only by commands the blocks never run.) Global and system config are
// yours and are trusted.
const UNSAFE_KEY = /^(filter\..+\.(clean|smudge|process)|diff\..+\.(textconv|command))$/i
const TRUSTED_SCOPES = new Set(['global', 'system', 'unknown'])

export async function git(ctx, args, { scan = false } = {}) {
  const file = ctx.tools.git
  if (!file) return { missing: 'git' }
  const opts = { cwd: ctx.cwd, env: ctx.env, timeout: ctx.timeout }
  if (scan) {
    const listed = await run(file, [...GIT_SAFE, 'config', '--list', '--show-scope', '--name-only'], opts)
    if (listed.timedOut) return { timedOut: true }
    const risky = listed.stdout
      .split('\n')
      .map(l => l.split('\t'))
      .filter(([scope, key]) => key && !TRUSTED_SCOPES.has(scope) && UNSAFE_KEY.test(key))
      .map(([, key]) => key)
    if (risky.length) return { unsafe: [...new Set(risky)] }
  }
  return run(file, [...GIT_SAFE, ...args], opts)
}

// owner/name from a GitHub remote URL, or null.
export function githubRepo(url) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

// ── gh, outside the project ──────────────────────────────────────────────────

// What a failed gh call means, in words a person can act on.
export function ghFailure(stderr) {
  const s = stderr.toLowerCase()
  if (/gh auth login|not logged in|authentication required|bad credentials|http 401|requires authentication/.test(s)) return { state: 'auth', text: 'gh not signed in · run gh auth login' }
  if (/error connecting|could not resolve|no such host|dial tcp|network is unreachable|tls handshake|timeout|i\/o timeout|connection refused|enotfound/.test(s))
    return { state: 'offline', text: "offline · can't reach GitHub" }
  if (/http 404|could not resolve to a repository|not found/.test(s)) return { state: 'error', text: 'no access to this repo on GitHub' }
  if (/http 403|rate limit/.test(s)) return { state: 'error', text: 'GitHub refused: rate limit or permissions' }
  const line = stderr.split('\n').map(l => l.trim()).find(Boolean) ?? 'gh failed'
  return { state: 'error', text: line.slice(0, 60) }
}

async function gh(ctx, args) {
  const file = ctx.tools.gh
  if (!file) return { missing: 'gh' }
  // gh runs outside the project, with the repo named, so it never reads it.
  return run(file, args, { cwd: os.tmpdir(), env: ctx.env, timeout: ctx.timeout })
}

// The GitHub repo and branch the project is on, or what's wrong.
async function githubContext(ctx) {
  const remote = await git(ctx, ['remote', 'get-url', 'origin'])
  if (remote.missing) return { result: missing(remote.missing) }
  if (remote.timedOut) return { result: TIMED_OUT }
  if (remote.status !== 0) return { result: { state: 'empty', text: 'no origin remote' } }
  const repo = githubRepo(remote.stdout)
  if (!repo) return { result: { state: 'empty', text: 'origin is not on GitHub' } }
  const head = await git(ctx, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return { repo, branch: head.status === 0 ? head.stdout.trim() : '' }
}

// ── The blocks ───────────────────────────────────────────────────────────────

const TIMED_OUT = { state: 'timeout', text: 'timed out' }
const TOOL = { git: 'git', gh: 'gh (GitHub CLI)' }
const missing = tool => ({ state: 'missing', text: `needs ${TOOL[tool] ?? tool}` })
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function ago(ms) {
  const min = Math.max(0, Math.floor(ms / 60_000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

export const BLOCKS = [
  {
    id: 'branch',
    title: 'Branch',
    about: 'current git branch',
    needs: ['git'],
    every: 10_000,
    timeout: 5_000,
    source: 'built-in',
    async run(ctx) {
      const head = await git(ctx, ['symbolic-ref', '--short', '-q', 'HEAD'])
      if (head.missing) return missing(head.missing)
      if (head.timedOut) return TIMED_OUT
      if (head.status === 0 && head.stdout.trim()) return { state: 'ok', text: head.stdout.trim() }
      const at = await git(ctx, ['rev-parse', '--short', 'HEAD'])
      if (at.timedOut) return TIMED_OUT
      if (at.status === 0) return { state: 'ok', text: `detached @ ${at.stdout.trim()}` }
      return { state: 'empty', text: 'not a git repo' }
    },
  },
  {
    id: 'changes',
    title: 'Git Changes',
    about: 'working tree changes',
    needs: ['git'],
    every: 15_000,
    timeout: 5_000,
    source: 'built-in',
    async run(ctx) {
      const st = await git(ctx, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'], { scan: true })
      if (st.missing) return missing(st.missing)
      if (st.timedOut) return TIMED_OUT
      if (st.unsafe) return { state: 'unsafe', text: `not read: this repo's git config can run code (${st.unsafe[0]})` }
      if (st.status !== 0) return { state: 'empty', text: 'not a git repo' }
      let modified = 0
      let untracked = 0
      const entries = st.stdout.split('\0')
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        if (!e) continue
        if (e.startsWith('??')) untracked++
        else {
          modified++
          // A rename or copy is followed by its old path.
          if (e[0] === 'R' || e[0] === 'C') i++
        }
      }
      if (!modified && !untracked) return { state: 'ok', text: 'clean' }
      return { state: 'ok', text: [modified && `${modified} modified`, untracked && `${untracked} untracked`].filter(Boolean).join(' · ') }
    },
  },
  {
    id: 'ci',
    title: 'CI',
    about: 'latest GitHub Actions run on this branch',
    needs: ['git', 'gh'],
    every: 60_000,
    timeout: 15_000,
    source: 'built-in',
    async run(ctx) {
      if (!ctx.tools.gh) return missing('gh')
      const where = await githubContext(ctx)
      if (where.result) return where.result
      const out = await gh(ctx, ['run', 'list', '--repo', where.repo, ...(where.branch ? ['--branch', where.branch] : []), '--limit', '1', '--json', 'status,conclusion,workflowName,createdAt'])
      if (out.missing) return missing(out.missing)
      if (out.timedOut) return TIMED_OUT
      if (out.status !== 0) return ghFailure(out.stderr)
      const [last] = JSON.parse(out.stdout || '[]')
      if (!last) return { state: 'empty', text: `no runs on ${where.branch || 'this repo'}` }
      const when = ago(ctx.now - Date.parse(last.createdAt))
      const result = last.status !== 'completed' ? 'running' : last.conclusion === 'success' ? 'success' : last.conclusion || 'done'
      return { state: 'ok', text: `${result} · ${last.workflowName} · ${when}` }
    },
  },
  {
    id: 'prs',
    title: 'Pull Requests',
    about: 'your open pull requests and reviews',
    needs: ['git', 'gh'],
    every: 120_000,
    timeout: 15_000,
    source: 'built-in',
    async run(ctx) {
      if (!ctx.tools.gh) return missing('gh')
      const where = await githubContext(ctx)
      if (where.result) return where.result
      const out = await gh(ctx, ['pr', 'status', '--repo', where.repo, '--json', 'number,reviewDecision,isDraft,headRefName'])
      if (out.missing) return missing(out.missing)
      if (out.timedOut) return TIMED_OUT
      if (out.status !== 0) return ghFailure(out.stderr)
      const data = JSON.parse(out.stdout || '{}')
      const mine = (data.createdBy ?? []).length
      const review = (data.needsReview ?? []).length
      const parts = [mine ? `${mine} open` : 'none open', review ? `${review} to review` : '']
      // This branch's own pull request, if it has one.
      const here = [...(data.createdBy ?? []), ...(data.needsReview ?? [])].find(p => where.branch && p.headRefName === where.branch) ?? data.currentBranch
      if (here?.number) parts.push(`#${here.number} ${here.isDraft ? 'draft' : (here.reviewDecision || 'open').toLowerCase().replace(/_/g, ' ')}`)
      return { state: 'ok', text: parts.filter(Boolean).join(' · ') }
    },
  },
  {
    id: 'tests',
    title: 'Tests',
    about: 'last test result agents recorded',
    needs: [],
    every: 15_000,
    timeout: 5_000,
    source: 'built-in',
    // From the board's own records (board check), never by running the tests.
    async run(ctx) {
      const tasks = ctx.tasks ? await ctx.tasks() : []
      let last = null
      for (const t of tasks)
        for (const n of t.notes ?? []) if (n.check && (!last || n.at > last.note.at)) last = { note: n, task: t.id }
      if (!last) return { state: 'empty', text: 'no checks recorded yet' }
      const { note, task } = last
      const how = note.check.ran ? '' : ' (reported)'
      return { state: 'ok', text: `${note.check.cmd} passed${how} · ${ago(ctx.now - Date.parse(note.at))} · ${task}` }
    },
  },
]

export const blockById = id => BLOCKS.find(b => b.id === id)

// What a block needs to run, for this project.
export function context(cwd, { tasks, now = Date.now(), timeout } = {}) {
  const root = projectRoot(cwd)
  return {
    cwd,
    root,
    now,
    env: toolEnv(root),
    tools: { git: findTool('git', root), gh: findTool('gh', root) },
    tasks,
    timeout,
  }
}

// One block, for this project: its line and state, never a throw. The
// block's own timeout bounds each tool it runs; BOARD_BLOCK_TIMEOUT_MS
// shortens it (for tests).
export async function runBlock(id, cwd, opts = {}) {
  const block = blockById(id)
  if (!block) return { id, state: 'error', text: `no block "${id}"` }
  const timeout = Number(process.env.BOARD_BLOCK_TIMEOUT_MS) || block.timeout
  try {
    const out = await block.run(context(cwd, { ...opts, timeout }))
    return { id, ...out }
  } catch (err) {
    return { id, state: 'error', text: String(err?.message ?? err).slice(0, 60) }
  }
}

// The registry as data, for a display to list: id, title, about, needs, how
// often, and whether it's on.
export const registry = () => {
  const on = new Set(enabledIds())
  return BLOCKS.map(({ run: _, ...def }) => ({ ...def, enabled: on.has(def.id) }))
}
