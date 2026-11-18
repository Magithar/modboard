// Rebuilds docs/system.html from docs/system.txt, then docs/system.png with
// headless Chrome when it is installed. Edit the .txt, then run:
//   node docs/render.mjs

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const CLASS = { '◐': 'c', '●': 'g', '○': 'm' }
const LINES = '┌┐└┘├┤┬┴┼─│▶▼▲'

const body = fs
  .readFileSync(path.join(DIR, 'system.txt'), 'utf8')
  .split('\n')
  .map(line => {
    const title = /^(  [A-Z][A-Z ']+)(.*)$/.exec(line)
    if (title) return `<span class="h">${esc(title[1])}</span><span class="d">${esc(title[2])}</span>`
    return [...line].map(ch => (LINES.includes(ch) ? `<span class="d">${ch}</span>` : CLASS[ch] ? `<span class="${CLASS[ch]}">${ch}</span>` : esc(ch))).join('')
  })
  .join('\n')

const version = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'package.json'), 'utf8')).version
const page = `<!doctype html><html><head><meta charset="utf-8"><title>agent-board system</title>
<style>
body{margin:0;background:#141414}
.wrap{padding:28px 30px;display:inline-block}
.t{font:600 15px -apple-system,sans-serif;color:#e8e8e8;margin:0 0 4px}
.s{font:13px -apple-system,sans-serif;color:#8a8a8a;margin:0 0 16px}
pre{margin:0;background:#0c0c0c;border:1px solid #2a2a2a;border-radius:10px;padding:22px 24px;
font:13px/1.17 Menlo,"SF Mono",monospace;color:#dcdcdc}
.d{color:#5e5e5e} .h{color:#d97757;font-weight:700} .c{color:#d97757} .g{color:#4ec27a} .m{color:#9a9a9a}
</style></head><body><div class="wrap">
<p class="t">agent-board · how it fits together</p>
<p class="s">v${version} · one CLI owns the board; Claude sessions and other agents all go through it</p>
<pre>${body}</pre></div></body></html>`
fs.writeFileSync(path.join(DIR, 'system.html'), page)
console.log('wrote docs/system.html')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if (!fs.existsSync(CHROME)) process.exit(console.log('no Chrome found: open system.html and screenshot it'))
execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1040,1240',
  `--screenshot=${path.join(DIR, 'system.png')}`, pathToFileURL(path.join(DIR, 'system.html')).href,
], { stdio: 'ignore' })
console.log('wrote docs/system.png')
