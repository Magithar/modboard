export type Task = {
  id: string
  title: string
  description: string
  accept?: string
  // Ring an alarm when it is done (board add --ring, board ring <id>).
  ring?: boolean
  // Tasks this one waits on (board add --after); it can't be claimed until
  // they are done. `waitingOn`, worked out on each read, is those still open.
  after?: string[]
  waitingOn?: string[]
  // "kind=bug", "area=api" or a plain word (board add --label).
  labels?: string[]
  // A review task (board done --review) names the task it reviews.
  reviewOf?: string
  status: 'todo' | 'claimed' | 'done'
  // `leaseMs`: a lease length the claim asked for (claim --lease 1h).
  claim: { owner: string; since: string; expiresAt: string; leaseMs?: number } | null
  notes: Note[]
}

// Where work sits: the checkout a handoff or check was made in.
// `stale`: the last place the work was seen, written by the board for a session
// that went away without a handoff; the work may have moved on since.
// `files`: what the work in that worktree changed, committed or not.
export type Where = { worktree: string; branch: string; commit: string; dirty: boolean; stale?: boolean; files?: string[] }

// A handoff carries `where`; a check that passed carries `check` and `where`.
// `ran` is true when the board ran the check itself, false when an agent reported it.
export type Note = { at: string; by: string; text: string; where?: Where; check?: { cmd: string; ran: boolean } }

// A project's task file, read for display (lib/taskfile.mjs). `done` is null
// for a plain bullet with no checkbox; `priority` is 0 for P0, null for none.
export type TaskFile = {
  file: string | null
  items: { text: string; done: boolean | null; section: string; depth: number; priority: number | null }[]
}

export type Agent = { name: string; lastSeen: string }

export type Usage = {
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  context?: number
  costUsd?: number
}

// A weather reading from Open-Meteo: `at` is when it came in, in ms.
export type Weather = { temp: number; high: number; code: number; place: string; at: number }

// A one-off alarm an agent set with board_alarm: it rings once at `at`, then goes.
// `due`: when it rings, in ms, so one missed while the machine slept is
// known as missed, not rung a day late. Older ones have only `at`.
// A ready-made block as the registry reports it (board blocks --all), and
// its last line. state: ok · empty · missing · auth · offline · unsafe ·
// timeout · error.
export type ReadyBlock = { id: string; title: string; about: string; needs: string[]; every: number; timeout: number; source: string; enabled: boolean; view?: string; hosts?: string[] }
export type ReadyValue = { id: string; state: string; text: string; at: number }

export type Reminder = { at: string; note: string; due?: number }

// The block contract (lib/block-data.mjs): what every renderer gets for one
// block. `type` picks the renderer; an action is a name the server checks,
// never a command, and `target` is the item it acts on (a task id). `input:
// 'text'`: the person types a line for it (a note).
export type BlockAction = { id: string; label: string; target?: string; input?: 'text' }
export type BlockData<T = unknown> = {
  id: string
  type: string
  schemaVersion: 1
  title: string
  status: 'ready' | 'loading' | 'error'
  error?: string
  data: T
  updatedAt: string
  actions: BlockAction[]
}
export type TasksBlockData = {
  counts: { inProgress: number; waiting: number; done: number }
  tasks: { id: string; title: string; status: 'todo' | 'claimed'; kind: string | null; owner: string | null; since: string | null; waitingOn: string[]; handedOff: boolean }[]
}

declare module 'claude-code' {
  interface PluginState {
    modboard: { tasks: Task[]; agents: Agent[]; me: string; usage: Usage; model: string; effort: string; custom: Record<string, string>; commandState: Record<string, { ok: number | null; failing: number | null }>; taskfile: TaskFile; taskfileOpen: boolean; taskfileTier: string; paneOpen: boolean; groupsOpen: Record<string, boolean>; listOpen: Record<string, boolean>; boardError: string; copied: string; home: string; paneView: string; paneBlocks: string[]; weather: Weather | null; alarms: string[]; ringing: string; minute: string; reminders: Reminder[]; located: boolean; seenDone: string[] | null; moved: string; listStart: string[]; readyList: ReadyBlock[]; readyValues: Record<string, ReadyValue> }
  }
}
