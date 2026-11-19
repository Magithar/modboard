// The board's display blocks. To add one: write it as its own file beside
// these (see types.tsx for the shape), import it here, and add it to the list.
// It can then be named in the `band` or `pane` setting. Blocks that only show a
// command's output need no code: see command.tsx and the `blocks` setting.

import { agents } from './agents'
import { board } from './board'
import { clock } from './clock'
import { compact } from './compact'
import { context } from './context'
import { effort } from './effort'
import { model } from './model'
import { summary } from './summary'
import { taskfile } from './taskfile'
import { tasks } from './tasks'
import { usage } from './usage'
import type { Block } from './types'

export const BLOCKS: Block[] = [summary, board, tasks, taskfile, usage, compact, model, effort, clock, context, agents]

export type { BandForm, Block, Ctx } from './types'
