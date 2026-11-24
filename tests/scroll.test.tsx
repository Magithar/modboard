import { expect, test } from 'claude-code/testing'
import { scrolled, WHEEL_ROWS } from '../hooks/scroll'

// Claude Code hands the hook the window's next first row (`offset`): the row
// it shows now plus `by`, clamped to the board.
const at = (now: number, by: number, bodyRows = 20, contentRows = 100) => scrolled({ offset: Math.max(0, Math.min(contentRows - bodyRows, now + by)), by, bodyRows, contentRows })

test('a wheel tick on the pane moves three rows, either way', async () => {
  expect(WHEEL_ROWS).toBe(3)
  expect(at(10, 1)).toBe(13)
  expect(at(10, -1)).toBe(7)
  // Ticks that crowd come summed: each still three rows.
  expect(at(10, 2)).toBe(16)
})

test('the wheel stops at the top and the end of the board', async () => {
  expect(at(1, -1)).toBe(0)
  expect(at(0, -1)).toBe(0)
  expect(at(79, 1)).toBe(80)
  expect(at(80, 1)).toBe(80)
  // A board that fits doesn't move.
  expect(at(0, 1, 20, 10)).toBe(0)
})

test('page keys and Home/End move as Claude Code asks', async () => {
  expect(at(10, 20)).toBe(30)
  expect(at(30, -20)).toBe(10)
  expect(at(10, 100)).toBe(80)
})
