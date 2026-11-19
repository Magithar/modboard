import type { TaskFile } from '../../types'
import type { Block, Ctx } from './types'

type Item = TaskFile['items'][number]

// What is left to do: every item not checked off. Plain bullets count too.
export const openItems = (items: Item[]) => items.filter(i => i.done !== true)

const NONE = 99
const rank = (i: Item) => i.priority ?? NONE

// Most urgent first; within a priority, the file's own order (sort is stable).
const byPriority = (items: Item[]) => [...items].sort((a, b) => rank(a) - rank(b))

// The priorities the open items have, most urgent first.
export const tiers = (items: Item[]) => [...new Set(items.map(i => i.priority).filter((p): p is number => p !== null))].sort((a, b) => a - b)

// The tier the list is turned to: the one chosen, while the file still has it;
// else the most urgent there is. "all" stays "all".
export function currentTier(items: Item[], chosen: string): number | 'all' {
  if (chosen === 'all') return 'all'
  const have = tiers(items)
  return chosen !== '' && have.includes(Number(chosen)) ? Number(chosen) : (have[0] ?? 'all')
}

// The tier after the current one: each priority the file has, then "all",
// then round to the most urgent again.
export function nextTier(items: Item[], chosen: string): string {
  const cycle: (number | 'all')[] = [...tiers(items), 'all']
  return String(cycle[(cycle.indexOf(currentTier(items, chosen)) + 1) % cycle.length])
}

// The priority column of the "all" view: on every row, so each line reads as
// a task of its own, never as the second line of the one above. Items with
// none have a dash.
function Ranked(c: Ctx, i: Item) {
  const { Box, Text } = c.ui
  return (
    <Box>
      <Box width={4} flexShrink={0}>
        <Text dimColor>{i.priority === null ? '–' : `P${i.priority}`}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate">{i.text}</Text>
      </Box>
    </Box>
  )
}

function Row(c: Ctx, i: Item, indent: number) {
  const { Box, Text } = c.ui
  return (
    <Box paddingLeft={indent + i.depth * 2}>
      <Text wrap="truncate">{i.text}</Text>
    </Box>
  )
}

// The project's own task file, beside the board, reduced to what is left to
// do. Closed, one line: the file and how much is open, and, when the file has
// priorities, a second button that turns through them like the effort block:
// "P0 · 3", "P1 · 5", …, "all", and round again. Pressing it shows that tier.
// Open, a single tier is just its work; "all" is every priority in order,
// each row with its own; a file without priorities keeps its own order
// under its headings. Open, it shows every open item, read again from the
// file on each press. It is for
// reading: to work an item through the board, add it there (board add).
export const taskfile: Block = {
  name: 'taskfile',
  pane: c => {
    const { Box, Button, Text } = c.ui
    const { file } = c.taskfile
    if (!file) return null
    const left = openItems(c.taskfile.items)
    const ranked = tiers(left).length > 0
    const tier = currentTier(left, c.taskfileTier)
    const name = file.split('/').pop()
    const head = (
      <Box gap={3}>
        <Button
          key="taskfile"
          plain
          label={`${c.taskfileOpen ? '▾' : '▸'} ${name} · ${left.length ? `${left.length} open` : 'all done'}`}
          onPress={c.act.toggleTaskfile}
        />
        {ranked && (
          <Button
            key="tier"
            plain
            label={tier === 'all' ? 'all' : `P${tier} · ${left.filter(i => i.priority === tier).length}`}
            onPress={c.act.nextTier}
          />
        )}
      </Box>
    )
    if (!c.taskfileOpen || !left.length) return head

    const list = !ranked ? left : tier === 'all' ? byPriority(left) : left.filter(i => i.priority === tier)
    // Open, every item shows; the pane scrolls.
    const shown = list
    let body
    if (ranked && tier === 'all') body = shown.map(i => Ranked(c, i))
    // One tier: the button names it, so the rows are only the work.
    else if (ranked) body = shown.map(i => Row(c, i, 0))
    else
      body = [...new Set(shown.map(i => i.section))].map(s => (
        <Box flexDirection="column" marginTop={1}>
          {s && <Text dimColor>{s}</Text>}
          {shown.filter(i => i.section === s).map(i => Row(c, i, 2))}
        </Box>
      ))
    return (
      <Box flexDirection="column">
        {head}
        {ranked ? (
          <Box flexDirection="column" marginTop={1}>
            {body}
          </Box>
        ) : (
          body
        )}
      </Box>
    )
  },
}
