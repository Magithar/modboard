import type { Ctx } from './types'
import { YELLOW } from './board'

// How the board draws "how full": a bar, for both the 5-hour limit and the
// context window, so the same idea always looks the same. The used part is in
// its tone, the rest dim, then the percent.

// Colour only when it asks something of you: yellow from 70%, red from 90%.
// With room left it stays plain. Theme colours, so they follow the terminal.
export const tone = (percent: number) => (percent >= 90 ? 'error' : percent >= 70 ? YELLOW : undefined)

export const CELLS = 10
const filled = (percent: number, cells: number) => Math.min(cells, Math.round((percent / 100) * cells))

// A bar's width in columns: its cells, a space, and "100%".
export const barWidth = (cells = CELLS) => cells + 5

// The bar as Text pieces alone: what a Button may hold.
export function barParts({ Text }: Ctx['ui'], percent: number, cells = CELLS) {
  const color = tone(percent)
  return [
    <Text color={color}>{'▓'.repeat(filled(percent, cells))}</Text>,
    <Text dimColor>{'░'.repeat(cells - filled(percent, cells))}</Text>,
    <Text color={color} dimColor={!color}>{` ${String(Math.round(percent)).padStart(3)}%`}</Text>,
  ]
}

export function Bar(ui: Ctx['ui'], percent: number, cells = CELLS) {
  return <ui.Box flexShrink={0}>{barParts(ui, percent, cells)}</ui.Box>
}
