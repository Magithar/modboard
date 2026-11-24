// Which process holds a claim, so a CLI agent that dies frees its work at once
// instead of waiting out its lease. A Claude session says it is alive with a
// presence ping; Codex and a plain shell agent send none, so the board finds
// the agent's own long-lived process among the ancestors of the `board` call
// and keeps it on the claim. Once that process is gone, so is the agent.
//
// Every doubt falls back to the lease, never to freeing work early:
// - No ps (Windows, a sandbox that refuses it): no holder, except for Codex.
//
// Codex runs commands in a sandbox that hides every other process, so from
// inside it the board can't see Codex. What it can record is the Codex thread
// (CODEX_THREAD_ID). Codex keeps that thread's session file open while it
// runs, so the next reader that can see processes (the Claude pane, a person
// at a shell) asks lsof which process has the file open, and keeps that one.
// - Shells and processes started moments ago are passed over: a shell is
//   often started for one command, and so is a wrapper (npx, make, timeout).
// - Each later call by the owner keeps only the ancestors the earlier calls
//   shared, so a wrapper seen once drops out and the agent remains.
// - An agent that started moments before it claimed is found on a later call.
// - Calls from two process trees, or two machines, under one name: the claim
//   is marked unknown for good, and only its lease ends it.
// - A process still answering is alive, even if its id was reused.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'mksh', 'tcsh', 'csh', 'fish', 'nu', 'xonsh', 'elvish', 'pwsh', 'busybox'])

// How long a process must have run before it can hold a claim. Kept low in
// tests (BOARD_HOLDER_AGE_MS), where the fake agent starts just before it claims.
const MIN_AGE_MS = Number(process.env.BOARD_HOLDER_AGE_MS ?? 10_000)

// BOARD_HOLDER_PS='' stands in for a sandbox in tests.
const PS = process.env.BOARD_HOLDER_PS ?? ['/bin/ps', '/usr/bin/ps'].find(p => fs.existsSync(p))
const LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof', '/usr/local/bin/lsof'].find(p => fs.existsSync(p))
const TOOL_ENV = { PATH: '/bin:/usr/bin:/usr/sbin', LC_ALL: 'C' }

// Every process on this machine by id, or null when they can't be seen.
let seenProcs
function processes() {
  if (seenProcs !== undefined) return seenProcs
  seenProcs = null
  if (!PS || process.platform === 'win32') return null
  let out
  try {
    out = execFileSync(PS, ['-A', '-o', 'pid=,ppid=,lstart=,comm='], {
      encoding: 'utf8',
      env: TOOL_ENV,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
  } catch {
    return null
  }
  const procs = new Map()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line)
    if (m) procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), start: m[3].replace(/\s+/g, ' '), name: path.basename(m[4].trim()).replace(/^-/, '') })
  }
  return (seenProcs = procs.size ? procs : null)
}

// The ancestors of this process, nearest first, up to (not including) pid 1.
function ancestors() {
  const procs = processes()
  if (!procs) return null
  const chain = []
  for (let p = procs.get(process.ppid); p && p.pid > 1 && chain.length < 64; p = procs.get(p.ppid)) chain.push(p)
  return chain
}

// The agent's process: the nearest ancestor that is not a shell and has run a while.
function pick(chain, now) {
  return chain.find(p => !SHELLS.has(p.name) && now - Date.parse(p.start) >= MIN_AGE_MS)
}

const same = (a, b) => a[0] === b[0] && a[1] === b[1]

const THREAD = /^[0-9a-f][0-9a-f-]{7,63}$/i

// The session file Codex keeps open for a thread: sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl,
// looked for in the newest two weeks of days.
function sessionFile(home, thread) {
  const root = path.join(home, 'sessions')
  const sub = dir => {
    try {
      return fs.readdirSync(dir).sort().reverse()
    } catch {
      return []
    }
  }
  let days = 0
  for (const y of sub(root))
    for (const m of sub(path.join(root, y)))
      for (const d of sub(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d)
        const hit = sub(dir).find(f => f.startsWith('rollout-') && f.endsWith(`-${thread}.jsonl`))
        if (hit) return path.join(dir, hit)
        if (++days >= 14) return null
      }
  return null
}

// Which processes have a file open: ids, or null when lsof can't say.
function openers(file) {
  if (!LSOF) return null
  try {
    const out = execFileSync(LSOF, ['-t', '--', file], { encoding: 'utf8', env: TOOL_ENV, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
    return out.split('\n').map(Number).filter(n => n > 0)
  } catch (err) {
    // lsof exits 1, saying nothing, when no process has the file open.
    return err.status === 1 && !String(err.stdout ?? '').trim() ? [] : null
  }
}

export function createHolder() {
  let here
  // The machine, hashed: the board file need not carry its name.
  const host = createHash('sha256').update(os.hostname()).digest('hex').slice(0, 12)
  return {
    // The holder to keep on a claim, given the one it had (from this owner).
    // `unknown` is for good: the owner called from two process trees or machines.
    hold(prev, now) {
      if (prev?.unknown) return prev
      here ??= ancestors()
      const thread = process.env.CODEX_THREAD_ID
      if (thread && THREAD.test(thread)) {
        if (prev?.codex === thread && prev.pid) return prev
        const codex = here?.find(p => p.name === 'codex')
        if (codex) return { host, codex: thread, pid: codex.pid, name: 'codex' }
        // In Codex's sandbox: a reader that can see processes finds it (resolve).
        return { host, codex: thread, ...(process.env.CODEX_HOME ? { home: process.env.CODEX_HOME } : {}) }
      }
      if (!here?.length) return prev
      if (prev && prev.host !== host) return { host, unknown: true }
      const chain = prev ? here.filter(p => (prev.chain ?? []).some(c => same(c, [p.pid, p.start]))) : here
      if (!chain.length) return { host, unknown: true }
      const p = pick(chain, now)
      return { host, ...(p ? { pid: p.pid, name: p.name } : {}), chain: chain.map(c => [c.pid, c.start]) }
    },

    // A Codex holder recorded from inside its sandbox, with the process that
    // has its session file open filled in; null when it can't be told from
    // here (another machine, or a reader that can't see processes either).
    // Nothing has it open: Codex has gone already, or keeps its file another
    // way; either way only the lease is sure, so the holder becomes unknown.
    resolve(h) {
      if (!h?.codex || h.pid || h.unknown || h.host !== host || !processes()) return null
      const file = sessionFile(h.home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), h.codex)
      if (!file) return { host, unknown: true }
      const pids = openers(file)
      if (!pids) return null
      const procs = processes()
      const p = pids.map(id => procs.get(id)).filter(Boolean).sort((a, b) => (b.name === 'codex') - (a.name === 'codex'))[0]
      return p ? { host, codex: h.codex, pid: p.pid, name: p.name } : { host, unknown: true }
    },

    // True only when the holder's process is surely gone: on this machine, and
    // no process answers to its id.
    gone(holder) {
      if (!holder?.pid || holder.host !== host) return false
      try {
        process.kill(holder.pid, 0)
        return false
      } catch (err) {
        return err.code === 'ESRCH'
      }
    },
  }
}
