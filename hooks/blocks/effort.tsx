import type { Block } from './types'

// How hard the model thinks. Pressing it switches to the next level in the
// `efforts` setting, through Claude Code's own /effort.
export const effort: Block = {
  name: 'effort',
  // Off the list of blocks: the band shows it already.
  listed: false,
  band: ({ ui: { Button, Text }, effort: level, act }) => {
    // Beside the model, the level says what it is ("low"), so the band gives it no label.
    const shown = level || '–'
    return [
      {
        tree: (
          <Button key="effort" plain onPress={act.nextEffort}>
            <Text bold>{shown}</Text>
          </Button>
        ),
        width: shown.length,
      },
    ]
  },
  pane: ({ ui: { Box, Button, Text }, effort: level, act }) => (
    <Box>
      <Box width={8}>
        <Text dimColor>effort</Text>
      </Box>
      <Button key="effort" hotkey="e" label={level || '–'} onPress={act.nextEffort} />
    </Box>
  ),
}
