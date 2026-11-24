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
import path from 'node:path'
import readline from 'node:readline/promises'

import { BoardError, createEngine } from '../lib/engine.mjs'
import { blockPlan, blocksDir, installBlock, listBlocks, loadStore, removeBlock } from '../lib/load-store.mjs'
import { readTaskFile } from '../lib/taskfile.mjs'

function boardDir() {
  if (process.env.BOARD_DIR) return path.resolve(process.env.BOARD_DIR)
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return inside(path.dirname(common))
  } catch {
    return inside(process.cwd())
  }
}

// The checkout the command runs in (its own worktree, not the shared board's
// repo), else the current directory: where a task.md is looked for.
function projectDir() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return process.cwd()
  }
}

// Where the work is: the worktree this command runs in, its branch, the commit
// it is at, whether anything is uncommitted, and the files the work changed.
// Nothing outside a git repo.
const FILES_KEPT = 50
function whereNow() {
  const raw = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
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
// joined. Codex sends no presence ping, so only its leases end its claims.
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

const DIR = boardDir()
const LEASE_MS = Number(process.env.BOARD_LEASE_MS ?? 15 * 60 * 1000)

// Local clock time, for people: "19:45".
const hhmm = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const ids = list => (list.length ? list.join(', ') : 'nothing')

// What each command says to a person. --json prints the data instead, and
// view and events (for programs) always do.
const SAY = {
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
const said = e => `${hhmm(e.at)}  ${e.actor}  ${DID[e.type] ?? e.type}${e.task ? ` ${e.task}` : ''}${e.holder ? ` (held by ${e.holder})` : ''}${e.reason === 'silent' ? ' (its session went silent)' : ''}`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
    if (sub === 'list') return listBlocks()
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
  // The project's own task.md, for display; it never touches the board.
  taskfile: () => readTaskFile(process.env.BOARD_TASKFILE_DIR ?? projectDir()),
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
const BOARDLESS = new Set(['where', 'taskfile', 'block'])

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { pos, flags } = parseArgs(rest)
  const run = commands[cmd]
  if (!run) {
    console.error(`usage: board <${Object.keys(commands).join('|')}> ...   (--json for machine output)`)
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
