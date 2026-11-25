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
//     source: 'built-in', view?: 'line', run(ctx) → { text, state } }
//
// `view` names the renderer that draws it (lib/block-data.mjs VIEW_TYPES);
// every ready-made block today is one line.
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

import { getSecret, mask } from './secrets.mjs'

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

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
  const tmp = `${settingsFile()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n')
  fs.renameSync(tmp, settingsFile())
}

export const enabledIds = () => {
  const on = readSettings().blocks?.enabled
  const known = new Set(allBlocks().map(b => b.id))
  return Array.isArray(on) ? on.filter(id => typeof id === 'string' && known.has(id)) : []
}

export function setEnabled(id, on) {
  if (!blockById(id)) throw Object.assign(new Error(`no block "${id}"; board blocks --all lists them`), { code: 4 })
  const settings = readSettings()
  const now = new Set(enabledIds())
  on ? now.add(id) : now.delete(id)
  settings.blocks = { ...(settings.blocks ?? {}), enabled: allBlocks().map(b => b.id).filter(b => now.has(b)) }
  writeSettings(settings)
  return { id, enabled: on }
}

// The names of the secrets you set (board secret), never their values.
export const secretNames = () => {
  const n = readSettings().secrets
  return Array.isArray(n) ? n.filter(x => typeof x === 'string') : []
}
export function rememberSecret(name, present) {
  const settings = readSettings()
  const names = new Set(secretNames())
  present ? names.add(name) : names.delete(name)
  settings.secrets = [...names].sort()
  writeSettings(settings)
}

// ── Your own blocks: a command you wrote, as a line ──────────────────────────
//
// Kept in your settings only (blocks.commands), never in a project, so
// opening someone else's repo can't make a display run its commands; adding
// one asks you at a terminal (board blocks add). It runs in the project's
// root, through your shell (it's a command line you wrote), with your
// environment, except that PATH leaves out the project's own folders, as for
// the built-ins, so a `git` a repo ships never stands in for yours. It shows
// its first line of output, cut to 60 characters.

export const COMMAND_ID = /^[a-z][a-z0-9-]{0,15}$/
const COMMAND_MAX = 500
const EVERY = { min: 5_000, default: 30_000 }

const commandSettings = () => {
  const c = readSettings().blocks?.commands
  return c && typeof c === 'object' && !Array.isArray(c) ? c : {}
}

function shellFor(line) {
  return process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line]]
    : ['/bin/sh', ['-c', line]]
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/

function commandBlock(id, { run: line, title, every, secrets }) {
  const wants = secrets && typeof secrets === 'object' ? Object.entries(secrets).filter(([k, v]) => ENV_NAME.test(k) && typeof v === 'string') : []
  return {
    id,
    title: typeof title === 'string' && title ? title : id,
    about: `your own: ${line}${wants.length ? `  (secrets: ${wants.map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`,
    needs: [],
    every: Number.isFinite(every) && every >= EVERY.min ? every : EVERY.default,
    timeout: 10_000,
    source: 'yours',
    async run(ctx) {
      const [sh, args] = shellFor(line)
      // The secrets it asked for, from the keychain, as environment variables;
      // whatever it prints, their values are masked.
      const given = {}
      for (const [name, secret] of wants) {
        let value
        try {
          value = getSecret(secret)
        } catch (err) {
          return { state: 'missing', text: err.message.slice(0, 60) }
        }
        if (value == null) return { state: 'missing', text: `needs secret ${secret}: board secret set ${secret}`.slice(0, 60) }
        given[name] = value
      }
      const env = { ...process.env, ...given, PATH: safePath(ctx.root), NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' }
      const r = await run(sh, args, { cwd: ctx.root, env, timeout: ctx.timeout })
      if (r.timedOut) return TIMED_OUT
      const values = Object.values(given)
      const first = s => mask(s, values).split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 60)
      if (r.status !== 0) return { state: 'error', text: first(r.stderr) ?? first(r.stdout) ?? `exited ${r.status}` }
      const text = first(r.stdout)
      return text ? { state: 'ok', text } : { state: 'empty', text: 'no output' }
    },
  }
}

const commandBlocks = () =>
  Object.entries(commandSettings())
    .filter(([id, c]) => COMMAND_ID.test(id) && !BLOCKS.some(b => b.id === id) && typeof c?.run === 'string' && c.run.trim())
    .map(([id, c]) => commandBlock(id, c))

export const allBlocks = () => [...BLOCKS, ...commandBlocks()]

// Add (or replace) one of your own blocks, and turn it on.
export function addCommandBlock(id, line, { title, every, secrets } = {}) {
  const bad = m => Object.assign(new Error(m), { code: 2 })
  if (!COMMAND_ID.test(id ?? '')) throw bad('a block name is lowercase letters, digits and dashes, up to 16, starting with a letter')
  if (BLOCKS.some(b => b.id === id)) throw bad(`"${id}" is a ready-made block's name`)
  if (typeof line !== 'string' || !line.trim()) throw bad('a block needs a command: --run "<command>"')
  if (line.length > COMMAND_MAX) throw bad(`a command is at most ${COMMAND_MAX} characters`)
  for (const [k, v] of Object.entries(secrets ?? {}))
    if (!ENV_NAME.test(k) || typeof v !== 'string' || !v) throw bad(`--secret takes VAR=name, like GH_TOKEN=github (got ${k}=${v})`)
  const settings = readSettings()
  const commands = { ...commandSettings(), [id]: { run: line.trim(), ...(title ? { title } : {}), ...(every ? { every } : {}), ...(secrets && Object.keys(secrets).length ? { secrets } : {}) } }
  const enabled = new Set(enabledIds())
  enabled.add(id)
  settings.blocks = { ...(settings.blocks ?? {}), commands }
  settings.blocks.enabled = [...BLOCKS.map(b => b.id), ...Object.keys(commands)].filter(b => enabled.has(b))
  writeSettings(settings)
  return { id, added: true }
}

export function removeCommandBlock(id) {
  const commands = { ...commandSettings() }
  if (!(id in commands)) throw Object.assign(new Error(`no block of your own named "${id}"`), { code: 4 })
  delete commands[id]
  const settings = readSettings()
  settings.blocks = { ...(settings.blocks ?? {}), commands, enabled: enabledIds().filter(b => b !== id) }
  writeSettings(settings)
  return { id, removed: true }
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

// ── Weather: Open-Meteo, for the place you set ───────────────────────────────
//
// Nothing is sent anywhere until you name a place (board weather <place>):
// the place's name goes to Open-Meteo's geocoding once, then only its
// coordinates, to the forecast, every 15 minutes. No key, no account, and no
// guess from your IP. The place is kept in your settings, not a project's.

export const WEATHER_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com']

export const weatherSettings = () => {
  const w = readSettings().weather
  const ok = w && typeof w.latitude === 'number' && typeof w.longitude === 'number' && typeof w.name === 'string'
  return ok ? { name: w.name, latitude: w.latitude, longitude: w.longitude, fahrenheit: w.fahrenheit === true } : null
}

// "Bengaluru" is looked up; "12.97,77.59" is used as it is.
export async function findPlace(text, { get = guardFetch({ id: 'weather', hosts: WEATHER_HOSTS }) } = {}) {
  const coords = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text ?? '')
  if (coords) {
    const [latitude, longitude] = [Number(coords[1]), Number(coords[2])]
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
    return { name: text.trim(), latitude, longitude }
  }
  if (typeof text !== 'string' || !text.trim()) return null
  const found = await get(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(text.trim())}`)
  const first = found?.results?.[0]
  return first && typeof first.latitude === 'number' ? { name: first.name, latitude: first.latitude, longitude: first.longitude } : null
}

export function setWeather(place, { fahrenheit = false } = {}) {
  const settings = readSettings()
  if (place) settings.weather = { ...place, ...(fahrenheit ? { fahrenheit: true } : {}) }
  else delete settings.weather
  const on = new Set(Array.isArray(settings.blocks?.enabled) ? settings.blocks.enabled : [])
  place ? on.add('weather') : on.delete('weather')
  settings.blocks = { ...(settings.blocks ?? {}), enabled: allBlocks().map(b => b.id).filter(id => on.has(id)) }
  writeSettings(settings)
  return place ? { weather: place.name, fahrenheit } : { weather: null }
}

// A redirect is refused, not followed: it could lead to a host the block
// may not reach.
async function fetchJson(url, { timeout = 8000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json' }, redirect: 'error' })
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  return res.json()
}

// ── Network: each block reaches only the hosts it names ─────────────────────
//
// A block never gets fetch itself, only this: HTTPS, to a host on its own
// `hosts` list, with no redirects, and nothing at all while you have the
// network off for blocks (board blocks network off). A block of your own is
// a shell command and isn't limited this way: it runs with your access.

export const networkOff = () => readSettings().blocks?.network === 'off'

export function setNetwork(on) {
  const settings = readSettings()
  settings.blocks = { ...(settings.blocks ?? {}) }
  if (on) delete settings.blocks.network
  else settings.blocks.network = 'off'
  writeSettings(settings)
  return { network: on ? 'on' : 'off' }
}

export function guardFetch(block, get = fetchJson) {
  const hosts = new Set(block?.hosts ?? [])
  return async (url, opts) => {
    let u
    try {
      u = new URL(url)
    } catch {
      throw Object.assign(new Error(`${block?.id}: not a URL`), { code: 'NOT_ALLOWED' })
    }
    if (u.protocol !== 'https:' || !hosts.has(u.hostname) || u.port || u.username || u.password)
      throw Object.assign(new Error(`${block?.id} may not reach ${u.protocol === 'https:' ? u.hostname : u.href}`), { code: 'NOT_ALLOWED' })
    if (networkOff()) throw Object.assign(new Error('network off for blocks'), { code: 'NETWORK_OFF' })
    return get(url, opts)
  }
}

// Open-Meteo's weather codes (WMO), as a sign and a word or two. Each sign
// is one column wide in every terminal (the line reaches Claude Code's band
// too, where emoji can draw two wide and leave stray characters).
export function conditions(code) {
  if (code === 0) return { sign: '☀', word: 'clear' }
  if (code <= 2) return { sign: '☁', word: 'partly cloudy' }
  if (code === 3) return { sign: '☁', word: 'cloudy' }
  if (code === 45 || code === 48) return { sign: '≋', word: 'fog' }
  if (code >= 51 && code <= 57) return { sign: '☂', word: 'drizzle' }
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { sign: '☂', word: 'rain' }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { sign: '❄', word: 'snow' }
  if (code >= 95) return { sign: '☇', word: 'thunderstorm' }
  return { sign: '·', word: 'unknown' }
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
  {
    id: 'clock',
    title: 'Clock',
    about: 'the time where you are, ticking in the page',
    needs: [],
    every: 60_000,
    timeout: 1_000,
    source: 'built-in',
    view: 'clock',
    // The page draws the time itself, in the viewer's time zone; the line is
    // for a display that shows text.
    async run(ctx) {
      return { state: 'ok', text: new Date(ctx.now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
    },
  },
  {
    id: 'timer',
    title: 'Timer',
    about: 'a countdown in the page: 5, 15, 25 min or your own',
    needs: [],
    every: 3_600_000,
    timeout: 1_000,
    source: 'built-in',
    view: 'timer',
    // The page runs it; nothing is kept on the board.
    async run() {
      return { state: 'ok', text: 'a timer, in the board page' }
    },
  },
  {
    id: 'weather',
    title: 'Weather',
    about: 'the weather where you set (board weather <place>), from Open-Meteo',
    needs: ['network'],
    hosts: WEATHER_HOSTS,
    every: 15 * 60_000,
    timeout: 8_000,
    source: 'built-in',
    async run(ctx) {
      const at = weatherSettings()
      if (!at) return { state: 'empty', text: 'no place set: board weather <place>' }
      const get = ctx.fetchJson
      let body
      try {
        body = await get(
          `https://api.open-meteo.com/v1/forecast?latitude=${at.latitude}&longitude=${at.longitude}` +
            '&current=temperature_2m,weather_code&daily=temperature_2m_max&forecast_days=1&timezone=auto' +
            (at.fahrenheit ? '&temperature_unit=fahrenheit' : ''),
          { timeout: ctx.timeout },
        )
      } catch (err) {
        if (err?.name === 'TimeoutError') return TIMED_OUT
        if (err?.code === 'NETWORK_OFF') return { state: 'offline', text: 'network off for blocks (board blocks network on)' }
        if (err?.code === 'NOT_ALLOWED') return { state: 'unsafe', text: err.message }
        return { state: 'offline', text: err?.status ? `Open-Meteo answered ${err.status}` : 'offline' }
      }
      const temp = body?.current?.temperature_2m
      if (typeof temp !== 'number') return { state: 'error', text: 'Open-Meteo sent no reading' }
      const high = body.daily?.temperature_2m_max?.[0]
      const { sign, word } = conditions(body.current.weather_code)
      const deg = n => `${Math.round(n)}°`
      return { state: 'ok', text: `${sign} ${deg(temp)} ${word} · H ${deg(high ?? temp)} · ${at.name}` }
    },
  },
]

export const blockById = id => allBlocks().find(b => b.id === id)
export const viewOf = id => blockById(id)?.view ?? 'line'

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
    // Each block gets only its own guarded fetch (opts.fetchJson stands in
    // for the network in tests, and is guarded the same way).
    const ctx = { ...context(cwd, { ...opts, timeout }), fetchJson: guardFetch(block, opts.fetchJson) }
    const out = await block.run(ctx)
    return { id, ...out }
  } catch (err) {
    return { id, state: 'error', text: String(err?.message ?? err).slice(0, 60) }
  }
}

// The registry as data, for a display to list: id, title, about, needs, how
// often, and whether it's on.
export const registry = () => {
  const on = new Set(enabledIds())
  return allBlocks().map(({ run: _, ...def }) => ({ ...def, view: def.view ?? 'line', enabled: on.has(def.id) }))
}
