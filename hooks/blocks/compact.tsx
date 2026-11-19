import type { Block } from './types'
import { Meter, meterText } from './meter'

// The context window, as the board's ring, and a button that compacts it
// through Claude Code's own /compact, as if you had typed it. The ring is its
// own label. In the band it appears once the window is half full; in the pane
// it is always there, lined up with usage.
export const compact: Block = {
  name: 'compact',
  band: ({ ui, usage: u, act }) => {
    if (u.context === undefined || u.context < 50) return null
    const { Button, Text } = ui
    const text = meterText(u.context)
    const press = (withWord: boolean) => ({
      tree: (
        <Button key="compact" plain onPress={act.compact}>
          {[...Meter(ui, u.context!), ...(withWord ? [<Text dimColor> compact</Text>] : [])]}
        </Button>
      ),
      width: text.length + (withWord ? 8 : 0),
    })
    return [press(true), press(false)]
  },
  pane: ({ ui, usage: u, act }) => {
    if (u.context === undefined) return null
    const { Box, Button } = ui
    return (
      <Box>
        {Meter(ui, u.context, true)}
        <Box marginLeft={2}>
          <Button key="compact" hotkey="c" label="compact" onPress={act.compact} />
        </Box>
      </Box>
    )
  },
}
