export type Task = {
  id: string
  title: string
  description: string
  accept?: string
  status: 'todo' | 'claimed' | 'done'
  claim: { owner: string; since: string; expiresAt: string } | null
  notes: { at: string; by: string; text: string }[]
}

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

declare module 'claude-code' {
  interface PluginState {
    modboard: { tasks: Task[]; agents: Agent[]; me: string; usage: Usage; model: string; effort: string; custom: Record<string, string>; taskfile: TaskFile; taskfileOpen: boolean; taskfileTier: string }
  }
}
