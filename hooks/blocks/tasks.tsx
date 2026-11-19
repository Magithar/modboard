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
      <Box width={7} flexShrink={0}>
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

// The groups, each a heading that opens and closes like the task file's.
// What needs you starts open; what nobody has started starts closed, one line
// with its count, so the pane fits on screen.
export const GROUPS = {
  'in-progress': { title: 'In progress', hotkey: 'i', open: true },
  partway: { title: 'Stopped partway', hotkey: 's', open: true },
  'not-started': { title: 'Not started', hotkey: 'n', open: false },
} as const
export type GroupName = keyof typeof GROUPS

// Whether a group is open: as the person last left it, else its default.
export const groupOpen = (chosen: Record<string, boolean>, name: GroupName) => chosen[name] ?? GROUPS[name].open

// A heading that is a button ("▾ In progress · 2"), then, open, its rows. With
// a `limit`, rows past it become one count.
function Group(c: Ctx, name: GroupName, list: Task[], limit = Infinity) {
  const { Box, Button, Text } = c.ui
  if (!list.length) return null
  const open = groupOpen(c.groupsOpen, name)
  return (
    <Box flexDirection="column">
      <Button
        key={`group-${name}`}
        hotkey={GROUPS[name].hotkey}
        label={`${open ? '▾' : '▸'} ${GROUPS[name].title} · ${list.length}`}
        onPress={() => c.act.toggleGroup(name)}
      />
      {open && (
        <Box flexDirection="column" paddingLeft={2}>
          {list.slice(0, limit).map(t => Row(c, t))}
          {list.length > limit && (
            <Box paddingLeft={7}>
              <Text dimColor>{`${list.length - limit} more`}</Text>
            </Box>
          )}
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
      <Box flexDirection="column">
        {Group(c, 'in-progress', c.tasks.filter(t => t.status === 'claimed'))}
        {Group(c, 'partway', todo.filter(handoffWaiting))}
        {Group(c, 'not-started', todo.filter(t => !handoffWaiting(t)), SHOWN)}
        {done > 0 && (
          <Box paddingLeft={2}>
            <Text dimColor>{`${done} done`}</Text>
          </Box>
        )}
      </Box>
    )
  },
}
