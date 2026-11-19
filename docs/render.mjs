// Rebuilds each diagram's page from its plain text, docs/<name>.txt, then
// docs/<name>.png with headless Chrome when it is installed. Edit the .txt,
// then run (with no names, every diagram):
//   node docs/render.mjs [system] [blocks] [demo]

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const CLASS = { '◐': 'c', '●': 'g', '○': 'm' }
const LINES = '┌┐└┘├┤┬┴┼─│▶▼▲'

const TITLES = {
  system: ['how it fits together', 'one CLI owns the board; Claude sessions and other agents all go through it'],
  blocks: ['how blocks work', 'storage blocks hold the board; display blocks draw it in each Claude session'],
  demo: ['a real run', 'two agents share one board through the CLI: a lost race, a handoff, a verified done'],
}
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const version = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'package.json'), 'utf8')).version
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TITLES)

for (const name of names) {
  const text = fs.readFileSync(path.join(DIR, `${name}.txt`), 'utf8')
  const [title, subtitle] = TITLES[name] ?? [name, '']
  const body = text
    .split('\n')
    .map(line => {
      const title = /^(  [A-Z][A-Z ';,]+)((?::  | {2,}).*)?$/.exec(line)
      if (title) return `<span class="h">${esc(title[1])}</span><span class="d">${esc(title[2] ?? '')}</span>`
      const command = /^(  )(\$ )(.*)$/.exec(line)
      if (command) return `${command[1]}<span class="d">${command[2]}</span><span class="p">${esc(command[3])}</span>`
      return [...line].map(ch => (LINES.includes(ch) ? `<span class="d">${ch}</span>` : CLASS[ch] ? `<span class="${CLASS[ch]}">${ch}</span>` : esc(ch))).join('')
    })
    .join('\n')

  const page = `<!doctype html><html><head><meta charset="utf-8"><title>agent-board ${name}</title>
  <style>
  body{margin:0;background:#141414}
  .wrap{padding:28px 30px;display:inline-block}
  .t{font:600 15px -apple-system,sans-serif;color:#e8e8e8;margin:0 0 4px}
  .s{font:13px -apple-system,sans-serif;color:#8a8a8a;margin:0 0 16px}
  pre{margin:0;background:#0c0c0c;border:1px solid #2a2a2a;border-radius:10px;padding:22px 24px;
  font:13px/1.17 Menlo,"SF Mono",monospace;color:#dcdcdc}
  .d{color:#5e5e5e} .h{color:#d97757;font-weight:700} .c{color:#d97757} .g{color:#4ec27a} .m{color:#9a9a9a} .p{color:#f0f0f0;font-weight:700}
  </style></head><body><div class="wrap">
  <p class="t">agent-board · ${title}</p>
  <p class="s">v${version} · ${subtitle}</p>
  <pre>${body}</pre></div></body></html>`
  fs.writeFileSync(path.join(DIR, `${name}.html`), page)
  console.log(`wrote docs/${name}.html`)

  if (!fs.existsSync(CHROME)) {
    console.log(`no Chrome found: open docs/${name}.html and screenshot it`)
    continue
  }
  // The window fits the drawing: 13px Menlo is 7.83 px a column, 15.2 a line.
  const lines = text.split('\n')
  const width = Math.ceil(Math.max(...lines.map(l => [...l].length)) * 7.83 + 130)
  const height = Math.ceil(lines.length * 15.21 + 150)
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', `--window-size=${width},${height}`,
    `--screenshot=${path.join(DIR, `${name}.png`)}`, pathToFileURL(path.join(DIR, `${name}.html`)).href,
  ], { stdio: 'ignore' })
  console.log(`wrote docs/${name}.png`)
}
