import type { Agent, Task, TaskFile, Usage, Weather } from '../../types'

// What every block draws from. `ui` is the surface's own element table.
export type Ctx = {
  ui: { Box: any; Text: any; Button: any }
  width: number
  now: number
  who: string
  tasks: Task[]
  agents: Agent[]
  usage: Usage
  model: string
  effort: string
  // The last line each command block printed, by block name.
  custom: Record<string, string>
  // The project's task.md, and whether its list is open in the pane.
  taskfile: TaskFile
  taskfileOpen: boolean
  // The priority the task file's list is turned to: "0" for P0, "all", or ""
  // for the most urgent there is (see taskfile.tsx).
  taskfileTier: string
  // Which task groups the person opened or closed, by name (see tasks.tsx).
  groupsOpen: Record<string, boolean>
  // The person's home directory, so a path reads ~/code/app; and the task whose
  // worktree path was just copied, for a moment, so its row says so.
  home: string
  copied: string
  // The last weather reading, or null before one (or with no location set);
  // the alarm times set, "07:30"; and the one ringing now, or ''.
  weather: Weather | null
  alarms: string[]
  ringing: string
  // What a pressed block can do: each switches the session the way the
  // matching slash command would.
  act: { nextModel: () => Promise<void>; nextEffort: () => Promise<void>; toggleTaskfile: () => Promise<void>; nextTier: () => Promise<void>; toggleGroup: (name: string) => Promise<void>; showGroup: (name: string) => Promise<void>; compact: () => Promise<void>; openBoard: () => Promise<void>; openBlocks: () => Promise<void>; copyPath: (id: string, path: string, surface: string) => Promise<void>; stopAlarm: () => Promise<void> }
}

// One way a block can draw in the band, and how many columns it takes.
// `end`: the part sits at the line's right end, by Claude Code's own control.
export type BandForm = { tree: any; width: number; end?: boolean }

// A block is one part of the board's display. It may draw in the band above
// the prompt, in the /board pane, or both, and returns null when it has
// nothing worth showing. In the band it offers its forms widest first; the
// band never wraps, so when the line is short it takes a narrower form, and
// past the narrowest it leaves the block out.
export type Block = {
  name: string
  // What it shows, in a few words, on the pane's list of blocks. Every block
  // with a pane part is on that list by itself; `listed: false` leaves it off.
  about?: string
  listed?: false
  band?: (c: Ctx) => BandForm[] | null
  pane?: (c: Ctx) => any
  // A bar block's figures for the Limits heading when it is folded:
  // "context 72%". Each comes with its percent, which colours it.
  brief?: (c: Ctx) => { name: string; percent: number }[]
}

// A run of text that never wraps, and its width.
export function words(Text: any, text: string, props: Record<string, unknown> = {}): BandForm {
  return { tree: <Text {...props} wrap="truncate">{text}</Text>, width: [...text].length }
}
