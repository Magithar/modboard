import { CAP } from './board'
import { hhmm } from './clock'
import { words, type Block } from './types'
import { weatherLines } from './weather'

// Each digit three rows tall and three wide, in half blocks, so it is six
// pixels high.
const DIGITS: Record<string, [string, string, string]> = {
  '0': ['█▀█', '█ █', '█▄█'],
  '1': ['▀█ ', ' █ ', '▄█▄'],
  '2': ['▀▀█', '█▀▀', '█▄▄'],
  '3': ['▀▀█', ' ▀█', '▄▄█'],
  '4': ['█ █', '▀▀█', '  █'],
  '5': ['█▀▀', '▀▀█', '▄▄█'],
  '6': ['█▀▀', '█▀█', '█▄█'],
  '7': ['▀▀█', '  █', '  █'],
  '8': ['█▀█', '█▀█', '█▄█'],
  '9': ['█▀█', '▀▀█', '▄▄█'],
  ':': [' ', '▀', '▀'],
}

// "14:32" as three rows of pixel digits, a space between each.
export function pixels(text: string): [string, string, string] {
  const glyphs = [...text].map(ch => DIGITS[ch] ?? ['   ', '   ', '   '])
  return [0, 1, 2].map(row => glyphs.map(g => g[row]).join(' ')) as [string, string, string]
}

// The time the next alarm goes off, from now: the soonest of the day's
// times, or tomorrow's first once they have all passed.
export function nextAlarm(alarms: string[], now: number) {
  if (!alarms.length) return ''
  const at = hhmm(now)
  return [...alarms].sort().find(a => a > at) ?? [...alarms].sort()[0]!
}

const WIDE = 23 + 6

export const pixelClock: Block = {
  name: 'pixel-clock',
  about: 'big clock, weather, alarm',
  // The band is one line: the time plainly, then the alarm.
  band: ({ ui: { Text }, now, alarms, reminders, ringing }) => {
    if (ringing) return [words(Text, `⏰ ${ringing}`, { color: 'warning', bold: true })]
    const next = nextAlarm([...alarms, ...reminders.map(r => r.at)], now)
    return [...(next ? [words(Text, `${hhmm(now)}  ⏰ ${next}`, { dimColor: true })] : []), words(Text, hhmm(now), { dimColor: true })]
  },
  pane: ({ ui: { Box, Text, Button }, now, weather, alarms, reminders, ringing, width, act }) => {
    const rows = pixels(hhmm(now))
    const lines = weather ? weatherLines(weather, now) : []
    const beside = weather && width >= WIDE + Math.max(...lines.map(l => [...l].length))
    const all = [...new Set([...alarms, ...reminders.map(r => r.at)])]
    const next = nextAlarm(all, now)
    const why = reminders.find(r => r.at === next)?.note
    return (
      <Box flexDirection="column">
        <Box gap={6}>
          <Box flexDirection="column" flexShrink={0}>
            {rows.map(row => (
              <Text color={ringing ? 'warning' : CAP} wrap="truncate">
                {row}
              </Text>
            ))}
          </Box>
          {beside ? (
            <Box flexDirection="column">
              {lines.map((line, i) => (
                <Text bold={i === 0} dimColor={i > 0} wrap="truncate">
                  {line}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
        {weather && !beside ? (
          <Text dimColor wrap="truncate">
            {lines.join('  ·  ')}
          </Text>
        ) : null}
        {ringing ? (
          <Box marginTop={1}>
            <Text bold color="warning">{`⏰ ${ringing}  `}</Text>
            <Button key="alarm-stop" plain onPress={() => act.stopAlarm()}>
              <Text bold color="warning">stop</Text>
            </Button>
          </Box>
        ) : next ? (
          <Box marginTop={1}>
            <Text dimColor wrap="truncate">{`⏰ ${all.length > 1 ? `next ${next}` : next}${why ? ` · ${why}` : ''}${all.length > 1 ? ` · ${all.length} set` : ''}`}</Text>
          </Box>
        ) : null}
      </Box>
    )
  },
}
