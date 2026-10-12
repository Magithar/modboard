import type { Block } from './types'

// How hard the model thinks. Pressing it switches to the next level in the
// `efforts` setting, through Claude Code's own /effort.
export const effort: Block = {
  name: 'effort',
  band: ({ ui: { Button, Text }, effort: level, act }) => {
    const shown = level || '–'
    const press = (label: string, children: any) => ({
      tree: (
        <Button key="effort" plain onPress={act.nextEffort}>
          {children}
        </Button>
      ),
      width: label.length,
    })
    return [
      press(`effort ${shown}`, [<Text dimColor>effort </Text>, <Text bold>{shown}</Text>]),
      press(shown, <Text bold>{shown}</Text>),
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
