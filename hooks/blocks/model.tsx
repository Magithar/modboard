import type { Block } from './types'

// "claude-sonnet-5-5" → "Sonnet 5.5"; anything else as the session names it.
export const modelName = (id: string) => {
  const m = /(opus|sonnet|haiku|fable)[-\s]?(\d+)(?:[-.](\d+))?/i.exec(id)
  if (!m) return id || 'model'
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

// The session's model. Pressing it switches to the next model in the `models`
// setting, through Claude Code's own /model, as if you had typed it.
export const model: Block = {
  name: 'model',
  // Off the list of blocks: the band shows it already.
  listed: false,
  band: ({ ui: { Button, Text }, model: id, act }) => {
    // The name says what it is ("Sonnet 5.5"), so the band gives it no label.
    const name = modelName(id)
    return [
      {
        tree: (
          <Button key="model" plain onPress={act.nextModel}>
            <Text bold>{name}</Text>
          </Button>
        ),
        width: name.length,
      },
    ]
  },
  pane: ({ ui: { Box, Button, Text }, model: id, act }) => (
    <Box>
      <Box width={8}>
        <Text dimColor>model</Text>
      </Box>
      <Button key="model" hotkey="m" label={modelName(id)} onPress={act.nextModel} />
    </Box>
  ),
}
