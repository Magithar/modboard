import { CAP } from './board'
import { groupOpen } from './tasks'
import { hhmm } from './clock'
import { words, type Block } from './types'
import { conditions, degrees, weatherLines } from './weather'

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

// The digits' width, and the gap between them and the column beside them.
const DIGITS_WIDE = 17
const GAP = 6

// An alarm's note, unless it only says the time again ("Alarm set for 2 PM"
// beside 14:00): words left once times and alarm words are taken out.
export function noteFor(note: string | undefined) {
  if (!note) return ''
  const rest = note
    .toLowerCase()
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)?\b/g, ' ')
    .replace(/\b(alarm|alarms|set|for|at|to|a|an|the|reminder|remind|me|ring|rings|wake|up|o'?clock|today|tonight)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
  return rest ? note.trim() : ''
}

export const pixelClock: Block = {
  name: 'pixel-clock',
  about: 'big clock, weather, alarm',
  // The band is one line: the time plainly, then the alarm.
  band: ({ ui: { Text }, now, alarms, reminders, ringing }) => {
    if (ringing) return [words(Text, `⏰ ${ringing}`, { color: 'warning', bold: true })]
    const next = nextAlarm([...alarms, ...reminders.map(r => r.at)], now)
    return [...(next ? [words(Text, `${hhmm(now)}  ⏰ ${next}`, { dimColor: true })] : []), words(Text, hhmm(now), { dimColor: true })]
  },
  // The digits, and beside them one column of three rows: the weather, the
  // conditions, the alarm. Too narrow for both, the column goes under them.
  pane: ({ ui: { Box, Text, Button }, now, weather, alarms, reminders, located, ringing, width, act, groupsOpen }) => {
    const rows = pixels(hhmm(now))
    const all = [...new Set([...alarms, ...reminders.map(r => r.at)])]
    const next = nextAlarm(all, now)
    const why = noteFor(reminders.find(r => r.at === next)?.note)
    const [sky, day] = weather ? weatherLines(weather, now) : [located ? '' : 'weather: /board location', '']
    const alarm = ringing ? `⏰ ${ringing}` : next ? `⏰ ${next}${why ? ` · ${why}` : ''}${all.length > 1 ? ` · ${all.length} set` : ''}` : ''
    const column = [
      sky ? (
        <Text bold={!!weather} dimColor={!weather} wrap="truncate">
          {sky}
        </Text>
      ) : null,
      day ? (
        <Text dimColor wrap="truncate">
          {day}
        </Text>
      ) : null,
      alarm ? (
        <Box>
          <Text bold={!!ringing} color={ringing ? 'warning' : undefined} dimColor={!ringing} wrap="truncate">
            {alarm}
          </Text>
          {ringing ? (
            <Box flexShrink={0} marginLeft={2}>
              <Button key="alarm-stop" plain onPress={() => act.stopAlarm()}>
                <Text bold color="success">stop</Text>
              </Button>
            </Box>
          ) : null}
        </Box>
      ) : null,
    ]
    const wide = Math.max(0, ...[sky, day, alarm + (ringing ? '  stop' : '')].map(t => [...t].length))
    const beside = width >= DIGITS_WIDE + GAP + wide + 4
    const digits = (
      <Box flexDirection="column" flexShrink={0}>
        {rows.map(row => (
          <Text color={ringing ? 'warning' : CAP} wrap="truncate">
            {row}
          </Text>
        ))}
      </Box>
    )
    const content = beside ? (
      <Box gap={GAP}>
        {digits}
        <Box flexDirection="column">{column}</Box>
      </Box>
    ) : (
      <Box flexDirection="column">
        {digits}
        {column.some(Boolean) ? (
          <Box flexDirection="column" marginTop={1}>
            {column}
          </Box>
        ) : null}
      </Box>
    )
    // A heading like Limits: open, the digits under it; folded, one line with
    // the time, the weather and the alarm. A ringing alarm opens it.
    const open = ringing || groupOpen(groupsOpen, 'clock')
    const brief = [hhmm(now), weather ? `${conditions(weather.code).sign} ${degrees(weather.temp)}` : '', alarm].filter(Boolean)
    return (
      <Box flexDirection="column">
        <Box>
          <Button key="group-clock" plain onPress={() => act.toggleGroup('clock')}>
            <Text bold>{`${open ? '▾' : '▸'} Clock`}</Text>
          </Button>
          {!open ? <Text dimColor wrap="truncate">{` · ${brief.join(' · ')}`}</Text> : null}
        </Box>
        {open ? (
          <Box marginTop={1} paddingLeft={2}>
            {content}
          </Box>
        ) : null}
      </Box>
    )
  },
}
