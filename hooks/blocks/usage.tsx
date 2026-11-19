import type { Block, Ctx } from './types'
import { Meter, meterText } from './meter'

const LABEL: Record<string, string> = { five_hour: '5-hour limit', spend_limit: 'spend limit' }
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

// This session's plan usage, as the board's ring. In the band only once a
// window passes half, since below that it is noise; in the pane, each window
// with when it resets.
export const usage: Block = {
  name: 'usage',
  band: ({ ui, usage: u }) => {
    const top = [...shown(u)].sort((a, b) => b.percentUsed - a.percentUsed)[0]
    if (!top || top.percentUsed < 50) return null
    const name = label(top.kind)
    const form = (withName: boolean) => ({
      tree: (
        <ui.Box>
          {Meter(ui, top.percentUsed)}
          {withName && <ui.Text dimColor wrap="truncate">{` ${name}`}</ui.Text>}
        </ui.Box>
      ),
      width: meterText(top.percentUsed).length + (withName ? name.length + 1 : 0),
    })
    return [form(true), form(false)]
  },
  pane: ({ ui, usage: u, now }) => {
    const { Box, Text } = ui
    const limits = shown(u)
    if (!limits.length) return null
    return (
      <Box flexDirection="column">
        {limits.map(l => (
          <Box>
            {Meter(ui, l.percentUsed, true)}
            <Text dimColor>{`  ${label(l.kind)}${l.resetsAt ? ` · resets ${when(l.resetsAt, now)}` : ''}`}</Text>
          </Box>
        ))}
      </Box>
    )
  },
}
