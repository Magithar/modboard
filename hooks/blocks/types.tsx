import type { Agent, Task, Usage } from '../../types'

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
  // What a pressed block can do: each switches the session the way the
  // matching slash command would.
  act: { nextModel: () => Promise<void>; nextEffort: () => Promise<void> }
}

// One way a block can draw in the band, and how many columns it takes.
export type BandForm = { tree: any; width: number }

// A block is one part of the board's display. It may draw in the band above
// the prompt, in the /board pane, or both, and returns null when it has
// nothing worth showing. In the band it offers its forms widest first; the
// band never wraps, so when the line is short it takes a narrower form, and
// past the narrowest it leaves the block out.
export type Block = {
  name: string
  band?: (c: Ctx) => BandForm[] | null
  pane?: (c: Ctx) => any
}

// A run of text that never wraps, and its width.
export function words(Text: any, text: string, props: Record<string, unknown> = {}): BandForm {
  return { tree: <Text {...props} wrap="truncate">{text}</Text>, width: [...text].length }
}
