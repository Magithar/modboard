import type { TaskFile } from '../../types'
import { SHOWN, type Block, type Ctx } from './types'

type Item = TaskFile['items'][number]

// What is left to do: every item not checked off. Plain bullets count too.
const open = (items: Item[]) => items.filter(i => i.done !== true)

function Row(c: Ctx, i: Item) {
  const { Box, Text } = c.ui
  return (
    <Box paddingLeft={2 + i.depth * 2}>
      <Text wrap="truncate">{i.text}</Text>
    </Box>
  )
}

// The project's own task.md, beside the board, reduced to what is left to do.
// Closed, one line: the file and how much is open. Pressed, the open items in
// the file's order under its headings (dimmed), up to SHOWN, then a count of
// the rest. Done items are not shown; the file keeps them. It is for reading:
// to work an item through the board, add it there (board add) and claim it.
export const taskfile: Block = {
  name: 'taskfile',
  pane: c => {
    const { Box, Button, Text } = c.ui
    const { file } = c.taskfile
    if (!file) return null
    const left = open(c.taskfile.items)
    const label = `${c.taskfileOpen ? '▾' : '▸'} ${file} · ${left.length ? `${left.length} open` : 'all done'}`
    const shown = left.slice(0, SHOWN)
    const sections = [...new Set(shown.map(i => i.section))]
    return (
      <Box flexDirection="column">
        <Button key="taskfile" hotkey="t" label={label} onPress={c.act.toggleTaskfile} />
        {c.taskfileOpen &&
          sections.map(s => (
            <Box flexDirection="column" marginTop={1}>
              {s && <Text dimColor>{s}</Text>}
              {shown.filter(i => i.section === s).map(i => Row(c, i))}
            </Box>
          ))}
        {c.taskfileOpen && left.length > SHOWN && (
          <Box paddingLeft={2} marginTop={1}>
            <Text dimColor>{`${left.length - SHOWN} more`}</Text>
          </Box>
        )}
      </Box>
    )
  },
}
