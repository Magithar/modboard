// The board's rules, written once. Storage is a Store (see lib/store-file.mjs
// for the contract): the engine reads a snapshot, decides, and commits its
// writes conditionally, each guarded by the version it read. A commit that
// finds a version moved fails as a whole and the engine decides again from a
// fresh snapshot. That is the one property every backend must give: local
// files under a lock, or a database in one transaction.

export class BoardError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const ATTEMPTS = 50

export function createEngine(store, { leaseMs = 15 * 60 * 1000, presenceMs = 3 * 60 * 1000 } = {}) {
  async function transact(decide) {
    for (let i = 0; i < ATTEMPTS; i++) {
      const snap = await store.snapshot()
      const tx = newTx(snap, await store.now())
      settle(snap, tx, presenceMs)
      const result = decide(tx)
      if (tx.writes.length || tx.events.length) {
        const committed = await store.commit({ writes: tx.writes, events: tx.events })
        if (!committed.ok) {
          await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 20))
          continue
        }
      }
      if (tx.refusal) throw tx.refusal
      return result
    }
    throw new BoardError(3, 'the board is busy; try again')
  }

  const lease = tx => new Date(tx.now + leaseMs).toISOString()
  const stamp = tx => new Date(tx.now).toISOString()

  // Working on the board is a sign of life too, for an agent that registered.
  function seen(tx, actor) {
    const agent = tx.agent(actor)
    if (agent) tx.put('agent', actor, { ...agent, lastSeen: tx.now })
  }

  function owned(tx, id, actor) {
    const t = tx.task(id)
    if (t.status !== 'claimed' || t.claim.owner !== actor)
      throw new BoardError(5, `${t.id} is not claimed by ${actor}${t.claim ? ` (owner: ${t.claim.owner})` : ''}`)
    return t
  }

  return {
    list: ({ all = false } = {}) =>
      transact(tx => tx.tasks().filter(t => all || t.status !== 'done')),

    show: id => transact(tx => tx.task(id)),

    // `ring`: the person wants to hear when it is done; a display that can
    // (the Claude mod) rings an alarm then, whoever finished it.
    add: (actor, { title, description = '', accept = '', ring = false }) =>
      transact(tx => {
        const id = `T-${String(tx.nextNumber()).padStart(3, '0')}`
        const task = { id, title, description, accept, ...(ring ? { ring: true } : {}), status: 'todo', claim: null, notes: [], createdBy: actor }
        tx.put('task', id, task)
        tx.event(actor, 'add', id)
        return task
      }),

    // Flag a task to ring when it is done, or (on = false) take the flag off.
    ring: (id, actor, on = true) =>
      transact(tx => {
        const t = tx.task(id)
        const { ring: _, ...rest } = t
        tx.put('task', t.id, on ? { ...rest, ring: true } : rest)
        tx.event(actor, on ? 'ring' : 'unring', t.id)
        return tx.task(t.id)
      }),

    claim: (id, actor) =>
      transact(tx => {
        const t = tx.task(id)
        if (t.status === 'done') throw new BoardError(5, `${t.id} is done`)
        if (t.status === 'claimed' && t.claim.owner !== actor) {
          // A lost race is evidence too: keep it in the ledger, not only in a transcript.
          tx.event(actor, 'claim-rejected', t.id, { holder: t.claim.owner })
          tx.refusal = new BoardError(6, `${t.id} is already claimed by ${t.claim.owner} until ${new Date(t.claim.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
          return null
        }
        const claimed = { ...t, status: 'claimed', claim: { owner: actor, since: t.claim?.since ?? stamp(tx), expiresAt: lease(tx) } }
        tx.put('task', t.id, claimed)
        tx.event(actor, 'claim', t.id)
        seen(tx, actor)
        return claimed
      }),

    // Renew every lease this actor holds, and its presence.
    heartbeat: actor =>
      transact(tx => {
        const mine = tx.tasks().filter(t => t.claim?.owner === actor)
        for (const t of mine) tx.put('task', t.id, { ...t, claim: { ...t.claim, expiresAt: lease(tx) } })
        const agent = tx.agent(actor)
        if (agent) tx.put('agent', actor, { ...agent, lastSeen: tx.now })
        return { renewed: mine.map(t => t.id) }
      }),

    note: (id, actor, text) =>
      transact(tx => {
        const t = owned(tx, id, actor)
        tx.put('task', t.id, { ...t, notes: [...t.notes, { at: stamp(tx), by: actor, text }], claim: { ...t.claim, expiresAt: lease(tx) } })
        tx.event(actor, 'note', t.id)
        seen(tx, actor)
        return tx.task(t.id)
      }),

    // A check that passed on a task you hold: what was run, and where (the
    // worktree, branch and commit it ran at). `ran` says the board ran it itself;
    // false means the agent ran it and reports that it passed.
    check: (id, actor, { cmd, ran = false, where }) =>
      transact(tx => {
        const t = owned(tx, id, actor)
        const note = { at: stamp(tx), by: actor, text: `CHECKED: ${cmd}`, check: { cmd, ran }, ...(where ? { where } : {}) }
        tx.put('task', t.id, { ...t, notes: [...t.notes, note], claim: { ...t.claim, expiresAt: lease(tx) } })
        tx.event(actor, 'check', t.id)
        seen(tx, actor)
        return tx.task(t.id)
      }),

    // `where` is the checkout the work sits in, so the next agent can pick it up there.
    release: (id, actor, handoff, where) =>
      transact(tx => {
        const t = owned(tx, id, actor)
        const notes = handoff ? [...t.notes, { at: stamp(tx), by: actor, text: `HANDOFF: ${handoff}`, ...(where ? { where } : {}) }] : t.notes
        tx.put('task', t.id, { ...t, status: 'todo', claim: null, notes })
        tx.event(actor, 'release', t.id)
        return tx.task(t.id)
      }),

    // Done means verified: the note says how, against the task's acceptance if it has one.
    done: (id, actor, note) =>
      transact(tx => {
        const t = owned(tx, id, actor)
        if (!note?.trim())
          throw new BoardError(2, `done needs --note saying how you verified ${t.id}` + (t.accept ? ` against: ${t.accept}` : ''))
        tx.put('task', t.id, { ...t, status: 'done', claim: null, notes: [...t.notes, { at: stamp(tx), by: actor, text: `VERIFIED: ${note}` }] })
        tx.event(actor, 'done', t.id)
        return tx.task(t.id)
      }),

    // Free everything this actor holds and give up its name, e.g. when its session ends.
    releaseAll: (actor, { handoff, session, where } = {}) =>
      transact(tx => {
        const text = `HANDOFF: ${handoff ?? `${actor} ended without releasing; read the notes above`}`
        const mine = tx.tasks().filter(t => t.claim?.owner === actor)
        for (const t of mine) {
          tx.put('task', t.id, { ...t, status: 'todo', claim: null, notes: [...t.notes, { at: stamp(tx), by: actor, text, ...(where ? { where } : {}) }] })
          tx.event(actor, 'release', t.id)
        }
        const agent = tx.agent(actor)
        if (agent && (!session || agent.session === session)) tx.put('agent', actor, null)
        return { released: mine.map(t => t.id) }
      }),

    // Take or keep a name. Refused while another live session holds it, since two
    // sessions under one name would share every claim.
    register: (name, session) =>
      transact(tx => {
        const agent = tx.agent(name)
        if (agent && agent.session !== session && tx.now - agent.lastSeen < presenceMs)
          throw new BoardError(7, `the name ${name} is in use by another live session`)
        tx.put('agent', name, { session, lastSeen: tx.now })
        if (agent?.session !== session) tx.event(name, 'register', undefined, { session })
        return { name }
      }),

    // Name a session by what it runs and when it joined: "claude 1", then
    // "claude 2". A session that joined before keeps its name; otherwise it
    // gets the lowest number no session still holds. A held name belongs to a
    // live session, or to one with a claim. A session with no presence ping
    // (Codex, through the CLI) holds its name while it works the board, so
    // only its leases end its claims, never silence.
    join: (kind, session, { presence = true } = {}) =>
      transact(tx => {
        const all = tx.agentsAll()
        const mine = Object.entries(all).find(([, a]) => a.session === session)?.[0]
        const claimed = new Set(tx.tasks().filter(t => t.status === 'claimed').map(t => t.claim.owner))
        const held = (name, a) => claimed.has(name) || tx.now - a.lastSeen < (a.presence === false ? leaseMs : presenceMs)
        let name = mine
        for (let n = 1; !name; n++) if (!all[`${kind} ${n}`] || !held(`${kind} ${n}`, all[`${kind} ${n}`])) name = `${kind} ${n}`
        const agent = tx.agent(name)
        tx.put('agent', name, { session, lastSeen: tx.now, ...(presence ? {} : { presence: false }) })
        if (agent?.session !== session) tx.event(name, 'register', undefined, { session })
        return { name }
      }),

    agents: () =>
      transact(tx => Object.entries(tx.agentsLive(presenceMs)).map(([name, a]) => ({ name, lastSeen: new Date(a.lastSeen).toISOString() }))),

    events: since => store.events(since),
    doctor: () => store.verify(),
  }
}

// Expiry is a real transition, written like any other, so every reader sees it.
// A claim ends when its lease runs out, or sooner when its owner registered a
// session and that session has gone silent (killed outright, so it never said
// goodbye): no presence ping for presenceMs. An owner that never registered
// (a plain CLI agent) keeps the lease alone.
//
// An owner that recorded work on the task (a note or a check) and then went
// away left it partway, though it could write no handoff: the board writes one
// for it, so the task shows as unfinished, with the last place the work was
// seen (the latest note that carries one), marked stale, since the work may
// have moved on after. An owner that recorded nothing leaves it not started.
function settle(snap, tx, presenceMs) {
  for (const t of Object.values(snap.tasks)) {
    if (t.status !== 'claimed') continue
    const agent = snap.agents[t.claim.owner]
    const silent = agent !== undefined && agent.presence !== false && tx.now - agent.lastSeen >= presenceMs
    if (!silent && Date.parse(t.claim.expiresAt) >= tx.now) continue
    const owner = t.claim.owner
    const why = silent ? `${owner} stopped responding (its session went silent)` : `lease of ${owner} expired`
    const worked = t.notes.some(n => n.by === owner && n.at >= t.claim.since)
    const seen = [...t.notes].reverse().find(n => n.where)?.where
    const note = worked
      ? { at: new Date(tx.now).toISOString(), by: 'board', text: `HANDOFF: ${why}; read the notes above`, ...(seen ? { where: { ...seen, stale: true } } : {}) }
      : { at: new Date(tx.now).toISOString(), by: 'board', text: why }
    tx.put('task', t.id, { ...t, status: 'todo', claim: null, notes: [...t.notes, note] })
    tx.event('board', 'expire', t.id, silent ? { reason: 'silent' } : {})
  }
}

function newTx(snap, now) {
  const pending = new Map()
  const current = (kind, key) => {
    const write = pending.get(`${kind}:${key}`)
    if (write) return write.value ?? undefined
    return (kind === 'task' ? snap.tasks : snap.agents)[key]
  }
  return {
    now,
    events: [],
    refusal: null,
    get writes() {
      return [...pending.values()]
    },
    // Each write carries the version this decision read, not a later one.
    put(kind, key, value) {
      const base = (kind === 'task' ? snap.tasks : snap.agents)[key]
      pending.set(`${kind}:${key}`, { kind, key, value, expect: base?.version ?? 0 })
    },
    event(actor, type, task, extra = {}) {
      this.events.push({ actor, type, task, ...extra })
    },
    task(id) {
      const t = current('task', String(id).toUpperCase())
      if (!t) throw new BoardError(4, `no task ${id}`)
      return t
    },
    tasks() {
      return Object.keys({ ...snap.tasks, ...Object.fromEntries([...pending.values()].filter(w => w.kind === 'task').map(w => [w.key, 1])) })
        .map(id => current('task', id))
        .filter(Boolean)
        .sort((a, b) => a.id.localeCompare(b.id))
    },
    agent: name => current('agent', name),
    agentsAll: () => ({ ...snap.agents, ...Object.fromEntries([...pending.values()].filter(w => w.kind === 'agent').map(w => [w.key, w.value]).filter(([, v]) => v)) }),
    agentsLive(presenceMs) {
      return Object.fromEntries(Object.entries(snap.agents).filter(([, a]) => now - a.lastSeen < presenceMs))
    },
    nextNumber() {
      return Math.max(0, ...Object.keys(snap.tasks).map(id => Number(id.replace(/\D/g, '')) || 0)) + 1
    },
  }
}
