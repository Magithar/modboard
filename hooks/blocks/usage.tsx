import type { Block, Ctx } from './types'

const LABEL: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'weekly limit', spend_limit: 'spend limit' }
const SHORT: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const label = (kind: string) => LABEL[kind] ?? kind
const CELLS = 10
const filled = (percent: number, cells = CELLS) => Math.min(cells, Math.round((percent / 100) * cells))
// Green while there is room, yellow from 70%, red from 90%: theme colours, so
// they follow the person's terminal theme.
const tone = (percent: number) => (percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success')

// The bar's used part in the window's colour, the rest dim, then the percent.
function Meter({ Box, Text }: Ctx['ui'], percent: number, cells = CELLS) {
  return (
    <Box flexShrink={0}>
      <Text color={tone(percent)}>{'▓'.repeat(filled(percent, cells))}</Text>
      <Text dimColor>{'░'.repeat(cells - filled(percent, cells))}</Text>
      <Text color={tone(percent)}>{` ${String(Math.round(percent)).padStart(3)}%`}</Text>
    </Box>
  )
}
const pad = (n: number) => String(n).padStart(2, '0')
const when = (iso: string, now: number) => {
  const d = new Date(iso)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const days = Math.floor((d.getTime() - now) / 86_400_000)
  return days >= 1 ? `in ${days}d` : time
}

// This session's plan usage. In the band only once a window passes half, since
// below that it is noise; in the pane, every window with its reset.
export const usage: Block = {
  name: 'usage',
  band: ({ ui, usage: u }) => {
    const top = [...u.limits].sort((a, b) => b.percentUsed - a.percentUsed)[0]
    if (!top || top.percentUsed < 50) return null
    const form = (name: string, cells: number) => ({
      tree: (
        <ui.Box gap={1}>
          <ui.Text dimColor wrap="truncate">
            {name}
          </ui.Text>
          {Meter(ui, top.percentUsed, cells)}
        </ui.Box>
      ),
      width: name.length + 1 + cells + 5,
    })
    return [form(label(top.kind), CELLS), form(SHORT[top.kind] ?? label(top.kind), 5)]
  },
  pane: ({ ui, usage: u, now }) => {
    const { Box, Text } = ui
    if (!u.limits.length) return null
    return (
      <Box flexDirection="column">
        <Text bold>Usage</Text>
        {u.limits.map(l => (
          <Box>
            <Box width={15}>
              <Text dimColor>{label(l.kind)}</Text>
            </Box>
            {Meter(ui, l.percentUsed)}
            {l.resetsAt && <Text dimColor>{`   resets ${when(l.resetsAt, now)}`}</Text>}
          </Box>
        ))}
      </Box>
    )
  },
}
