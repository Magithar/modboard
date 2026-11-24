// Draws pictures of the /board pane for the README with headless Chrome, in
// the look of the pane in a terminal: the same background, font and colours,
// and the text each block draws, as the mod lays it out.
//   node docs/pane.mjs [pane-board] [pane-done] [pane-all] [blocks-list] [blocks-order] [pane-clock] [clock-ringing] [pane-checks]
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

// Shown capitalised, as the list draws them; settings keep the lowercase names.
const TICKED = [
  ['Work', "who's doing what", true],
  ['Todo', 'your task.md', true],
  ['Pixel-clock', 'big clock, weather, alarm', true],
  ['Agents', 'who is live', false],
]
const PROJECT = [
  ['Branch', 'current git branch', true],
  ['Changes', 'working tree changes', true],
  ['Ci', 'latest GitHub Actions run on this branch', true],
  ['Prs', 'your open pull requests and reviews', false],
  ['Tests', 'last test result agents recorded', false],
]
const tick = ([name, about, on]) => line([['   '], [`${on ? '[x]' : '[ ]'} ${name.padEnd(13)}${about}`, on ? 'cap' : 'dim']])
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

// A task row: ID, kind in its column, title, and who at the right end.
// A title with a handoff is bold with the headings' arrow (open or folded).
const KIND = { feature: 'feature', bug: 'bug', review: 'review' }
const task = (id, kind, title, who, { warn, handoff } = {}) =>
  line(
    [['  '], [id, 'dim'], ['  '], [(kind ?? '').padEnd(9), kind ? KIND[kind] : ''], ...(handoff ? [[`${handoff === 'open' ? '▾' : '▸'} ${title}`, 'bold']] : [[title]])],
    [[who, warn ? 'warn' : 'dim']],
  )
// Under a handoff, lined up with the title's words past its arrow: its
// points, then its facts.
const UNDER = ' '.repeat(2 + 7 + 9 + 2)
const point = text => line([[UNDER], [`· ${text}`, 'dim']])
const fact = (label, value) => line([[UNDER], [label.padEnd(7), 'dim'], [value]])
// A Limits row: label, a 10-cell bar, the figure, then what goes with it.
const bar = (label, pct, after, cls = 'dim') => {
  const n = Math.round(pct / 10)
  return line([['  '], [label.padEnd(13), 'dim'], ['▓'.repeat(n)], ['░'.repeat(10 - n), 'dim'], [`${pct}%`.padStart(5)], ['   '], [after, cls]])
}

// The three pane pictures share one board: its top, In progress, and the
// groups, folded or open.
const heading = (title, count, open) => line([[`${open ? '▾' : '▸'} ${title}`, 'bold'], [` · ${count}`, 'dim']])
const TOP = [
  line([['modBOARD', 'okbold'], [' · claude 1', 'dim']], [['10 waiting', 'dim'], [' · ', 'dim'], ['3 active', 'ok']]),
  blank(),
  heading('In progress', 3, true),
  blank(),
  task('T-002', 'feature', 'Set up the database', 'claude 4'),
  task('T-006', 'feature', 'Add dark mode', 'codex 1 · idle', { warn: true }),
  task('T-007', 'review', 'Review T-003: Cache API results', 'claude 2'),
  blank(),
]
const NOT_STARTED = [
  ['T-009', 'feature', 'Add export to CSV'],
  ['T-010', 'feature', 'Mobile layout'],
  ['T-011', 'feature', 'Localise strings'],
  ['T-012', 'feature', 'Add search'],
  ['T-013', null, 'Benchmark the parser'],
  ['T-014', 'bug', 'Fix the error page'],
  ['T-015', 'feature', 'Onboarding tour'],
  ['T-016', 'feature', 'Keyboard shortcuts'],
]
const DONE = [
  ['T-004', 'feature', 'Add a test script', 'claude 4'],
  ['T-001', 'feature', 'Add a login page', 'codex 1'],
  ['T-003', 'bug', 'Fix the signup form', 'claude 2'],
  ['T-017', null, 'Write the README', 'you'],
  ['T-018', 'feature', 'Add a favicon', 'codex 1'],
  ['T-019', 'review', 'Review T-001: Add a login page', 'claude 2'],
]
const TODO = [
  ['P0', 'Fix the signup crash'],
  ['P0', 'Rate-limit the login API'],
  ['P0', 'Rotate the leaked staging key'],
  ['P1', 'Empty states for the inbox'],
  ['P1', 'Loading skeletons'],
  ['P2', 'Animate the sidebar'],
  ['P2', 'Offline mode'],
  ['—', 'Dark mode'],
  ['—', 'Keyboard shortcuts'],
]
const todoHeading = (open, filter) => line([[`${open ? '▾' : '▸'} To do`, 'bold'], [' · 9 open', 'dim'], ['   '], [filter, 'bold']])
const LIMITS = [
  line([['▾ Limits', 'bold']]),
  blank(),
  bar('context', 3, 'compact', 'bold'),
  blank(),
  bar('5-hour limit', 21, 'resets 08:00'),
  blank(),
]

const PAGES = {
  'pane-board': [
    ...TOP,
    line([['▾ Unfinished', 'bold'], [' · 2', 'dim']]),
    blank(),
    task('T-005', 'feature', 'Ghost task: settings screen', 'claude 1', { warn: true, handoff: 'open' }),
    blank(),
    point('layout done in src/settings.tsx'),
    point("saving isn't wired yet"),
    blank(),
    fact('where', 'settings @ 4f2a9c1'),
    blank(),
    fact('path', '~/code/app-settings'),
    blank(),
    fact('files', 'src/settings.tsx, src/settings.css'),
    blank(),
    fact('check', 'npm test passed at 4f2a9c1'),
    blank(),
    task('T-008', 'bug', 'Fix login redirect', 'codex 1', { warn: true, handoff: 'folded' }),
    blank(),
    heading('Not started', 8),
    blank(),
    heading('Done', 6),
    blank(),
    rule(),
    blank(),
    todoHeading(false, 'P0'),
    blank(),
    rule(),
    blank(),
    ...LIMITS,
  ],
  'pane-done': [
    ...TOP,
    heading('Unfinished', 2),
    blank(),
    heading('Not started', 8),
    blank(),
    heading('Done', 6, true),
    blank(),
    ...DONE.map(([id, kind, title, who]) => task(id, kind, title, who)),
    blank(),
    rule(),
    blank(),
    todoHeading(true, 'P0'),
    blank(),
    line([['  '], ['from TASKS.md', 'dim']]),
    blank(),
    ...TODO.filter(([p]) => p === 'P0').map(([, item]) => line([['  · '], [item]])),
    blank(),
    rule(),
    blank(),
    ...LIMITS,
  ],
  'pane-all': [
    ...TOP,
    heading('Unfinished', 2),
    blank(),
    heading('Not started', 8, true),
    blank(),
    ...NOT_STARTED.map(([id, kind, title]) => task(id, kind, title, '')),
    blank(),
    heading('Done', 6),
    blank(),
    rule(),
    blank(),
    todoHeading(true, 'all'),
    blank(),
    line([['  '], ['from TASKS.md', 'dim']]),
    blank(),
    ...TODO.map(([p, item]) => line([[p.padEnd(4), 'dim'], [item]])),
    blank(),
    rule(),
    blank(),
    line([['▸ Limits', 'bold'], [' · context 3% · 5-hour 21%', 'dim']]),
    blank(),
  ],
  'blocks-list': [
    ...tabs('blocks', 'saved · added pixel-clock'),
    blank(),
    ...TICKED.map(tick),
    // The groups below, each a row that opens or folds it.
    blank(),
    line([[' '], ['▼ Project']]),
    ...PROJECT.map(tick),
    blank(),
    line([[' '], ['▶ Limits']]),
    blank(),
  ],
  'blocks-order': [
    ...tabs('order', 'saved · order changed'),
    blank(),
    ...['Pixel-clock', 'Work', 'Todo', 'Project', 'Limits'].map((name, at, all) =>
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
    task('T-004', 'feature', 'Ship release', 'claude 2'),
    blank(),
    line([['▸ Not started', 'bold'], [' · 2', 'dim']]),
    blank(),
    line([['▸ Done', 'bold'], [' · 6', 'dim']]),
    blank(),
  ],
  'pane-checks': [
    line([['▾ Project', 'bold']]),
    blank(),
    line([['  '], ['tests   ', 'dim'], ['✗ 1 failed, 41 passed · login', 'err']]),
    blank(),
    line([['  '], ['ci      ', 'dim'], ['success', 'ok'], [' · 12 min ago', 'dim']]),
    blank(),
    line([['  '], ['deploy  ', 'dim'], ['✓ live · v0.9.0', 'ok'], [' · not updating since 14:02', 'warn']]),
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
.rule{color:#6a6a6a} .err{color:#ff6b6b}
.feature{color:#6698BF} .bug{color:#BE6565} .review{color:#9688BD}
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
