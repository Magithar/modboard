import type { Block } from './types'

// The mod's name on the band, bold in the logo's green, as the pane's title
// is: a button that opens the /board pane, or closes it when it is open. No
// brackets; the click is the whole of it.
// It sits at the line's right end, by Claude Code's own [-]. The pane has no
// part of it.
export const board: Block = {
  name: 'board',
  band: ({ ui: { Button, Text }, act }) => [
    {
      tree: (
        <Button key="board" plain onPress={act.openBoard}>
          <Text bold color="success">
            modBOARD
          </Text>
        </Button>
      ),
      width: 'modBOARD'.length,
      end: true,
    },
  ],
}
