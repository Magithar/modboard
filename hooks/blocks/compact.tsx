import type { Block } from './types'
import { Bar, CELLS, barParts, barWidth } from './meter'

// The context window as a bar, like the 5-hour limit's, and a button that
// compacts the conversation (Claude Code's own compaction, the call /compact
// makes). The fill is Claude Code's local estimate until the first reply,
// then each reply's measurement. In the band, the whole part is the button;
// in the pane, the word compact beside the bar, a button like the model's, always there,
// with an empty bar if no figure has come yet. The bar takes colour from 70%.
export const compact: Block = {
  name: 'compact',
  band: ({ ui, usage: u, act }) => {
    if (u.context === undefined) return null
    const { Button, Text } = ui
    const press = (name: string, cells: number, withWord: boolean) => ({
      tree: (
        <Button key="compact" plain onPress={act.compact}>
          {[<Text dimColor>{`${name} `}</Text>, ...barParts(ui, u.context!, cells), ...(withWord ? [<Text dimColor> compact</Text>] : [])]}
        </Button>
      ),
      width: name.length + 1 + barWidth(cells) + (withWord ? 8 : 0),
    })
    return [press('context', CELLS, true), press('ctx', 5, false)]
  },
  brief: ({ usage: u }) => (u.context === undefined ? [] : [{ name: 'context', percent: u.context }]),
  pane: ({ ui, usage: u, act }) => {
    const { Box, Button, Text } = ui
    return (
      <Box>
        <Box width={14}>
          <Text dimColor>context</Text>
        </Box>
        {u.context === undefined ? (
          <Box flexShrink={0}>
            <Text dimColor>{'░'.repeat(CELLS)}</Text>
            <Text dimColor>{'    –'}</Text>
          </Box>
        ) : (
          Bar(ui, u.context)
        )}
        <Box marginLeft={3}>
          <Button key="compact" plain onPress={act.compact}>
            <Text bold>compact</Text>
          </Button>
        </Box>
      </Box>
    )
  },
}
