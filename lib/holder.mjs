// Which process holds a claim, so a CLI agent that dies frees its work at once
// instead of waiting out its lease. A Claude session says it is alive with a
// presence ping; Codex and a plain shell agent send none, so the board finds
// the agent's own long-lived process among the ancestors of the `board` call
// and keeps it on the claim. Once that process is gone, so is the agent.
//
// Every doubt falls back to the lease, never to freeing work early:
// - No ps (Windows, a sandbox that refuses it): no holder.
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

const PS = ['/bin/ps', '/usr/bin/ps'].find(p => fs.existsSync(p))

// The ancestors of this process, nearest first, up to (not including) pid 1.
function ancestors() {
  if (!PS || process.platform === 'win32') return null
  let out
  try {
    out = execFileSync(PS, ['-A', '-o', 'pid=,ppid=,lstart=,comm='], {
      encoding: 'utf8',
      env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' },
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
  const chain = []
  for (let p = procs.get(process.ppid); p && p.pid > 1 && chain.length < 64; p = procs.get(p.ppid)) chain.push(p)
  return chain
}

// The agent's process: the nearest ancestor that is not a shell and has run a while.
function pick(chain, now) {
  return chain.find(p => !SHELLS.has(p.name) && now - Date.parse(p.start) >= MIN_AGE_MS)
}

const same = (a, b) => a[0] === b[0] && a[1] === b[1]

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
      if (!here?.length) return prev
      if (prev && prev.host !== host) return { host, unknown: true }
      const chain = prev ? here.filter(p => prev.chain.some(c => same(c, [p.pid, p.start]))) : here
      if (!chain.length) return { host, unknown: true }
      const p = pick(chain, now)
      return { host, ...(p ? { pid: p.pid, name: p.name } : {}), chain: chain.map(c => [c.pid, c.start]) }
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
