import type { Task } from '../../types'
import type { Block, Ctx } from './types'
import { goingQuiet, handedOffBy, handoffWaiting } from './attention'

// What a row says about who has the task, as a sentence: a bare name could mean
// whoever made it, holds it or dropped it. Warnings are what needs you.
function status(t: Task, { now, who, width }: Ctx): { text: string; warn: boolean } {
  if (t.claim) {
    const name = t.claim.owner === who ? 'you' : t.claim.owner
    if (goingQuiet(t, now)) return { text: `${name} stopped responding`, warn: true }
    if (width < 64) return { text: name, warn: false }
    return { text: name === 'you' ? "you're on it" : `${name} is on it`, warn: false }
  }
  if (handoffWaiting(t)) return { text: `${handedOffBy(t)} stopped partway${width < 64 ? '' : ' · see its note'}`, warn: true }
  return { text: '', warn: false }
}

function Row(c: Ctx, t: Task) {
  const { Box, Text } = c.ui
  const isMine = t.claim?.owner === c.who
  const { text, warn } = status(t, c)
  return (
    <Box>
      <Box width={3}>
        <Text color={t.status === 'claimed' ? 'claude' : undefined} dimColor={t.status === 'todo'}>
          {t.status === 'claimed' ? '◐' : '○'}
        </Text>
      </Box>
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

function Group(c: Ctx, title: string, list: Task[]) {
  const { Box, Text } = c.ui
  if (!list.length) return null
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {list.map(t => Row(c, t))}
    </Box>
  )
}

// In progress first; then work someone stopped partway, which needs picking
// up; then what nobody has started. Done tasks become a count.
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
        {Group(c, 'Needs picking up', todo.filter(handoffWaiting))}
        {Group(c, 'Not started', todo.filter(t => !handoffWaiting(t)))}
        {done > 0 && <Text dimColor>{`${done} done`}</Text>}
      </Box>
    )
  },
}
