import type { Block, Ctx } from './types'
import { Bar, CELLS, barWidth } from './meter'

const LABEL: Record<string, string> = { five_hour: '5-hour limit', spend_limit: 'spend limit' }
const SHORT: Record<string, string> = { five_hour: '5h', spend_limit: 'spend' }
// The name in the folded Limits heading: short, but still words.
const BRIEF: Record<string, string> = { five_hour: '5-hour', spend_limit: 'spend' }
const label = (kind: string) => LABEL[kind] ?? kind
const pad = (n: number) => String(n).padStart(2, '0')
const when = (iso: string, now: number) => {
  const d = new Date(iso)
  const days = Math.floor((d.getTime() - now) / 86_400_000)
  return days >= 1 ? `in ${days}d` : `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// The weekly window is left off the board: it moves too slowly to act on in a
// session, and Claude Code's /usage shows it.
const shown = (u: Ctx['usage']) => u.limits.filter(l => l.kind !== 'seven_day')

// This session's plan usage, as a bar. In the band only once a window passes
// half, since below that it is noise; in the pane, each window with its reset.
export const usage: Block = {
  name: 'usage',
  about: '5-hour limit',
  band: ({ ui, usage: u }) => {
    const top = [...shown(u)].sort((a, b) => b.percentUsed - a.percentUsed)[0]
    if (!top || top.percentUsed < 50) return null
    const form = (name: string, cells: number) => ({
      tree: (
        <ui.Box gap={1}>
          <ui.Text dimColor wrap="truncate">
            {name}
          </ui.Text>
          {Bar(ui, top.percentUsed, cells)}
        </ui.Box>
      ),
      width: name.length + 1 + barWidth(cells),
    })
    return [form(label(top.kind), CELLS), form(SHORT[top.kind] ?? label(top.kind), 5)]
  },
  brief: ({ usage: u }) => shown(u).map(l => ({ name: BRIEF[l.kind] ?? l.kind, percent: l.percentUsed })),
  pane: ({ ui, usage: u, now }) => {
    const { Box, Text } = ui
    const limits = shown(u)
    if (!limits.length) return null
    return (
      <Box flexDirection="column">
        {limits.map(l => (
          <Box>
            <Box width={14}>
              <Text dimColor>{label(l.kind)}</Text>
            </Box>
            {Bar(ui, l.percentUsed)}
            {l.resetsAt && <Text dimColor>{`   resets ${when(l.resetsAt, now)}`}</Text>}
          </Box>
        ))}
      </Box>
    )
  },
}
