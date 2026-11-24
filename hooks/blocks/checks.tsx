import type { Block, Ctx } from './types'
import { commandRow, outcome, standing } from './command'
import { groupOpen } from './tasks'

// Your command blocks (tests, CI, anything with an output) under one heading,
// like Limits and Clock: each keeps its last good result when its command
// fails, and says how old it is. Folded, one line with their names; one that
// is not updating is named in yellow. With none set yet, it says where to add one.
// States that need a person: a tool to install, a sign-in, a network, or a
// repo whose own git config could run code.
const WARN = new Set(['missing', 'auth', 'offline', 'unsafe', 'timeout'])

// A ready-made block as a row, like a command block's: its name, then its
// line, coloured by what it says (success green, failure red) when it ran,
// yellow when it needs you, red when it broke, grey when there's nothing.
function readyRow(c: Ctx, id: string) {
  const { Box, Text } = c.ui
  const v = c.readyValues[id]
  const color = !v ? undefined : v.state === 'ok' ? outcome(v.text) : WARN.has(v.state) ? 'warning' : v.state === 'error' ? 'error' : undefined
  return (
    <Box key={`ready-${id}`}>
      <Box width={8} flexShrink={0}>
        <Text dimColor>{id}</Text>
      </Box>
      <Box flexShrink={1}>
        {/* Grey unless its colour says something: nothing here is pressed, and white marks what is. */}
        <Text color={color} dimColor={!color} wrap="truncate">
          {v ? v.text : 'waiting for its first run'}
        </Text>
      </Box>
    </Box>
  )
}

export const checks: Block = {
  name: 'checks',
  about: 'test and CI results',
  pane: c => {
    const { Box, Button, Text } = c.ui
    const open = groupOpen(c.groupsOpen, 'checks')
    const rows = c.commands.map(name => ({ name, s: standing(c, name) }))
    // Folded, the names; one that needs you (not updating, a tool missing,
    // not signed in) in yellow.
    const brief = [
      ...rows.map(({ name, s }) => ({ text: s?.stale ? `${name} not updating` : name, warn: !!s?.stale })),
      ...c.ready.map(b => {
        const v = c.readyValues[b.id]
        const warn = !!v && WARN.has(v.state)
        return { text: warn ? `${b.id} ${v!.text}` : b.id, warn }
      }),
    ].flatMap(({ text, warn }) => [
      <Text dimColor> · </Text>,
      <Text color={warn ? 'warning' : undefined} dimColor={!warn}>
        {text}
      </Text>,
    ])
    return (
      <Box flexDirection="column">
        <Box>
          <Button key="group-checks" plain onPress={() => c.act.toggleGroup('checks')}>
            <Text bold>{`${open ? '▾' : '▸'} Checks`}</Text>
          </Button>
          {!open ? brief : null}
        </Box>
        {open ? (
          <Box flexDirection="column" marginTop={1} paddingLeft={2}>
            {c.commands.length || c.ready.length ? (
              // A blank line between the rows, as between a handoff's facts.
              [...c.commands.map((name, i) => (
                <Box marginTop={i ? 1 : 0}>
                  {commandRow(c, name) ?? (
                    <Box>
                      <Box width={8} flexShrink={0}>
                        <Text dimColor>{name}</Text>
                      </Box>
                      <Text dimColor>waiting for its first run</Text>
                    </Box>
                  )}
                </Box>
              )),
              ...c.ready.map((b, i) => <Box marginTop={c.commands.length || i ? 1 : 0}>{readyRow(c, b.id)}</Box>)]
            ) : (
              <Text dimColor>No blocks on yet: tick one on the blocks list (branch, ci, prs…), or add your own under Your own blocks in /config.</Text>
            )}
          </Box>
        ) : null}
      </Box>
    )
  },
}
