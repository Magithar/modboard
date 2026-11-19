import type { Block } from './types'

// A word on the band that opens the /board pane, a button like the model's:
// no brackets, the click is the whole of it. It sits at the line's right end,
// by Claude Code's own [-]. The pane has no part of it.
export const board: Block = {
  name: 'board',
  band: ({ ui: { Button, Text }, act }) => [
    {
      tree: (
        <Button key="board" plain onPress={act.openBoard}>
          <Text bold>full board</Text>
        </Button>
      ),
      width: 'full board'.length,
      end: true,
    },
  ],
}
