#!/usr/bin/env node
// board — an agent-neutral task board. Any agent (Claude, Codex, a human)
// coordinates through this one CLI; nothing else writes the board.
//
// The board lives in <repo>/.modboard/, beside the git *common* dir so
// every worktree of a repo shares one board (BOARD_DIR overrides). A board
// made before the rename, in .agent-board/, is used where it already exists.
// Which storage block holds it is named in .modboard/config.json (see
// lib/load-store.mjs); the default is the built-in "file" block.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { BoardError, createEngine } from '../lib/engine.mjs'
import { loadStore } from '../lib/load-store.mjs'
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
    if (a.startsWith('--')) {
      const val = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true
      flags[a.slice(2)] = val
    } else pos.push(a)
  }
  return { pos, flags }
}

const text = v => (typeof v === 'string' ? v : undefined)

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
const line = t => `${SYMBOL[t.status]} ${t.id}  ${t.title}${t.claim ? `  ${t.claim.owner}` : ''}`

function describe(t) {
  const out = [line(t), '']
  if (t.description) out.push(t.description, '')
  if (t.accept) out.push(`Accept when: ${t.accept}`, '')
  if (t.claim) out.push(`claimed by ${t.claim.owner} until ${t.claim.expiresAt}`)
  for (const n of t.notes) out.push(`- [${n.at.slice(0, 16)}] ${n.by}: ${n.text}`)
  return out.join('\n')
}

const DIR = boardDir()

// Local clock time, for people: "19:45".
const hhmm = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const ids = list => (list.length ? list.join(', ') : 'nothing')

// What each command says to a person. --json prints the data instead, and
// view and events (for programs) always do.
const SAY = {
  add: t => `added ${line(t)}`,
  claim: t => `claimed ${t.id}  ${t.title}\nit's yours until ${hhmm(t.claim.expiresAt)}; a note or heartbeat renews it`,
  heartbeat: r => `renewed ${ids(r.renewed)}`,
  note: t => `noted on ${t.id}; yours until ${hhmm(t.claim.expiresAt)}`,
  release: t => `released ${t.id}${t.notes.at(-1)?.text.startsWith('HANDOFF:') ? ' with a handoff' : ''}; it's back to todo`,
  done: t => `done ${line(t)}\n${t.notes.at(-1).text}`,
  'release-all': r => `released ${ids(r.released)}`,
  register: r => `you are ${r.name}`,
  join: r => `you are ${r.name}`,
  whoami: r => `you are ${r.name}`,
  agents: list => (list.length ? list.map(a => `${a.name}  last seen ${hhmm(a.lastSeen)}`).join('\n') : '(no live agents)'),
  taskfile: r =>
    r.file
      ? [r.file, ...r.items.map(i => `${'  '.repeat(i.depth)}${i.done === null ? '-' : i.done ? '[x]' : '[ ]'} ${i.priority === null ? '' : `P${i.priority} `}${i.text}`)].join('\n')
      : '(no task.md here)',
  doctor: r =>
    [`storage block: ${r.block}`, ...(r.tasks !== undefined ? [`${r.tasks} ${r.tasks === 1 ? 'task' : 'tasks'}, ${r.events ?? '?'} events`] : []), r.ok ? 'ok: the ledger and the state agree' : 'problems:', ...r.problems.map(p => `- ${p}`)].join('\n'),
}

const commands = {
  async list(board, _, flags) {
    const tasks = await board.list({ all: !!flags.all })
    if (flags.json) return tasks
    return tasks.length ? tasks.map(line).join('\n') : '(no open tasks)'
  },
  async show(board, [id], flags) {
    const t = await board.show(id)
    return flags.json ? t : describe(t)
  },
  async add(board, [title], flags) {
    if (!title) throw new BoardError(2, 'usage: board add "<title>" [--desc "..."] [--accept "how to tell it is done"]')
    const by = text(flags.as) ?? process.env.BOARD_AGENT ?? (process.env.CODEX_THREAD_ID ? await actorOf(board, flags) : 'human')
    return board.add(by, {
      title,
      description: text(flags.desc),
      accept: text(flags.accept),
    })
  },
  claim: async (board, [id], flags) => board.claim(id, await actorOf(board, flags)),
  heartbeat: async (board, _, flags) => board.heartbeat(await actorOf(board, flags)),
  async note(board, [id, note], flags) {
    if (!note) throw new BoardError(2, 'usage: board note <id> "<text>"')
    return board.note(id, await actorOf(board, flags), note)
  },
  release: async (board, [id], flags) => board.release(id, await actorOf(board, flags), text(flags.handoff)),
  done: async (board, [id], flags) => board.done(id, await actorOf(board, flags), text(flags.note)),
  'release-all': async (board, _, flags) => board.releaseAll(await actorOf(board, flags), { handoff: text(flags.handoff), session: text(flags.session) }),
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
  view: async board => ({ tasks: await board.list({ all: true }), agents: await board.agents() }),
  events: (board, [since]) => board.events(Number(since ?? 0)),
  doctor: async (board, _, __, store) => ({ block: store, ...(await board.doctor()) }),
  where: () => DIR,
  // The project's own task.md, for display; it never touches the board.
  taskfile: () => readTaskFile(process.env.BOARD_TASKFILE_DIR ?? projectDir()),
}

// The flags each command reads, besides --as and --json, which every command
// takes. Anything else is refused: a guessed flag (--description for --desc)
// would otherwise be dropped without a word, and the task saved without it.
const FLAGS = {
  list: ['all'],
  add: ['desc', 'accept'],
  release: ['handoff'],
  done: ['note'],
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
const BOARDLESS = new Set(['where', 'taskfile'])

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
        leaseMs: Number(process.env.BOARD_LEASE_MS ?? 15 * 60 * 1000),
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
