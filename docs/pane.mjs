// Draws pictures of the /board pane for the README with headless Chrome, in
// the look of the pane screenshots (pane-board.png): the same background,
// font and colours, and the text each block draws, as the mod lays it out.
//   node docs/pane.mjs [blocks-list] [blocks-order] [pane-clock] [clock-ringing]
//
// The pixel clock's digits are drawn as cells, not font glyphs, so the half
// blocks meet as they do in a terminal.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const COLS = 72
const LINE = 15
const PAD = 9

// The pixel clock's font, as in hooks/blocks/pixel.tsx.
const DIGITS = {
  0: ['█▀█', '█ █', '█▄█'],
  1: ['▀█ ', ' █ ', '▄█▄'],
  2: ['▀▀█', '█▀▀', '█▄▄'],
  3: ['▀▀█', ' ▀█', '▄▄█'],
  4: ['█ █', '▀▀█', '  █'],
  5: ['█▀▀', '▀▀█', '▄▄█'],
  6: ['█▀▀', '█▀█', '█▄█'],
  7: ['▀▀█', '  █', '  █'],
  8: ['█▀█', '█▀█', '█▄█'],
  9: ['█▀█', '▀▀█', '▄▄█'],
  ':': [' ', '▀', '▀'],
}
const pixels = time => [0, 1, 2].map(row => [...time].map(ch => DIGITS[ch][row]).join(' '))

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const CELL = { '▀': 't', '▄': 'b', '█': 'f', ' ': 'e' }
// A run: [text, class]. Class "px" draws pixel cells in the run's colour class.
const run = ([text, cls = '']) =>
  cls.startsWith('px')
    ? `<span class="${cls.slice(3)}">${[...text].map(ch => `<span class="px ${CELL[ch] ?? 'e'}"></span>`).join('')}</span>`
    : `<span class="${cls}">${esc(text)}</span>`
const len = runs => runs.reduce((n, [t]) => n + [...t].length, 0)
// A line: runs on the left, and optionally runs at the right end.
const line = (left = [], right = []) => {
  const gap = right.length ? Math.max(1, COLS - len(left) - len(right)) : 0
  return `<div class="l">${left.map(run).join('')}${' '.repeat(gap)}${right.map(run).join('')}</div>`
}
const blank = () => line([[' ']])
const rule = () => line([[' '], ['─'.repeat(COLS - 2), 'rule']])

const TICKED = [
  ['work', "who's doing what"],
  ['todo', 'your task.md'],
  ['usage', '5-hour limit'],
  ['compact', 'context bar + compact button'],
  ['pixel-clock', 'big clock, weather, alarm'],
  ['agents', 'who is live'],
]
const tabs = (on, note) => [
  line([[' '], ['Blocks', on === 'blocks' ? 'bold' : 'dim'], ['    '], ['Order', on === 'order' ? 'bold' : 'dim']], note ? [[note, 'warn'], [' ']] : []),
  line([[on === 'blocks' ? ' ━━━━━━' : `${' '.repeat(11)}━━━━━`, 'cap']]),
]

const clockColumn = (time, rows, { ringing } = {}) => {
  const digits = pixels(time)
  return digits.map((d, i) =>
    line([['  '], [d, ringing ? 'px warn' : 'px cap'], ['      '], ...rows[i]]),
  )
}

const PAGES = {
  'blocks-list': [
    ...tabs('blocks', 'saved · added pixel-clock'),
    blank(),
    ...TICKED.map(([name, about]) => {
      const on = name !== 'agents'
      return line([['   '], [`${on ? '[x]' : '[ ]'} ${name.padEnd(13)}${about}`, on ? 'cap' : 'dim']])
    }),
    blank(),
  ],
  'blocks-order': [
    ...tabs('order', 'saved · order changed'),
    blank(),
    ...['pixel-clock', 'work', 'todo', 'usage', 'compact'].map((name, at, all) =>
      line([
        ['   '],
        [`${String(at + 1).padStart(2)}  ${name.padEnd(14)}`, at === 0 ? 'capbold' : ''],
        [' '],
        ['[ ▲ ]', at === 0 ? 'dim' : 'capbold'],
        [' '],
        ['[ ▼ ]', at === all.length - 1 ? 'dim' : 'capbold'],
      ]),
    ),
    blank(),
  ],
  'pane-clock': [
    line([['modBOARD', 'okbold'], [' · claude 1', 'dim']], [['2 waiting', 'dim'], [' · ', 'dim'], ['1 active', 'ok']]),
    blank(),
    line([['▾ Clock', 'bold']]),
    blank(),
    ...clockColumn('09:41', [
      [['☁︎ 24°  Bengaluru', 'bold']],
      [['partly cloudy · H 27°', 'dim']],
      [['⏰ 18:00 · check the deploy', 'dim']],
    ]),
    blank(),
    rule(),
    blank(),
    line([['▾ In progress', 'bold'], [' · 1', 'dim']]),
    blank(),
    line([['  '], ['T-004', 'dim'], ['  Ship release']], [['claude 2', 'dim']]),
    blank(),
    line([['▸ Not started', 'bold'], [' · 2', 'dim']]),
    blank(),
    line([['▸ Done', 'bold'], [' · 6', 'dim']]),
    blank(),
  ],
  'clock-ringing': [
    line([['▾ Clock', 'bold']]),
    blank(),
    ...clockColumn(
      '14:02',
      [
        [['☁︎ 24°  Bengaluru', 'bold']],
        [['partly cloudy · H 27°', 'dim']],
        [['⏰ T-004 done · Ship release', 'warnbold'], ['  '], ['stop', 'okbold']],
      ],
      { ringing: true },
    ),
    blank(),
  ],
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PAGES)
for (const name of names) {
  const lines = PAGES[name]
  // The pane's own ✕, at the top right, as Claude Code draws it.
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>modboard ${name}</title>
<style>
body{margin:0;background:#262626}
.pane{position:relative;padding:${PAD + 8}px ${PAD}px ${PAD}px;width:${COLS}ch;
font:13.5px/${LINE}px Menlo,"SF Mono",monospace;color:#e6e6e6;white-space:pre}
.x{position:absolute;right:6px;top:2px;color:#cfcfcf;font-size:12px}
.l{height:${LINE}px}
.dim{color:#9a9a9a} .bold{font-weight:700;color:#f2f2f2} .ok{color:#5fd068} .okbold{color:#5fd068;font-weight:700}
.cap{color:#F27238} .capbold{color:#F27238;font-weight:700} .warn{color:#f2c200} .warnbold{color:#f2c200;font-weight:700}
.rule{color:#6a6a6a}
.px{display:inline-block;width:1ch;height:${LINE}px;vertical-align:top}
.px.t{background:linear-gradient(currentColor 50%,transparent 50%)}
.px.b{background:linear-gradient(transparent 50%,currentColor 50%)}
.px.f{background:currentColor}
</style></head><body><div class="pane"><span class="x">✕</span>${lines.join('')}</div></body></html>`
  const html = path.join(DIR, `${name}.html`)
  fs.writeFileSync(html, page)
  const width = Math.ceil(COLS * 8.13 + 2 * PAD)
  const height = lines.length * LINE + 2 * PAD + 8
  execFileSync(
    CHROME,
    ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', `--window-size=${width},${height}`, `--screenshot=${path.join(DIR, `${name}.png`)}`, pathToFileURL(html).href],
    { stdio: 'ignore' },
  )
  fs.rmSync(html)
  console.log(`wrote docs/${name}.png`)
}
