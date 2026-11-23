import type { Block } from './types'
import { commandRow, standing } from './command'
import { groupOpen } from './tasks'

// Your command blocks (tests, CI, anything with an output) under one heading,
// like Limits and Clock: each keeps its last good result when its command
// fails, and says how old it is. Folded, one line with their names; one that
// is not updating is named in yellow. With none set yet, it says where to add one.
export const checks: Block = {
  name: 'checks',
  about: 'your command blocks, with their age',
  pane: c => {
    const { Box, Button, Text } = c.ui
    const open = groupOpen(c.groupsOpen, 'checks')
    const rows = c.commands.map(name => ({ name, s: standing(c, name) }))
    const brief = rows.flatMap(({ name, s }) => [
      <Text dimColor> · </Text>,
      <Text color={s?.stale ? 'warning' : undefined} dimColor={!s?.stale}>
        {s?.stale ? `${name} not updating` : name}
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
            {c.commands.length ? (
              // A blank line between the rows, as between a handoff's facts.
              c.commands.map((name, i) => (
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
              ))
            ) : (
              <Text dimColor>No command blocks yet: add one under Your own blocks in /config.</Text>
            )}
          </Box>
        ) : null}
      </Box>
    )
  },
}
