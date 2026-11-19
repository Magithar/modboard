import type { Block } from './types'
import { handoffWaiting } from './attention'

// How many tasks the alert names in its widest form before the rest become "+N".
const NAMED = 3

// The band's main line: how much is waiting and active, and the one thing
// that needs you. Short words: the reader need not know the board's terms.
export const summary: Block = {
  name: 'summary',
  band: ({ ui: { Box, Text, Button }, tasks, act }) => {
    const working = tasks.filter(t => t.status === 'claimed').length
    const open = tasks.filter(t => t.status === 'todo').length
    if (!working && !open) return null
    // Unfinished work, the one thing on the board that waits for someone. A
    // claim gone idle is left to the pane: its lease frees it on its own.
    const waiting = tasks.filter(handoffWaiting)
    // Each unfinished task is a yellow box, the first thing on the line. It is
    // a button, as everything bold on the band is: pressed, it opens the pane
    // at the Unfinished group.
    const box = (id: string) => (
      <Button key={`task-${id}`} plain onPress={() => act.showGroup('partway')}>
        <Text backgroundColor="warning" color="inverseText" bold>
          {` ${id} `}
        </Text>
      </Button>
    )
    // Boxes for the first `named` tasks, then "+N" for the rest.
    const alert = (named: number) => {
      const shown = waiting.slice(0, named)
      const more = waiting.length - shown.length
      return {
        tree: (
          <Box flexShrink={0}>
            {shown.flatMap((t, i) => (i ? [<Text> </Text>, box(t.id)] : [box(t.id)]))}
            {more ? <Text color="warning">{` +${more}`}</Text> : null}
          </Box>
        ),
        width: shown.reduce((n, t) => n + t.id.length + 2, 0) + Math.max(0, shown.length - 1) + (more ? ` +${more}`.length : 0),
      }
    }
    // Widest first: up to NAMED boxes, then only the first.
    const alerts = waiting.length ? [alert(NAMED), alert(1)] : []
    const countParts = [
      open ? <Text dimColor>{`${open} waiting`}</Text> : null,
      open && working ? <Text dimColor> · </Text> : null,
      working ? <Text color="success">{`${working} active`}</Text> : null,
    ].filter(Boolean)
    const countsWidth = (open ? `${open} waiting`.length : 0) + (open && working ? 3 : 0) + (working ? `${working} active`.length : 0)
    // The alert outlasts the counts: it is the one thing that needs you.
    const form = (counts: boolean, right?: { tree: any; width: number }) => ({
      tree: (
        <Box gap={3}>
          {counts ? <Box flexShrink={0}>{countParts}</Box> : null}
          {right ? right.tree : null}
        </Box>
      ),
      width: (counts ? countsWidth : 0) + (right ? right.width : 0) + (counts && right ? 3 : 0),
    })
    if (!alerts.length) return [form(true)]
    return [...alerts.map(a => form(true, a)), form(false, alerts.at(-1))]
  },
}
