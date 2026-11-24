// How far the pane moves for one turn of the wheel. Claude Code moves a pane's
// body one row a tick, so a long board crawled; a terminal moves three, and so
// does the pane now.
export const WHEEL_ROWS = 3

// Where the pane's window lands for a move: the row it showed plus `by`
// widened to WHEEL_ROWS a tick, kept within the board. A page key or Home/End
// (a move of a window or more) goes as Claude Code asked.
export function scrolled(e: { offset: number; by: number; bodyRows: number; contentRows: number }) {
  if (e.by === 0 || Math.abs(e.by) >= e.bodyRows) return e.offset
  const from = e.offset - e.by
  const last = Math.max(0, e.contentRows - e.bodyRows)
  return Math.max(0, Math.min(last, from + e.by * WHEEL_ROWS))
}
