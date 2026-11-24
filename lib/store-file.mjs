// The local block: a board in a directory.
//
// The Store contract every block implements (all methods may be async):
//
//   now()               the store's clock, in ms. Leases use it, so every
//                       device agrees on time (a database answers its own).
//   snapshot()          { tasks: {id: Task}, agents: {name: Agent} }, each
//                       record carrying the `version` it stands at.
//   commit({ writes, events })
//                       writes: [{ kind: 'task'|'agent', key, value|null, expect }]
//                       Applies every write and appends every event, or
//                       nothing: all-or-none, and only if each record still
//                       stands at `expect` (0 = must not exist). Answers
//                       { ok: true } or { ok: false, conflict }. Each applied
//                       record's version becomes expect + 1; null deletes.
//   events(since)       ledger events with seq > since.
//   verify()            { ok, problems, ... }: does the history match the state?
//   archived(id?)       optional. A store that keeps old done tasks as stubs
//                       (archived: true, last note only) gives one back whole,
//                       or with no id every one. Stubs are read-only.
//
// Here a commit runs under one lock per board (mkdir is atomic), the ledger
// line is appended before the state file is replaced (rename is atomic), so a
// crash between the two leaves an event the state lacks, which verify reports
// and the next commit cuts away before it appends.

import fs from 'node:fs'
import path from 'node:path'

// The entry point every block exports: the board's config.json and its folder in,
// a Store out.
export const createStore = (config, { dir }) => fileStore(dir, { archiveDays: config.archiveDays })

const STALE_LOCK_MS = 10_000
const DAY_MS = 24 * 60 * 60 * 1000

// Archiving: a task done more than archiveDays ago (BOARD_ARCHIVE_DAYS, or
// "archiveDays" in config.json; 14 by default, "off" or 0 for never) moves,
// whole, to archive.jsonl. board.json keeps a stub of it: its id, title,
// labels and links, and its last note (who finished it, and how), so
// nothing that reads done tasks changes, and every commit rewrites a small
// file. archived(id) gives the whole task back; archived() every one.
export function fileStore(dir, { archiveDays } = {}) {
  const STATE = path.join(dir, 'board.json')
  const LEDGER = path.join(dir, 'ledger.jsonl')
  const ARCHIVE = path.join(dir, 'archive.jsonl')
  const LOCK = path.join(dir, 'lock')
  const days = archiveDays ?? process.env.BOARD_ARCHIVE_DAYS ?? 14
  const ARCHIVE_MS = days === 'off' || !(Number(days) > 0) ? Infinity : Number(days) * DAY_MS

  function load() {
    if (!fs.existsSync(STATE)) return { version: 2, seq: 0, tasks: {}, agents: {} }
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    // 0.1 boards had no versions or agents.
    for (const t of Object.values(state.tasks)) t.version ??= 1
    state.agents ??= {}
    delete state.nextId
    return state
  }

  function save(state) {
    // One line, not indented: a board with thousands of tasks is rewritten on
    // every commit. Flushed to disk before the rename, so a power cut leaves
    // the old file or the new one, never an empty one.
    const tmp = `${STATE}.${process.pid}.tmp`
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeSync(fd, JSON.stringify({ ...state, version: 2 }) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, STATE)
  }

  // A holder that stalls past STALE_LOCK_MS (a sleeping laptop, a stopped
  // process) can have its lock taken. The lock carries a token, so a holder
  // checks it still owns the lock before each write and only removes its own.
  function withLock(fn) {
    fs.mkdirSync(dir, { recursive: true })
    const OWNER = path.join(LOCK, 'owner')
    const token = `${process.pid}.${Math.random().toString(36).slice(2)}`
    const mine = () => {
      try {
        return fs.readFileSync(OWNER, 'utf8') === token
      } catch {
        return false
      }
    }
    const deadline = Date.now() + 5000
    for (;;) {
      try {
        fs.mkdirSync(LOCK)
        fs.writeFileSync(OWNER, token)
        break
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
        try {
          if (Date.now() - fs.statSync(LOCK).mtimeMs > STALE_LOCK_MS) fs.rmSync(LOCK, { recursive: true, force: true })
        } catch {}
        if (Date.now() > deadline) return { ok: false, conflict: 'lock' }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.random() * 20)
      }
    }
    try {
      return fn(mine)
    } finally {
      if (mine()) fs.rmSync(LOCK, { recursive: true, force: true })
    }
  }

  // A crash mid-append can leave a half-written last line. Readers skip lines
  // that don't parse, and count them so verify can report them.
  // Done long enough ago: by its last note, the one done wrote.
  const doneAt = t => Date.parse(t.notes.at(-1)?.at ?? '') || 0

  // Move what's due from the state to the archive file. The whole task is
  // appended before the state is saved, so a crash in between archives it
  // again next time; a reader takes the last copy of each.
  function archiveDue(state, now) {
    if (ARCHIVE_MS === Infinity) return
    const due = Object.values(state.tasks).filter(t => t.status === 'done' && !t.archived && now - doneAt(t) > ARCHIVE_MS)
    if (!due.length) return
    fs.appendFileSync(ARCHIVE, due.map(t => JSON.stringify(t) + '\n').join(''))
    for (const t of due) {
      const { description: _d, accept: _a, notes, ...rest } = t
      const last = notes.at(-1)
      const stubNote = last?.where?.files ? { ...last, where: (({ files, ...w }) => w)(last.where) } : last
      state.tasks[t.id] = { ...rest, archived: true, notes: stubNote ? [stubNote] : [] }
    }
  }

  function readArchive() {
    const byId = new Map()
    if (!fs.existsSync(ARCHIVE)) return byId
    for (const line of fs.readFileSync(ARCHIVE, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const t = JSON.parse(line)
        byId.set(t.id, t)
      } catch {}
    }
    return byId
  }

  function readLedger() {
    if (!fs.existsSync(LEDGER)) return { events: [], unreadable: 0 }
    const events = []
    let unreadable = 0
    for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      if (!line) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        unreadable++
      }
    }
    return { events, unreadable }
  }

  // Events after `since`, reading the ledger back from its end only as far as
  // needed: board tail asks every half second for what is new, and the
  // ledger only grows.
  function eventsAfter(since) {
    let fd
    try {
      fd = fs.openSync(LEDGER, 'r')
    } catch (err) {
      if (err.code === 'ENOENT') return []
      throw err
    }
    try {
      const size = fs.fstatSync(fd).size
      for (let chunk = 16 * 1024; ; chunk *= 4) {
        const start = Math.max(0, size - chunk)
        const buf = Buffer.alloc(size - start)
        fs.readSync(fd, buf, 0, buf.length, start)
        const lines = buf.toString('utf8').split('\n')
        if (start > 0) lines.shift() // may begin mid-line
        const events = []
        let reached = start === 0
        for (const line of lines) {
          if (!line) continue
          try {
            const e = JSON.parse(line)
            if (typeof e.seq === 'number' && e.seq <= since) reached = true
            else events.push(e)
          } catch {}
        }
        if (reached) return events.filter(e => e.seq > since)
      }
    } finally {
      fs.closeSync(fd)
    }
  }

  // Before appending, cut from the end of the ledger what a commit wrote but
  // never saved: a half-written line, or whole events past the state's seq
  // (a crash between append and save). Left there, the next commit would glue
  // onto the broken line or reuse those seq numbers.
  function trimLedger(seq) {
    let fd
    try {
      fd = fs.openSync(LEDGER, 'r+')
    } catch (err) {
      if (err.code === 'ENOENT') return
      throw err
    }
    try {
      const size = fs.fstatSync(fd).size
      for (let chunk = 64 * 1024; ; chunk *= 2) {
        const start = Math.max(0, size - chunk)
        const buf = Buffer.alloc(size - start)
        fs.readSync(fd, buf, 0, buf.length, start)
        const lines = buf.toString('utf8').split('\n')
        let cut = size - Buffer.byteLength(lines.pop()) // text after the last newline is never whole
        if (start > 0) lines.shift() // may begin mid-line
        // A whole line is kept unless its seq is past the state's, or no later
        // than the line before it (a writer that lost the lock between its
        // last check and its append).
        const parse = line => {
          try {
            return JSON.parse(line)
          } catch {}
        }
        let found = false
        while (lines.length) {
          const line = lines.pop()
          const event = parse(line)
          const before = lines.length ? parse(lines.at(-1)) : undefined
          const numbered = typeof event?.seq === 'number'
          const orphan = numbered && ((typeof seq === 'number' && event.seq > seq) || (typeof before?.seq === 'number' && event.seq <= before.seq))
          if (event && !orphan) {
            found = true
            break
          }
          cut -= Buffer.byteLength(line) + 1
        }
        if (found || start === 0) {
          if (cut < size) fs.ftruncateSync(fd, cut)
          return
        }
      }
    } finally {
      fs.closeSync(fd)
    }
  }

  return {
    now: () => Date.now(),

    snapshot: () => {
      const { tasks, agents } = load()
      return { tasks, agents }
    },

    commit: ({ writes, events }) =>
      withLock(mine => {
        const state = load()
        const table = kind => (kind === 'task' ? state.tasks : state.agents)
        for (const w of writes) {
          if ((table(w.kind)[w.key]?.version ?? 0) !== w.expect) return { ok: false, conflict: `${w.kind}:${w.key}` }
        }
        for (const w of writes) {
          if (w.value === null) delete table(w.kind)[w.key]
          else table(w.kind)[w.key] = { ...w.value, version: w.expect + 1 }
        }
        const at = new Date().toISOString()
        const lines = events.map(e => JSON.stringify({ seq: ++state.seq, at, ...e }) + '\n').join('')
        // A lock taken from us while we stalled: write nothing, and the engine
        // decides again from a fresh snapshot.
        if (!mine()) return { ok: false, conflict: 'lock' }
        archiveDue(state, Date.now())
        if (lines) {
          trimLedger(state.seq - events.length)
          fs.appendFileSync(LEDGER, lines)
        }
        if (!mine()) return { ok: false, conflict: 'lock' }
        save(state)
        return { ok: true }
      }),

    events: (since = 0) => (since > 0 ? eventsAfter(since) : readLedger().events),

    archived: id => {
      const all = readArchive()
      return id === undefined ? [...all.values()] : (all.get(id) ?? null)
    },

    verify: () => {
      const state = load()
      const { events, unreadable } = readLedger()
      const last = events.at(-1)?.seq ?? 0
      const problems = []
      if (last !== state.seq) problems.push(`ledger is at seq ${last}, state at ${state.seq}`)
      if (unreadable) problems.push(`${unreadable} ledger ${unreadable === 1 ? 'line is' : 'lines are'} unreadable (half-written?)`)
      // Two writers that both believed they held the lock show up as a seq
      // used twice or out of order.
      let prev = 0
      for (const e of events) {
        if (typeof e.seq !== 'number') continue
        if (e.seq <= prev) problems.push(`ledger seq ${e.seq} comes after seq ${prev}`)
        prev = Math.max(prev, e.seq)
      }
      return { dir, tasks: Object.keys(state.tasks).length, events: events.length, ok: !problems.length, problems }
    },
  }
}
