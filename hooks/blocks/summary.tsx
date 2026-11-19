import type { Block } from './types'
import { goingQuiet, handoffWaiting } from './attention'

// The band's main line: how much is waiting and active, and the one thing
// that needs you. Short words: the reader need not know the board's terms.
export const summary: Block = {
  name: 'summary',
  band: ({ ui: { Box, Text }, tasks, now }) => {
    const working = tasks.filter(t => t.status === 'claimed').length
    const open = tasks.filter(t => t.status === 'todo').length
    if (!working && !open) return null
    const waiting = tasks.filter(handoffWaiting)
    const quiet = tasks.filter(t => goingQuiet(t, now))
    // What is in progress is green, what was left partway yellow: one glance
    // says what is moving and what is not finished.
    const alert = waiting.length
      ? `${waiting[0]!.id} stopped partway${waiting.length > 1 ? ` +${waiting.length - 1}` : ''}`
      : quiet.length
        ? `${quiet[0]!.id}: ${quiet[0]!.claim!.owner} stopped responding`
        : ''
    const shortAlert = waiting.length ? `${waiting[0]!.id} partway` : quiet.length ? `${quiet[0]!.id} stopped` : ''
    const countParts = [
      open ? <Text dimColor>{`${open} waiting`}</Text> : null,
      open && working ? <Text dimColor> · </Text> : null,
      working ? <Text color="success">{`${working} active`}</Text> : null,
    ].filter(Boolean)
    const countsWidth = (open ? `${open} waiting`.length : 0) + (open && working ? 3 : 0) + (working ? `${working} active`.length : 0)
    // The alert outlasts the counts: it is the one thing that needs you.
    const form = (counts: boolean, right: string) => ({
      tree: (
        <Box gap={3}>
          {counts ? <Box flexShrink={0}>{countParts}</Box> : null}
          {right ? (
            <Text color="warning" wrap="truncate">
              {right}
            </Text>
          ) : null}
        </Box>
      ),
      width: (counts ? countsWidth : 0) + right.length + (counts && right ? 3 : 0),
    })
    return alert ? [form(true, alert), form(true, shortAlert), form(false, shortAlert)] : [form(true, '')]
  },
}
