import type { Task } from '../../types'
import type { Block, Ctx } from './types'
import { goingQuiet, handedOffBy, handoffWaiting } from './attention'

// Who a row is about. The group's heading says what they did ("In progress",
// "Unfinished"), so the row only names them. Warnings are what needs you:
// an agent gone quiet, or work left partway.
function status(t: Task, { now, who }: Ctx): { text: string; warn: boolean } {
  // A done task names who finished it: whoever wrote its verification note.
  if (t.status === 'done') {
    const by = t.notes.at(-1)?.by ?? ''
    return { text: by === who ? 'you' : by, warn: false }
  }
  if (t.claim) {
    const name = t.claim.owner === who ? 'you' : t.claim.owner
    if (goingQuiet(t, now)) return { text: `${name} · idle`, warn: true }
    return { text: name, warn: false }
  }
  if (handoffWaiting(t)) return { text: handedOffBy(t), warn: true }
  return { text: '', warn: false }
}

function Row(c: Ctx, t: Task) {
  const { Box, Text } = c.ui
  const isMine = t.claim?.owner === c.who
  const { text, warn } = status(t, c)
  // Work left partway shows its handoff under the title: what is done and what
  // is left, as the agent wrote it, one point a line where it used semicolons.
  const handoff = handoffWaiting(t) ? t.notes.at(-1)!.text.replace(/^HANDOFF:\s*/, '') : ''
  const points = handoff.split(';').map(p => p.trim()).filter(Boolean)
  // The group's heading already says the task's state; the row needs no mark.
  const row = (
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
  if (!handoff) return row
  return (
    <Box flexDirection="column">
      {row}
      {points.map(p => (
        <Box paddingLeft={7}>
          <Text dimColor wrap="truncate">
            {points.length > 1 ? `· ${p}` : p}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

// The groups, each a heading that opens and closes like the task file's.
// What needs you starts open; what nobody has started, and what is done, start
// closed, one line with its count, so the pane fits on screen.
export const GROUPS = {
  'in-progress': { title: 'In progress', open: true },
  partway: { title: 'Unfinished', open: true },
  'not-started': { title: 'Not started', open: false },
  done: { title: 'Done', open: false },
  // Not a task group: the pane's bars (context, the 5-hour limit), folded the
  // same way. See register.tsx.
  limits: { title: 'Limits', open: true },
} as const
export type GroupName = keyof typeof GROUPS

// Whether a group is open: as the person last left it, else its default.
export const groupOpen = (chosen: Record<string, boolean>, name: GroupName) => chosen[name] ?? GROUPS[name].open

// A heading that is a button ("▾ In progress · 2"), then, open, all its rows.
function Group(c: Ctx, name: GroupName, list: Task[], last = false) {
  const { Box, Button, Text } = c.ui
  if (!list.length) return null
  const open = groupOpen(c.groupsOpen, name)
  return (
    <Box flexDirection="column">
      {/* The name is the button, bold; the count is grey text beside it. */}
      <Box>
        <Button key={`group-${name}`} plain onPress={() => c.act.toggleGroup(name)}>
          <Text bold>{`${open ? '▾' : '▸'} ${GROUPS[name].title}`}</Text>
        </Button>
        <Text dimColor>{` · ${list.length}`}</Text>
      </Box>
      {open && (
        // A blank line under the heading and after the rows, so each group
        // reads as its own block; the last leaves that to what follows the pane.
        <Box flexDirection="column" paddingLeft={2} marginTop={1} marginBottom={last ? 0 : 1}>
          {/* Work left partway carries its handoff, so each task there sits apart. */}
          {list.map((t, i) => (name === 'partway' && i > 0 ? <Box marginTop={1}>{Row(c, t)}</Box> : Row(c, t)))}
        </Box>
      )}
    </Box>
  )
}

// In progress first; then work someone stopped partway, which needs picking
// up; then what nobody has started; then what is done.
// What needs you is never cut short.
export const tasks: Block = {
  name: 'tasks',
  pane: c => {
    const { Box, Text } = c.ui
    const todo = c.tasks.filter(t => t.status === 'todo')
    const working = c.tasks.filter(t => t.status === 'claimed').length
    // Most recently finished first: what was just done is what you look for.
    const done = c.tasks.filter(t => t.status === 'done').sort((a, b) => (b.notes.at(-1)?.at ?? '').localeCompare(a.notes.at(-1)?.at ?? ''))
    // The pane's title, with the band's counts at the right: what the whole
    // board holds, before any group is opened.
    const title = (
      <Box justifyContent="space-between" marginBottom={1}>
        {/* Which session this is: "you" in its rows, its name everywhere else. */}
        <Box>
          {/* The logo's green, bold: the pane's name, a heading where the
              surface has sizes (the terminal has one). */}
          <Text bold color="success" size="heading">
            modBOARD
          </Text>
          {c.who ? <Text dimColor> · </Text> : null}
          {c.who ? <Text dimColor>{c.who}</Text> : null}
        </Box>
        <Box>
          {todo.length > 0 && <Text dimColor>{`${todo.length} waiting`}</Text>}
          {todo.length > 0 && working > 0 && <Text dimColor> · </Text>}
          {working > 0 && <Text color="success">{`${working} active`}</Text>}
        </Box>
      </Box>
    )
    if (!c.tasks.length)
      return (
        <Box flexDirection="column">
          {title}
          <Text dimColor>No tasks yet. Ask Claude to add some, or run `board add`.</Text>
        </Box>
      )
    const groups = (
      [
        ['in-progress', c.tasks.filter(t => t.status === 'claimed')],
        ['partway', todo.filter(handoffWaiting)],
        ['not-started', todo.filter(t => !handoffWaiting(t))],
        ['done', done],
      ] as [GroupName, Task[]][]
    ).filter(([, list]) => list.length)
    return (
      <Box flexDirection="column">
        {title}
        {groups.map(([name, list], i) => {
          // Each group sits a blank line apart, which an open group above already leaves.
          const apart = i > 0 && !groupOpen(c.groupsOpen, groups[i - 1]![0])
          const group = Group(c, name, list, i === groups.length - 1)
          return apart ? <Box marginTop={1}>{group}</Box> : group
        })}
      </Box>
    )
  },
}
