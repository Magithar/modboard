import type { Block } from './types'

// Who is live on the board, on one line: a green ● for an agent seen in the
// last 90 seconds (a Claude Code session checks in every minute), a grey ○
// for one gone quiet. The board drops an agent once it is quiet for 3 minutes.
// What each one holds is the work block's to say, so it is not repeated here.
// Nothing on the line is pressable, so it is all grey (white marks what is);
// the dots carry who is active.
const ACTIVE_MS = 90_000

export const agents: Block = {
  name: 'agents',
  about: 'who is live',
  pane: ({ ui: { Box, Text }, agents: list, who, now }) =>
    list.length ? (
      <Box flexWrap="wrap" columnGap={2}>
        <Text dimColor>Live</Text>
        {list.map(a => {
          const active = now - Date.parse(a.lastSeen) < ACTIVE_MS
          return (
            <Box key={`live-${a.name}`}>
              <Text color={active ? 'success' : undefined} dimColor={!active}>
                {active ? '● ' : '○ '}
              </Text>
              <Text dimColor>{a.name === who ? `${a.name} (you)` : a.name}</Text>
            </Box>
          )
        })}
      </Box>
    ) : null,
}
