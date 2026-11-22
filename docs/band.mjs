// Draws the band, the line above Claude Code's prompt, as docs/band.png with
// headless Chrome: the text and colours the band uses, at 100 columns.
//   node docs/band.mjs

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const COLS = 100

// Each part: [text, class]. Dim is the terminal's dim, ok green, warn yellow.
const parts = [
  [['2 waiting', 'dim'], [' · ', 'dim'], ['1 active', 'ok']],
  [[' T-005 ', 'box']],
  [['Sonnet 5.5', 'bold']],
  [['low', 'bold']],
]
// blocks, in the logo's orange, then modBOARD: the two buttons of the board block.
const end = [['blocks', 'capbold'], ['   ', ''], ['modBOARD', 'okbold']]
const len = p => p.reduce((n, [t]) => n + [...t].length, 0)
const span = p => p.map(([t, c]) => `<span class="${c}">${t}</span>`).join('')
const left = parts.map(span).join('   ')
const used = parts.reduce((n, p) => n + len(p), 0) + 3 * (parts.length - 1)
const gap = COLS - 4 - used - len(end) - 1
const line = `${left}${' '.repeat(gap)}${span(end)} <span class="dim">[-]</span>`
const rule = `<span class="rule">${'─'.repeat(COLS)}</span>`

const page = `<!doctype html><html><head><meta charset="utf-8"><title>modboard band</title>
<style>
body{margin:0;background:#141414}
.wrap{padding:24px 26px;display:inline-block}
pre{margin:0;background:#0c0c0c;border:1px solid #2a2a2a;border-radius:10px;padding:18px 22px;
font:13px/1.35 Menlo,"SF Mono",monospace;color:#dcdcdc}
.dim{color:#8a8a8a} .ok{color:#4ec27a} .okbold{color:#4ec27a;font-weight:700} .box{background:#e5b94e;color:#0c0c0c;font-weight:700} .warn{color:#e5b94e} .capbold{color:#F27238;font-weight:700} .bold{color:#f2f2f2;font-weight:700}
.rule{color:#3a3a3a} .prompt{color:#f2f2f2}
</style></head><body><div class="wrap"><pre>${line}

${rule}
<span class="prompt">❯</span>
${rule}</pre></div></body></html>`
fs.writeFileSync(path.join(DIR, 'band.html'), page)
execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
  `--window-size=${Math.ceil(COLS * 7.83 + 100)},${172}`,
  `--screenshot=${path.join(DIR, 'band.png')}`, pathToFileURL(path.join(DIR, 'band.html')).href,
], { stdio: 'ignore' })
console.log('wrote docs/band.png')
