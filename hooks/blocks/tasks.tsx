import type { Task } from '../../types'
import { SHOWN, type Block, type Ctx } from './types'
import { goingQuiet, handedOffBy, handoffWaiting } from './attention'

// Who a row is about. The group's heading says what they did ("In progress",
// "Stopped partway"), so the row only names them. Warnings are what needs you:
// an agent gone quiet, or work left partway.
function status(t: Task, { now, who, width }: Ctx): { text: string; warn: boolean } {
  if (t.claim) {
    const name = t.claim.owner === who ? 'you' : t.claim.owner
    if (goingQuiet(t, now)) return { text: `${name} stopped responding`, warn: true }
    return { text: name, warn: false }
  }
  if (handoffWaiting(t)) return { text: `${handedOffBy(t)}${width < 64 ? '' : ' · see its note'}`, warn: true }
  return { text: '', warn: false }
}

function Row(c: Ctx, t: Task) {
  const { Box, Text } = c.ui
  const isMine = t.claim?.owner === c.who
  const { text, warn } = status(t, c)
  // The group's heading already says the task's state; the row needs no mark.
  return (
    <Box>
      <Box width={7}>
        <Text dimColor>{t.id}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text bold={isMine} wrap="truncate">
          {t.title}
        </Text>
      </Box>
      {text && (
        <Box marginLeft={2} flexShrink={0}>
          <Text color={warn ? 'warning' : undefined} dimColor={!warn}>
            {text}
          </Text>
        </Box>
      )}
    </Box>
  )
}

// A heading, quiet so the tasks lead, then its rows. With a `limit`, rows
// past it become one count.
function Group(c: Ctx, title: string, list: Task[], limit = Infinity) {
  const { Box, Text } = c.ui
  if (!list.length) return null
  return (
    <Box flexDirection="column">
      <Text dimColor>{title}</Text>
      {list.slice(0, limit).map(t => Row(c, t))}
      {list.length > limit && (
        <Box paddingLeft={7}>
          <Text dimColor>{`${list.length - limit} more`}</Text>
        </Box>
      )}
    </Box>
  )
}

// In progress first; then work someone stopped partway, which needs picking
// up; then what nobody has started, up to SHOWN. Done tasks become a count.
// What needs you is never cut short.
export const tasks: Block = {
  name: 'tasks',
  pane: c => {
    const { Box, Text } = c.ui
    if (!c.tasks.length) return <Text dimColor>No tasks yet. Ask Claude to add some, or run `board add`.</Text>
    const todo = c.tasks.filter(t => t.status === 'todo')
    const done = c.tasks.filter(t => t.status === 'done').length
    return (
      <Box flexDirection="column" gap={1}>
        {Group(c, 'In progress', c.tasks.filter(t => t.status === 'claimed'))}
        {Group(c, 'Stopped partway', todo.filter(handoffWaiting))}
        {Group(c, 'Not started', todo.filter(t => !handoffWaiting(t)), SHOWN)}
        {done > 0 && <Text dimColor>{`${done} done`}</Text>}
      </Box>
    )
  },
}
