import { words, type Block } from './types'

const pad = (n: number) => String(n).padStart(2, '0')
export const hhmm = (now: number) => `${pad(new Date(now).getHours())}:${pad(new Date(now).getMinutes())}`

export const clock: Block = {
  name: 'clock',
  // Off the list of blocks: pixel-clock is the one to tick.
  listed: false,
  band: ({ ui: { Text }, now }) => [words(Text, hhmm(now), { dimColor: true })],
  pane: ({ ui: { Text }, now }) => <Text dimColor>{hhmm(now)}</Text>,
}
