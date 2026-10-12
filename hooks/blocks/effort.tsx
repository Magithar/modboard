import type { Block } from './types'

// How hard the model thinks. Pressing it switches to the next level in the
// `efforts` setting, through Claude Code's own /effort.
export const effort: Block = {
  name: 'effort',
  band: ({ ui: { Button }, effort: level, act }) => (
    <Button key="effort" hotkey="e" label={`effort ${level || '–'}`} onPress={act.nextEffort} />
  ),
  pane: ({ ui: { Box, Button, Text }, effort: level, act }) => (
    <Box gap={1}>
      <Text dimColor>effort</Text>
      <Button key="effort" hotkey="e" label={level || '–'} onPress={act.nextEffort} />
    </Box>
  ),
}
