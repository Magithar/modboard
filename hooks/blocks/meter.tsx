import type { Ctx } from './types'

// One way the board draws "how full": a ring that fills in quarters, and the
// percent. Context and usage both use it, so the same idea always looks the
// same.
export const ring = (percent: number) => (percent < 12.5 ? '○' : percent < 37.5 ? '◔' : percent < 62.5 ? '◑' : percent < 87.5 ? '◕' : '●')

// Colour only when it asks something of you: yellow from 70%, red from 90%.
// With room left it stays plain. Theme colours, so they follow the terminal.
export const tone = (percent: number) => (percent >= 90 ? 'error' : percent >= 70 ? 'warning' : undefined)

// "◕ 72%" as text, for working out widths.
export const meterText = (percent: number) => `${ring(percent)} ${Math.round(percent)}%`

// The ring and its percent, coloured together. `pad` right-aligns the percent,
// so rows of meters line up in the pane.
export function Meter({ Text }: Ctx['ui'], percent: number, pad = false) {
  const color = tone(percent)
  const pct = `${Math.round(percent)}%`
  return [
    <Text color={color}>{ring(percent)}</Text>,
    <Text color={color} dimColor={!color}>{` ${pad ? pct.padStart(4) : pct}`}</Text>,
  ]
}
