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
  band: ({ ui: { Button, Text }, model: id, act }) => {
    const name = modelName(id)
    const press = (label: string, children: any) => ({
      tree: (
        <Button key="model" plain onPress={act.nextModel}>
          {children}
        </Button>
      ),
      width: label.length,
    })
    return [
      press(`model ${name}`, [<Text dimColor>model </Text>, <Text bold>{name}</Text>]),
      press(name, <Text bold>{name}</Text>),
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
