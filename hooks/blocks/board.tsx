import type { Block } from './types'

// The mod's name on the band, bold in the logo's green, as the pane's title
// is: a button that opens the /board pane, or closes it when it is open. No
// brackets; the click is the whole of it.
// Before it, blocks: opens the pane at the list of what it shows, to tick
// blocks on and off. On a short line blocks goes first, and modBOARD stays.
// It sits at the line's right end, by Claude Code's own [-]. The pane has no
// part of it.
const BLOCKS_LABEL = 'blocks'
// The logo's cap orange, beside modBOARD's green: the logo's two colours.
export const CAP = '#F27238'
// The board's yellow, for what wants a look: waiting work, bars from 70%,
// the band's task box. The theme's own bright warning colour, so it stands out.
export const YELLOW = 'warning'
const GAP = 3

export const board: Block = {
  name: 'board',
  band: ({ ui: { Box, Button, Text }, act }) => {
    const logo = (
      <Button key="board" plain onPress={act.openBoard}>
        <Text bold color="success">
          modBOARD
        </Text>
      </Button>
    )
    return [
      {
        tree: (
          <Box gap={GAP} flexWrap="nowrap">
            <Button key="blocks" plain onPress={act.openBlocks}>
              <Text bold color={CAP}>
                {BLOCKS_LABEL}
              </Text>
            </Button>
            {logo}
          </Box>
        ),
        width: BLOCKS_LABEL.length + GAP + 'modBOARD'.length,
        end: true,
      },
      { tree: logo, width: 'modBOARD'.length, end: true },
    ]
  },
}
