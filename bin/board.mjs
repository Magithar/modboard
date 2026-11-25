#!/usr/bin/env node
// board — an agent-neutral shared board. Any agent (Claude, Codex, a human)
// coordinates through this one CLI; nothing else writes the board.
//
// The board lives in <repo>/.modboard/, beside the git *common* dir so
// every worktree of a repo shares one board (BOARD_DIR overrides). A board
// made before the rename, in .agent-board/, is used where it already exists.
// Which storage block holds it is named in .modboard/config.json (see
// lib/load-store.mjs); the default is the built-in "file" block.

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { BoardError, createEngine } from '../lib/engine.mjs'
import { createHolder } from '../lib/holder.mjs'
import { blockPlan, blocksDir, installBlock, listBlocks, loadStore, removeBlock, storeStatus } from '../lib/load-store.mjs'
import { readTaskFile } from '../lib/taskfile.mjs'
import { addCommandBlock, blockById, findPlace, findTool, networkOff, projectRoot, registry, rememberSecret, removeCommandBlock, runBlock, secretNames, setEnabled, setNetwork, setWeather, enabledIds, viewOf, weatherSettings } from '../lib/ready-blocks.mjs'
import { removeSecret, setSecret } from '../lib/secrets.mjs'
import { lineBlock, tasksBlock } from '../lib/block-data.mjs'
import { createBench, listen } from '../lib/serve.mjs'
import { createMcp, runStdio } from '../lib/mcp.mjs'
import { boardActions } from '../lib/board-actions.mjs'

// git, found on PATH with the project's own folders left out (its bin/,
// node_modules/.bin), so a git the project ships never runs, even just to
// find the board (lib/ready-blocks.mjs). A missing git throws, as a failed
// run does, and every caller falls back.
function gitSync(args) {
  const git = findTool('git', projectRoot(process.cwd()))
  if (!git) throw Object.assign(new Error('git not found'), { code: 'ENOENT' })
  return execFileSync(git, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function boardDir() {
  if (process.env.BOARD_DIR) return path.resolve(process.env.BOARD_DIR)
  try {
    const common = gitSync(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    return inside(path.dirname(common))
  } catch {
    return inside(process.cwd())
  }
}

// The checkout the command runs in (its own worktree, not the shared board's
// repo), else the current directory: where a task.md is looked for.
function projectDir() {
  try {
    return gitSync(['rev-parse', '--show-toplevel']).trim()
  } catch {
    return process.cwd()
  }
}

// Where the work is: the worktree this command runs in, its branch, the commit
// it is at, whether anything is uncommitted, and the files the work changed.
// Nothing outside a git repo.
const FILES_KEPT = 50
function whereNow() {
  const raw = (...args) => gitSync(args)
  const git = (...args) => raw(...args).trim()
  const or = (f, fallback) => {
    try {
      return f()
    } catch {
      return fallback
    }
  }
  const worktree = or(() => git('rev-parse', '--show-toplevel'), '')
  if (!worktree) return undefined
  return {
    worktree,
    branch: or(() => git('symbolic-ref', '--short', '-q', 'HEAD'), ''),
    commit: or(() => git('rev-parse', '--short', 'HEAD'), ''),
    dirty: or(() => git('status', '--porcelain').length > 0, false),
    files: or(() => changedFiles(raw, or).filter(f => !inBoardDir(worktree, f)), []),
  }
}

// The files this worktree's work changed: those its branch changed since it
// left the main line (origin's default branch, else main or master), and
// those changed and not yet committed. Each worktree is one agent's, so this
// is what that agent touched.
function changedFiles(raw, or) {
  const files = new Set()
  const branch = or(() => raw('symbolic-ref', '--short', '-q', 'HEAD').trim(), '')
  const base = ['origin/HEAD', 'main', 'master']
    .filter(ref => ref !== branch)
    .map(ref => or(() => raw('merge-base', 'HEAD', ref).trim(), ''))
    .find(Boolean)
  if (base) for (const f of or(() => raw('diff', '--name-only', base, 'HEAD'), '').split('\n')) if (f.trim()) files.add(f.trim())
  // Porcelain lines are "XY path" or "XY old -> new"; their leading space matters.
  for (const l of or(() => raw('status', '--porcelain', '--untracked-files=all'), '').split('\n'))
    if (l.length > 3) files.add(l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''))
  return [...files].sort().slice(0, FILES_KEPT)
}

// The board's own files (board.json, the ledger) are never the work, even in
// a repo that doesn't ignore .modboard/.
function inBoardDir(worktree, file) {
  // git answers with real paths (/private/var on macOS), so compare those.
  const real = p => {
    try {
      return fs.realpathSync(p)
    } catch {
      return p
    }
  }
  const rel = path.relative(real(worktree), real(DIR))
  return !rel.startsWith('..') && (file === rel || file.startsWith(`${rel}/`))
}

// "/repo/wt-login · login @ a1b2c3d, uncommitted changes"
const at = w => `${w.commit || 'no commits'}${w.dirty ? ', uncommitted changes' : ''}`
const place = w => `${w.worktree}${w.branch ? ` · ${w.branch}` : ' · detached'} @ ${at(w)}${w.stale ? ' (last known, may be stale)' : ''}`

function inside(root) {
  const old = path.join(root, '.agent-board')
  const now = path.join(root, '.modboard')
  return !fs.existsSync(now) && fs.existsSync(old) ? old : now
}

function parseArgs(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // After a bare --, everything is a word: board note T-1 -- "--force was needed".
    if (a === '--') {
      pos.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      // --note=--anything keeps a value that starts with dashes.
      const eq = a.indexOf('=')
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
      const val = eq > 0 ? a.slice(eq + 1) : argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true
      // A flag given twice (--label a --label b) keeps both.
      flags[name] = name in flags ? [flags[name], val].flat() : val
    } else pos.push(a)
  }
  return { pos, flags }
}

const text = v => (typeof v === 'string' ? v : Array.isArray(v) ? text(v.at(-1)) : undefined)

// A list flag, given twice or comma-separated: --label kind=bug,area=api.
const many = v => [v ?? []].flat().filter(x => typeof x === 'string').flatMap(x => x.split(',')).map(x => x.trim()).filter(Boolean)

// A length of time: 90s, 10m, 1h, or a bare number of minutes.
function duration(v, flag) {
  if (v === undefined) return undefined
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(String(text(v) ?? ''))
  if (!m || Number(m[1]) <= 0) throw new BoardError(2, `--${flag} takes a length of time: 90s, 10m, 1h`)
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 'm']
}

// Who is asking: --as, else BOARD_AGENT, else a Codex thread (Codex marks every
// shell it runs with CODEX_THREAD_ID), named "codex 1", "codex 2" by when it
// joined. Codex sends no presence ping, so its leases end its claims, or
// sooner the end of the process that holds them (lib/holder.mjs).
async function actorOf(board, flags) {
  const a = text(flags.as) ?? process.env.BOARD_AGENT
  if (a) return a
  const thread = process.env.CODEX_THREAD_ID
  if (thread) return (await board.join('codex', thread, { presence: false })).name
  throw new BoardError(2, 'who are you? pass --as <agent> or set BOARD_AGENT')
}

const SYMBOL = { todo: '○', claimed: '◐', done: '●' }
const line = t =>
  `${SYMBOL[t.status]} ${t.id}  ${t.title}${t.labels?.length ? `  [${t.labels.join(' ')}]` : ''}${t.claim ? `  ${t.claim.owner}` : ''}${t.waitingOn?.length ? `  waits on ${t.waitingOn.join(', ')}` : ''}`

function describe(t) {
  const out = [line(t), '']
  if (t.description) out.push(t.description, '')
  if (t.accept) out.push(`Accept when: ${t.accept}`, '')
  if (t.ring) out.push('Rings an alarm when done.', '')
  if (t.labels?.length) out.push(`Labels: ${t.labels.join(', ')}`, '')
  if (t.reviewOf) out.push(`Reviews ${t.reviewOf}.`, '')
  if (t.after?.length) out.push(`Waits on ${t.after.join(', ')}${t.waitingOn?.length ? `; still open: ${t.waitingOn.join(', ')}` : '; all done'}`, '')
  if (t.claim) out.push(`claimed by ${t.claim.owner} until ${t.claim.expiresAt}`)
  for (const n of t.notes) {
    out.push(`- [${n.at.slice(0, 16)}] ${n.by}: ${n.text}${n.check ? (n.check.ran ? ' (run by the board, passed)' : ' (passed, as reported)') : ''}`)
    if (n.where) out.push(`    in ${place(n.where)}`)
    if (n.where?.files?.length) out.push(`    files: ${n.where.files.join(', ')}`)
  }
  return out.join('\n')
}

// --secret VAR=name (given once or more) -> { VAR: name }.
function secretFlags(v) {
  const out = {}
  for (const pair of [v ?? []].flat()) {
    const at = typeof pair === 'string' ? pair.indexOf('=') : -1
    if (at < 1) throw new BoardError(2, `--secret takes VAR=name, like GH_TOKEN=github${typeof pair === 'string' ? ` (got ${pair})` : ''}`)
    out[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return out
}

const readAll = stream =>
  new Promise((resolve, reject) => {
    let out = ''
    stream.setEncoding('utf8')
    stream.on('data', c => (out += c))
    stream.on('end', () => resolve(out))
    stream.on('error', reject)
  })

// A line typed at the terminal, not echoed. Ctrl+C or Ctrl+D gives nothing.
function askHidden(prompt) {
  return new Promise(resolve => {
    const input = process.stdin
    process.stderr.write(prompt)
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')
    let value = ''
    const done = v => {
      input.setRawMode(false)
      input.pause()
      input.off('data', onData)
      process.stderr.write('\n')
      resolve(v)
    }
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(value)
        if (ch === '\u0003' || ch === '\u0004') return done('')
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    input.on('data', onData)
  })
}

// Open a page in the person's browser: the system's own opener, no shell.
function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['explorer.exe', [url]] : ['xdg-open', [url]]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => console.error(`open ${url} in your browser`)).unref()
  } catch {
    console.error(`open ${url} in your browser`)
  }
}

// Antigravity's plugins folder (BOARD_ANTIGRAVITY_PLUGINS for tests).
const antigravityPlugins = () => process.env.BOARD_ANTIGRAVITY_PLUGINS ?? path.join(os.homedir(), '.gemini', 'config', 'plugins')

function installAntigravity(flags = {}) {
  const want = flags.dir === undefined ? projectDir() : typeof flags.dir === 'string' ? path.resolve(flags.dir) : ''
  if (!want || !fs.statSync(want, { throwIfNoEntry: false })?.isDirectory()) throw new BoardError(2, 'usage: board antigravity [--dir <project folder>]')
  const fallback = fs.realpathSync(want)
  const home = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const from = path.join(home, 'integrations', 'antigravity', 'modboard')
  const dir = path.join(antigravityPlugins(), 'modboard')
  const existing = fs.existsSync(dir)
  if (existing) {
    let ours = false
    try {
      ours = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).name === 'modboard' && fs.existsSync(path.join(dir, 'sidecars', 'board', 'main.mjs'))
    } catch {}
    if (!ours) throw new BoardError(2, `${dir} holds another plugin; move it away first`)
    fs.rmSync(dir, { recursive: true })
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  fs.cpSync(from, dir, { recursive: true })
  const manifest = path.join(dir, 'sidecars', 'board', 'sidecar.json')
  const sidecar = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  sidecar.env = { ...(sidecar.env ?? {}), MODBOARD_HOME: fs.realpathSync(home), MODBOARD_DEFAULT_DIR: fallback }
  fs.writeFileSync(manifest, JSON.stringify(sidecar, null, 2) + '\n')
  return { dir, updated: existing, board: fallback }
}

// board mcp|serve --dir <project>: the project to show, for a host that
// starts its servers somewhere else (Claude Desktop starts them in /, with no
// setting for the folder). Read before anything else looks at the folder.
function chdirFromFlag() {
  const [cmd, ...rest] = process.argv.slice(2)
  const dir = parseArgs(rest).flags.dir
  if (dir === undefined || !DIR_COMMANDS.has(cmd)) return
  const at = typeof dir === 'string' ? path.resolve(dir) : ''
  if (!at || !fs.statSync(at, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`board: --dir needs a folder that exists${typeof dir === 'string' ? ` (not ${dir})` : ''}`)
    process.exit(2)
  }
  process.chdir(at)
}
const DIR_COMMANDS = new Set(['mcp', 'serve'])
chdirFromFlag()

const DIR = boardDir()
const LEASE_MS = Number(process.env.BOARD_LEASE_MS ?? 15 * 60 * 1000)

// Local clock time, for people: "19:45".
const hhmm = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const ids = list => (list.length ? list.join(', ') : 'nothing')

// What each command says to a person. --json prints the data instead, and
// view and events (for programs) always do.
const SAY = {
  secret: r => (r.secrets ? (r.secrets.length ? r.secrets.join('\n') : 'no secrets set; board secret set <name>') : r.set ? `kept ${r.secret} in the keychain` : `removed ${r.secret}`),
  weather: r => (r.weather ? `weather for ${r.weather}${r.fahrenheit ? ', in °F' : ''}; the weather block is on` : 'no weather place set; board weather <place> sets one'),
  antigravity: r =>
    [
      `${r.updated ? 'updated' : 'installed'} the modBOARD panel in ${r.dir}`,
      `where a conversation's folder has no board, it shows ${r.board}'s`,
      'In Antigravity: Customizations > Installed, turn modboard on (off and on again after an update),',
      'then in a conversation: the ⋮ menu (top right) > Plugins > modBOARD.',
    ].join('\n'),
  add: t => `added ${line(t)}${t.ring ? '\nit rings an alarm when done' : ''}`,
  ring: t => (t.ring ? `${t.id} rings an alarm when done` : `${t.id} no longer rings when done`),
  claim: t => `claimed ${t.id}  ${t.title}\nit's yours until ${hhmm(t.claim.expiresAt)}; a note or heartbeat renews it`,
  tail: () => '',
  heartbeat: r => `renewed ${ids(r.renewed)}`,
  note: t => `noted on ${t.id}; yours until ${hhmm(t.claim.expiresAt)}`,
  release: t => {
    const n = t.notes.at(-1)
    const handoff = n?.text.startsWith('HANDOFF:')
    return `released ${t.id}${handoff ? ' with a handoff' : ''}; it's back to todo${handoff && n.where ? `\nthe work is in ${place(n.where)}` : ''}`
  },
  who: r =>
    r.hits.length
      ? r.hits.map(h => `${h.task}  ${h.title}  · ${h.by} · ${h.kind} ${hhmm(h.at)} · ${place(h.where)}`).join('\n')
      : `no handoff or check recorded a change to ${r.file}`,
  check: t => {
    const n = t.notes.at(-1)
    return `checked ${t.id}: ${n.check.cmd} passed${n.where ? ` at ${at(n.where)}` : ''}; yours until ${hhmm(t.claim.expiresAt)}`
  },
  done: t => `done ${line(t)}\n${t.notes.at(-1).text}${t.review ? `\nadded ${t.review} to review it` : ''}`,
  'release-all': r => `released ${ids(r.released)}`,
  blocks: r => {
    if (r.network) return `network for blocks: ${r.network}${r.network === 'off' ? ' (board blocks network on turns it back on)' : ''}`
    if (r.all)
      return [
        ...r.all.map(b => `${b.enabled ? '[x]' : '[ ]'} ${b.id.padEnd(8)} ${b.about}${b.needs.length ? `  (needs ${b.needs.join(', ')})` : ''}${b.hosts?.length ? `  reaches ${b.hosts.join(', ')}` : ''}`),
        ...(r.networkOff ? ['network for blocks is off: board blocks network on'] : []),
      ].join('\n')
    if (r.lines) return r.lines.length ? r.lines.map(l => `${l.id.padEnd(8)} ${l.text}`).join('\n') : 'no blocks on; board blocks --all lists them, board blocks on <id> turns one on'
    if (r.added) return `added ${r.id}, and turned it on; every display shows it`
    if (r.removed) return `removed ${r.id}`
    if (r.text !== undefined) return `${r.id.padEnd(8)} ${r.text}`
    return `${r.id} is ${r.enabled ? 'on' : 'off'}`
  },
  register: r => `you are ${r.name}`,
  join: r => `you are ${r.name}`,
  whoami: r => `you are ${r.name}`,
  agents: list => (list.length ? list.map(a => `${a.name}  last seen ${hhmm(a.lastSeen)}`).join('\n') : '(no live agents)'),
  taskfile: r =>
    r.file
      ? [r.file, ...r.items.map(i => `${'  '.repeat(i.depth)}${i.done === null ? '-' : i.done ? '[x]' : '[ ]'} ${i.priority === null ? '' : `P${i.priority} `}${i.text}`)].join('\n')
      : '(no task.md here)',
  block: r =>
    r.blocks
      ? r.blocks.length
        ? [`in ${r.dir}:`, ...r.blocks.map(b => `  ${b}`)].join('\n')
        : `no blocks installed (${r.dir})`
      : r.removed
        ? `removed ${r.removed}`
        : `installed ${r.name} at ${r.at}\nname it in a board's .modboard/config.json: "store": "${r.name}"`,
  doctor: r =>
    [`storage block: ${r.block}`, ...(r.tasks !== undefined ? [`${r.tasks} ${r.tasks === 1 ? 'task' : 'tasks'}, ${r.events ?? '?'} events`] : []), r.ok ? 'ok: the ledger and the state agree' : 'problems:', ...r.problems.map(p => `- ${p}`)].join('\n'),
}

// What each ledger event says, for tail: "claimed T-004".
const DID = {
  add: 'added', claim: 'claimed', 'claim-rejected': 'lost the claim on', note: 'noted on', check: 'checked',
  release: 'released', done: 'finished', expire: 'took back', ring: 'set to ring', unring: 'stopped the ring on', register: 'joined',
}
const said = e => `${hhmm(e.at)}  ${e.actor}  ${DID[e.type] ?? e.type}${e.task ? ` ${e.task}` : ''}${e.holder ? ` (held by ${e.holder})` : ''}${e.reason === 'silent' ? ' (its session went silent)' : e.reason === 'exited' ? ' (its process exited)' : ''}`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The board's tasks, read only when a block asks (tests): blocks run without
// loading the board otherwise, and a board that can't load leaves the others
// working.
async function boardTasks() {
  const { store } = await loadStore(DIR)
  return createEngine(store, { leaseMs: LEASE_MS }).list({ all: true })
}

// A display may ask every few seconds, and from many widgets at once: each
// ready-made block runs at most once per its own `every` (gh calls count
// against GitHub's hourly limit), and callers in between share that run.
const blockRuns = new Map()
function runBlockAtMostEvery(id, cwd, opts) {
  const last = blockRuns.get(id)
  if (last && Date.now() - last.at < (blockById(id)?.every ?? 0)) return last.line
  const line = runBlock(id, cwd, opts)
  blockRuns.set(id, { at: Date.now(), line })
  return line
}

// Every block, in the shared shape (lib/block-data.mjs): the tasks, read
// fresh each call, then the ready-made blocks that are on, for this project.
const boardBlocks = (board, me) => async () => {
  const cwd = process.cwd()
  const tasks = await board.list({ all: true })
  const lines = await Promise.all(enabledIds().map(id => runBlockAtMostEvery(id, cwd, { tasks: async () => tasks })))
  return [tasksBlock(tasks, { me }), ...lines.map(l => lineBlock(l, { title: blockById(l.id)?.title, type: viewOf(l.id) }))]
}

// Refuse, with the board's own words, unless actor holds the task.
async function holding(board, id, actor) {
  const t = await board.show(id)
  if (t.status !== 'claimed' || t.claim.owner !== actor)
    throw new BoardError(5, `${t.id} is not claimed by ${actor}${t.claim ? ` (owner: ${t.claim.owner})` : ''}`)
  return t
}

// Run a shell command, renewing actor's claims as it goes, so a long run (a
// full test suite, a build) can't outlast the lease.
async function keepingClaim(board, actor, cmd, stdio) {
  const renew = setInterval(() => board.heartbeat(actor).catch(() => {}), Math.max(1000, LEASE_MS / 3))
  return new Promise(resolve => {
    const child = spawn(cmd, { shell: true, stdio })
    child.on('error', error => resolve({ status: null, error }))
    child.on('close', (status, signal) => resolve({ status, signal }))
  }).finally(() => clearInterval(renew))
}

const commands = {
  async list(board, _, flags) {
    const tasks = await board.list({ all: !!flags.all, ready: !!flags.ready, labels: many(flags.label) })
    if (flags.json) return tasks
    return tasks.length ? tasks.map(line).join('\n') : flags.ready || flags.label ? '(nothing matches)' : '(no open tasks)'
  },
  async show(board, [id], flags) {
    const t = await board.show(id)
    return flags.json ? t : describe(t)
  },
  async add(board, [title], flags) {
    if (!title) throw new BoardError(2, 'usage: board add "<title>" [--desc "..."] [--accept "how to tell it is done"] [--after T-001] [--label kind=bug] [--ring]')
    const by = text(flags.as) ?? process.env.BOARD_AGENT ?? (process.env.CODEX_THREAD_ID ? await actorOf(board, flags) : 'human')
    return board.add(by, {
      title,
      description: text(flags.desc),
      accept: text(flags.accept),
      ring: !!flags.ring,
      after: many(flags.after),
      labels: many(flags.label),
    })
  },
  // board ring <id>: ring an alarm when it is done. --off takes that back.
  async ring(board, [id], flags) {
    if (!id) throw new BoardError(2, 'usage: board ring <id> [--off]')
    const by = text(flags.as) ?? process.env.BOARD_AGENT ?? (process.env.CODEX_THREAD_ID ? await actorOf(board, flags) : 'human')
    return board.ring(id, by, !flags.off)
  },
  // board claim <id>, or --next: the first ready task (with --label, carrying
  // them), picked and claimed in one step. --wait 10m waits for one to come
  // ready. --lease 1h holds it that long between renewals.
  async claim(board, [id], flags) {
    const actor = await actorOf(board, flags)
    const leaseMs = duration(flags.lease, 'lease')
    if (!flags.next) {
      if (!id || flags.label || flags.wait) throw new BoardError(2, 'usage: board claim <id> [--lease 1h], or board claim --next [--label kind=bug] [--wait 10m] [--lease 1h]')
      return board.claim(id, actor, { leaseMs })
    }
    if (id) throw new BoardError(2, 'claim --next picks the task itself; leave out the id')
    const labels = many(flags.label)
    const until = Date.now() + (duration(flags.wait, 'wait') ?? 0)
    for (;;) {
      const t = await board.claimNext(actor, { labels, leaseMs })
      if (t) return t
      if (Date.now() >= until) throw new BoardError(10, `nothing ready to claim${labels.length ? ` with ${labels.join(', ')}` : ''}`)
      await sleep(Math.min(1000, until - Date.now()))
    }
  },
  heartbeat: async (board, _, flags) => board.heartbeat(await actorOf(board, flags), { leaseMs: duration(flags.lease, 'lease') }),
  async note(board, [id, note], flags) {
    if (!note) throw new BoardError(2, 'usage: board note <id> "<text>"')
    return board.note(id, await actorOf(board, flags), note)
  },
  release: async (board, [id], flags) => board.release(id, await actorOf(board, flags), text(flags.handoff), whereNow()),
  // Which agents changed a file, from the files each handoff and check
  // recorded: the latest first, with the task and where the work was.
  async who(board, [file]) {
    if (!file) throw new BoardError(2, 'usage: board who <file>')
    const rel = path.relative(projectDir(), path.resolve(file))
    const wanted = rel && !rel.startsWith('..') ? rel : file
    const hits = []
    // Archived tasks as they were, files and all.
    const whole = new Map((await board.archived()).map(t => [t.id, t]))
    for (const listed of await board.list({ all: true })) {
      const t = whole.get(listed.id) ?? listed
      // Each task once: its latest note that changed the file.
      const at = t.notes.findLastIndex(n => n.where?.files?.some(f => f === wanted || f.endsWith(`/${wanted}`)))
      if (at < 0) continue
      const n = t.notes[at]
      // A handoff the board wrote for a session that went away names that agent.
      const by = n.by === 'board' ? (t.notes.slice(0, at).findLast(m => m.by !== 'board')?.by ?? 'board') : n.by
      hits.push({ task: t.id, title: t.title, by, at: n.at, kind: n.check ? 'check' : 'handoff', where: n.where })
    }
    return { file: wanted, hits: hits.sort((a, b) => b.at.localeCompare(a.at)) }
  },
  // Run a check on a task you hold, in this checkout; record it only if it
  // passes. --passed records a check you ran yourself, without running it.
  async check(board, [id, cmd], flags) {
    if (!id || !cmd) throw new BoardError(2, 'usage: board check <id> "<command>" [--passed]')
    const actor = await actorOf(board, flags)
    await holding(board, id, actor)
    const ran = !flags.passed
    if (ran) {
      // Its output goes to stderr, so stdout stays the board's answer (and
      // --json stays JSON).
      const run = await keepingClaim(board, actor, cmd, ['ignore', 2, 2])
      if (run.status !== 0)
        throw new BoardError(8, `check failed: ${cmd} ${run.status === null ? `was stopped (${run.signal ?? run.error?.message})` : `exited ${run.status}`}; nothing recorded`)
    }
    return board.check(id, actor, { cmd, ran, where: whereNow() })
  },
  // board run <id> -- <command>: run any command on a task you hold, keeping
  // the claim alive however long it takes. Nothing is recorded (that is
  // board check); its output is its own, and board exits with its exit code.
  async run(board, [id, ...words], flags) {
    const cmd = words.join(' ')
    if (!id || !cmd) throw new BoardError(2, 'usage: board run <id> -- <command>')
    const actor = await actorOf(board, flags)
    await holding(board, id, actor)
    const run = await keepingClaim(board, actor, cmd, 'inherit')
    const t = await board.show(id)
    const still = t.claim?.owner === actor ? `${t.id} is still yours until ${hhmm(t.claim.expiresAt)}` : `${t.id} is no longer yours`
    console.error(`board: ${cmd} ${run.status === null ? `was stopped (${run.signal ?? run.error?.message})` : `exited ${run.status}`}; ${still}`)
    process.exit(run.status ?? 1)
  },
  done: async (board, [id], flags) => board.done(id, await actorOf(board, flags), text(flags.note), { review: !!flags.review }),
  'release-all': async (board, _, flags) => board.releaseAll(await actorOf(board, flags), { handoff: text(flags.handoff), session: text(flags.session), where: whereNow() }),
  register(board, [name], flags) {
    const session = text(flags.session)
    if (!name || !session) throw new BoardError(2, 'usage: board register <name> --session <id>')
    return board.register(name, session)
  },
  // A name from what the session runs and when it joined: "claude 1".
  join(board, [kind], flags) {
    const session = text(flags.session)
    if (!kind || !session) throw new BoardError(2, 'usage: board join <claude|codex|...> --session <id>')
    return board.join(kind, session)
  },
  whoami: async (board, _, flags) => ({ name: await actorOf(board, flags) }),
  agents: board => board.agents(),
  // Everything a display needs, in one call: every task and the live agents.
  // A done task comes with its last note only (who finished it, and how): a
  // display polls this every few seconds, and done tasks pile up.
  view: async board => ({
    tasks: (await board.list({ all: true })).map(t => (t.status === 'done' ? { ...t, notes: t.notes.slice(-1) } : t)),
    agents: await board.agents(),
  }),
  events: (board, [since]) => board.events(Number(since ?? 0)),
  // Follow the board as it changes, one line an event (--json: one JSON
  // object a line), until stopped. From now on, or from --since <seq> (0 for
  // everything). For scripts that act on what happens: post to a chat, start
  // an agent. The board itself never does.
  async tail(board, _, flags) {
    const all = await board.events(0)
    let since = flags.since === undefined ? (all.at(-1)?.seq ?? 0) : Number(text(flags.since))
    if (!Number.isInteger(since) || since < 0) throw new BoardError(2, '--since takes an event number: 0 for everything')
    for (;;) {
      for (const e of await board.events(since)) {
        console.log(flags.json ? JSON.stringify(e) : said(e))
        since = e.seq
      }
      await sleep(500)
    }
  },
  doctor: async (board, _, __, store) => ({ block: store, ...(await board.doctor()) }),
  where: () => DIR,
  // Your own storage blocks, in your blocks folder (never the project's):
  //   board block add <file or folder> [--name n]   install one; asks first
  //   board block list                               what is installed
  //   board block remove <name>
  // A project's config.json can name only what is installed here. Adding asks
  // a person at a terminal: an agent's shell has none, so an agent talked
  // into it by a repo's text can't install that repo's code.
  async block(_, [sub, arg], flags) {
    // What's installed, and which one this board names.
    if (sub === 'list') return { ...listBlocks(), board: storeStatus(DIR) }
    if (sub === 'remove') {
      if (!arg) throw new BoardError(2, 'usage: board block remove <name>')
      return { removed: removeBlock(arg).name }
    }
    if (sub !== 'add' || !arg) throw new BoardError(2, 'usage: board block add <file or folder> [--name <name>] | board block list | board block remove <name>')
    const plan = blockPlan(arg, text(flags.name))
    if (!process.stdin.isTTY || !process.stderr.isTTY)
      throw new BoardError(2, `board block add asks a person to confirm, at a terminal. Read ${plan.from}, then run board block add yourself`)
    const shown = plan.files.slice(0, 20)
    console.error(
      [
        `Install storage block "${plan.name}" from ${plan.from}`,
        `into ${blocksDir()}?`,
        ...(plan.files.length ? [`its code (${plan.files.length} files):`, ...shown.map(f => `  ${path.relative(process.cwd(), f) || f}`), ...(plan.files.length > shown.length ? [`  … ${plan.files.length - shown.length} more`] : [])] : []),
        'It runs with modBOARD\'s own access: your files, environment and network.',
        `Any board whose config.json says "store": "${plan.name}" will run it.`,
      ].join('\n'),
    )
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    // Ctrl+D or Ctrl+C is a no.
    const answer = await rl
      .question('Install it? Type yes: ')
      .catch(() => '')
      .finally(() => rl.close())
    if (answer.trim().toLowerCase() !== 'yes') throw new BoardError(2, 'not installed; nothing changed')
    return installBlock(arg, text(flags.name))
  },
  // Ready-made blocks: reviewed commands that show a line about this project.
  //   board blocks                 the ones you turned on, with their lines now
  //   board blocks --all           every block, on or off (nothing runs)
  //   board blocks on <id>         turn one on (off: off), in your own settings
  //   board blocks run <id>        one block's line, for a display that polls
  //   board blocks add <name> --run "<command>" [--title T] [--every 30s]
  //                                one of your own: a command's first line, in
  //                                every display; asks you at a terminal first
  //   board blocks remove <name>
  // Which are on, and your own, are yours (~/.config/modboard/settings.json);
  // a project can't add or turn one on. Each runs in this checkout, so it is
  // about this project.
  async blocks(_, [sub, id], flags) {
    if (sub === 'add') {
      const line = text(flags.run)
      if (!id || !line) throw new BoardError(2, 'usage: board blocks add <name> --run "<command>" [--title <title>] [--every 30s]')
      const every = duration(flags.every, 'every')
      const secrets = secretFlags(flags.secret)
      if (!process.stdin.isTTY || !process.stderr.isTTY)
        throw new BoardError(2, `board blocks add asks a person to confirm, at a terminal: run it yourself to add "${id}"`)
      console.error(
        [
          `Add your own block "${id}", which runs:`,
          `  ${line}`,
          `every ${Math.round((every ?? 30_000) / 1000)}s while a display shows the board, in whichever project it shows,`,
          'with your access: your files, environment and network. It shows the first line it prints.',
          ...(Object.keys(secrets).length ? [`It gets ${Object.entries(secrets).map(([k, v]) => `$${k} from secret ${v}`).join(', ')}.`] : []),
        ].join('\n'),
      )
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
      const answer = await rl
        .question('Add it? Type yes: ')
        .catch(() => '')
        .finally(() => rl.close())
      if (answer.trim().toLowerCase() !== 'yes') throw new BoardError(2, 'not added; nothing changed')
      try {
        return addCommandBlock(id, line, { title: text(flags.title), every, secrets })
      } catch (err) {
        throw new BoardError(err.code ?? 2, err.message)
      }
    }
    // board blocks network off|on: every block's network, at once (yours,
    // which are shell commands, aren't limited by this).
    if (sub === 'network') {
      if (id !== 'on' && id !== 'off') return { network: networkOff() ? 'off' : 'on' }
      return setNetwork(id === 'on')
    }
    if (sub === 'remove') {
      if (!id) throw new BoardError(2, 'usage: board blocks remove <name>')
      try {
        return removeCommandBlock(id)
      } catch (err) {
        throw new BoardError(err.code ?? 2, err.message)
      }
    }
    if (sub === 'on' || sub === 'off') {
      if (!id) throw new BoardError(2, `usage: board blocks ${sub} <id>`)
      try {
        return setEnabled(id, sub === 'on')
      } catch (err) {
        throw new BoardError(err.code ?? 2, err.message)
      }
    }
    const opts = { tasks: boardTasks }
    if (sub === 'run') {
      if (!id || !blockById(id)) throw new BoardError(id ? 4 : 2, id ? `no block "${id}"; board blocks --all lists them` : 'usage: board blocks run <id>')
      return runBlock(id, process.cwd(), opts)
    }
    if (sub) throw new BoardError(2, 'usage: board blocks [--all] | board blocks on|off|run <id> | board blocks add <name> --run "<command>" | board blocks remove <name> | board blocks network on|off')
    if (flags.all) return { all: registry(), ...(networkOff() ? { networkOff: true } : {}) }
    // Every block that's on, at once: one that is slow or fails holds up none of the others.
    return { lines: await Promise.all(enabledIds().map(b => runBlock(b, process.cwd(), opts))) }
  },
  // board secret set <name> [--stdin] | board secret remove <name> | board secret list
  // A secret for your blocks (an API token), kept in the OS keychain. Set
  // asks for it at a terminal, not shown as you type (--stdin reads it from a
  // pipe instead); it never goes in an argument, a file or your history.
  // There is no command that prints one back.
  async secret(_, [sub, name], flags) {
    const ok = f => {
      try {
        return f()
      } catch (err) {
        throw new BoardError(typeof err.code === 'number' ? err.code : 3, err.message)
      }
    }
    if (sub === 'list') return { secrets: secretNames() }
    if (sub === 'remove') {
      if (!name) throw new BoardError(2, 'usage: board secret remove <name>')
      const r = ok(() => removeSecret(name))
      rememberSecret(name, false)
      return r
    }
    if (sub !== 'set' || !name) throw new BoardError(2, 'usage: board secret set <name> [--stdin] | board secret remove <name> | board secret list')
    let value
    if (flags.stdin) value = (await readAll(process.stdin)).replace(/\r?\n$/, '')
    else if (process.stdin.isTTY && process.stderr.isTTY) value = await askHidden(`Secret ${name} (not shown): `)
    else throw new BoardError(2, 'board secret set asks at a terminal; to pipe the value in, add --stdin')
    const r = ok(() => setSecret(name, value))
    rememberSecret(name, true)
    return r
  },
  // board weather <place> [--fahrenheit] | board weather off | board weather
  // The place for the weather block, in your settings, and turns it on. A
  // name is looked up once at Open-Meteo; "12.97,77.59" is used as it is.
  async weather(_, words, flags) {
    const said = words.join(' ').trim()
    if (!said) return { weather: weatherSettings()?.name ?? null, fahrenheit: weatherSettings()?.fahrenheit ?? false }
    if (said === 'off') return setWeather(null)
    let place
    try {
      place = await findPlace(said)
    } catch (err) {
      throw new BoardError(3, `couldn't reach Open-Meteo to find "${said}" (${err.message}); try latitude,longitude`)
    }
    if (!place) throw new BoardError(4, `no place called "${said}"; try a city, or latitude,longitude`)
    return setWeather(place, { fahrenheit: !!flags.fahrenheit })
  },
  // The project's own task.md, for display; it never touches the board.
  taskfile: () => readTaskFile(process.env.BOARD_TASKFILE_DIR ?? projectDir()),
  // board antigravity [--dir <project>]: install (or update) modBOARD's side
  // panel in Antigravity, which doesn't draw MCP Apps but runs plugins with a
  // panel. The panel shows the conversation's project's board when it has
  // one, else this one: --dir, or the project this is run in.
  // Copies integrations/antigravity/modboard into its plugins folder and names
  // this install in the panel's settings, so updating modboard updates it.
  antigravity: (_, __, flags) => installAntigravity(flags),
  // board serve [--port 4477] [--dir <project>] [--open] [--read-only]: the
  // board as a dashboard in your own browser, this machine only, the same page
  // the apps draw. Its buttons act for you (BOARD_AGENT, else "human"), as
  // board mcp's do; --read-only turns them off. Runs until stopped.
  async serve(board, _, flags) {
    const port = flags.port === undefined ? 4477 : typeof flags.port === 'string' && /^\d+$/.test(flags.port) ? Number(flags.port) : NaN
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new BoardError(2, 'usage: board serve [--port 4477] [--dir <project>] [--open] [--read-only]')
    const me = process.env.BOARD_AGENT || 'human'
    const act = flags['read-only'] ? undefined : boardActions(board, me)
    let url
    try {
      url = await listen(createBench(boardBlocks(board, act ? me : undefined), { act }), port)
    } catch (err) {
      throw new BoardError(2, err.code === 'EADDRINUSE' ? `port ${port} is in use; try board serve --port <another>` : err.message)
    }
    console.log(`modBOARD at ${url}  (this machine only; ${act ? `its buttons act as ${me}` : 'read-only'}; Ctrl-C stops it)`)
    if (flags.open) openInBrowser(url)
    return new Promise(() => {})
  },
  // board mcp [--dir <project>]: the board as a local MCP server on stdio, drawn as an MCP App
  // where the host can (codex mcp add modboard -- board mcp). Its buttons act
  // for the person, as BOARD_AGENT, else "human". stdout carries the protocol
  // only, so it exits when the host hangs up.
  async mcp(board) {
    const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const me = process.env.BOARD_AGENT || 'human'
    await runStdio(createMcp({ read: boardBlocks(board, me), act: boardActions(board, me), version }))
    process.exit(0)
  },
}

// The flags each command reads, besides --as and --json, which every command
// takes. Anything else is refused: a guessed flag (--description for --desc)
// would otherwise be dropped without a word, and the task saved without it.
const FLAGS = {
  list: ['all', 'ready', 'label'],
  add: ['desc', 'accept', 'ring', 'after', 'label'],
  claim: ['next', 'label', 'wait', 'lease'],
  heartbeat: ['lease'],
  tail: ['since'],
  ring: ['off'],
  release: ['handoff'],
  check: ['passed'],
  run: [],
  block: ['name'],
  blocks: ['all', 'run', 'title', 'every', 'secret'],
  secret: ['stdin'],
  serve: ['port', 'dir', 'open', 'read-only'],
  mcp: ['dir'],
  antigravity: ['dir'],
  weather: ['fahrenheit'],
  done: ['note', 'review'],
  'release-all': ['handoff', 'session'],
  register: ['session'],
  join: ['session'],
}

function checkFlags(cmd, flags) {
  const known = ['as', 'json', ...(FLAGS[cmd] ?? [])]
  const unknown = Object.keys(flags).filter(f => !known.includes(f))
  if (unknown.length)
    throw new BoardError(
      2,
      `${cmd} doesn't take ${unknown.map(f => `--${f}`).join(', ')}; it takes ${known.map(f => `--${f}`).join(', ')}`,
    )
}

// Commands that read no board, so no storage block is loaded for them.
// Commands that work but aren't offered yet.
const HIDDEN = new Set(['secret'])

const BOARDLESS = new Set(['where', 'taskfile', 'block', 'blocks', 'antigravity', 'weather', 'secret'])
// Displays act for a person, who has no process to watch: their claims end by
// lease alone, not when the app showing the board quits (lib/holder.mjs).
const DISPLAYS = new Set(['serve', 'mcp'])

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { pos, flags } = parseArgs(rest)
  const run = commands[cmd]
  if (!run) {
    // Kept out of the list: secrets wait for a block that needs a key (plan 4.1).
    const listed = Object.keys(commands).filter(c => !HIDDEN.has(c))
    console.error(`usage: board <${listed.join('|')}> ...   (--json for machine output)`)
    process.exit(2)
  }
  try {
    checkFlags(cmd, flags)
    const { store, name } = BOARDLESS.has(cmd) ? { store: null, name: '' } : await loadStore(DIR)
    const board =
      store &&
      createEngine(store, {
        leaseMs: LEASE_MS,
        presenceMs: Number(process.env.BOARD_PRESENCE_MS ?? 3 * 60 * 1000),
        holder: DISPLAYS.has(cmd) ? undefined : createHolder(),
      })
    const out = await run(board, pos, flags, name)
    const say = !flags.json && SAY[cmd]
    console.log(say ? say(out) : flags.json || typeof out !== 'string' ? JSON.stringify(out, null, 2) : out)
  } catch (err) {
    if (!(err instanceof BoardError)) throw err
    if (flags.json) console.log(JSON.stringify({ error: err.message, code: err.code }))
    else console.error(`board: ${err.message}`)
    process.exit(err.code)
  }
}

main()
