// A project's own task file, read for display. It is not the board: nothing
// in it can be claimed, and the board never writes it. `board taskfile`
// prints it, and the mod's taskfile block shows it in the /board pane.
//
// What it reads:
//   headings      become sections. A heading that names a priority
//                 ("## P0 — foundation", "## Sync (P1)") gives it to every
//                 item under it, down to the next heading at its level.
//   list items    "- ", "* ", "+ ", "1. ", with "[ ]" / "[x]" for done. An
//                 item may lead with its own priority ("- [ ] P2 Benchmarks"),
//                 which wins over its heading's. Struck through
//                 ("~~old idea~~") counts as done.
//   tables        any table with a task column and a priority or status
//                 column, one item per row; a status of done, complete or ✅
//                 counts as checked off.
// Everything else (prose, code blocks, other tables) is left out. And when a
// file marks any item done or not (a checkbox, a status), its plain bullets
// are notes, not tasks, and are left out too.

import fs from 'node:fs'
import path from 'node:path'

export const NAMES = ['task.md', 'tasks.md', 'todo.md']
// Where a task file is looked for, in order, from the project's root.
export const PLACES = ['.', 'docs']

// The first of NAMES in the first of PLACES that has one, matched without
// regard to case, or null.
export function findTaskFile(root) {
  for (const place of PLACES) {
    const dir = path.join(root, place)
    let entries
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of NAMES) {
      const hit = entries.find(e => e.toLowerCase() === name)
      // A broken link or an unreadable entry is no task file, not an error.
      if (hit && fs.statSync(path.join(dir, hit), { throwIfNoEntry: false })?.isFile()) return path.join(dir, hit)
    }
  }
  return null
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/
const FENCE = /^\s*(```|~~~)/
const ROW = /^\s*\|(.*)\|\s*$/
const RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
// A priority named in a heading: P0 to P9, standing alone.
const NAMED = /(?:^|[\s(\[—–-])P(\d)(?=$|[\s)\]:—–,-])/
// A priority leading an item: "P2 Benchmarks", "P1: Sync", "[P0] Fix".
const LEADING = /^\[?P(\d)\]?[:\s]\s*/
// Status marks and a trailing "complete" on a heading, which say nothing the
// items under it do not.
const MARKS = /[✅⬜⬛\u{1F7E0}-\u{1F7EB}\u{1F534}\u{1F535}❌✔️⬅➡]/gu
const DONE = /^(done|complete|completed|closed|shipped|x|\[x\])$|✅|✔/i

// Markdown's marks, taken off for display: **bold**, _em_, `code`,
// [links](url), ~~struck~~. The words stay.
const plain = text =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(MARKS, '')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:])/g, '$1$2')
    .trim()

const priorityIn = text => {
  const m = NAMED.exec(text)
  return m ? Number(m[1]) : null
}

const cells = line => ROW.exec(line)[1].split('|').map(c => c.trim())
const column = (header, pattern) => header.findIndex(h => pattern.test(h))

export function parseTaskFile(text) {
  const lines = text.split(/\r?\n/)
  const items = []
  let section = ''
  // Headings still in force: their level and the priority each gives.
  let open = []
  const inherited = () => open.findLast(h => h.priority !== null)?.priority ?? null
  let fenced = false

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue

    const h = HEADING.exec(line)
    if (h) {
      const level = h[1].length
      section = h[2].replace(MARKS, '').replace(/\s+complete\s*$/i, '').replace(/\s+/g, ' ').trim()
      open = [...open.filter(o => o.level < level), { level, priority: priorityIn(h[2]) }]
      continue
    }

    // A table: a header row, then a rule row.
    if (ROW.test(line) && n + 1 < lines.length && RULE.test(lines[n + 1])) {
      const header = cells(line)
      const task = column(header, /^(task|title|item|todo|what)$/i)
      const prio = column(header, /^(priority|prio|p)$/i)
      const status = column(header, /^(status|state|done)$/i)
      n++
      if (task < 0 || (prio < 0 && status < 0)) {
        while (n + 1 < lines.length && ROW.test(lines[n + 1])) n++
        continue
      }
      while (n + 1 < lines.length && ROW.test(lines[n + 1])) {
        const row = cells(lines[++n])
        if (!row[task]) continue
        const p = prio >= 0 ? /P?(\d)/i.exec(row[prio] ?? '') : null
        items.push({
          text: plain(row[task]),
          done: status >= 0 ? DONE.test(row[status] ?? '') : null,
          section,
          depth: 0,
          priority: p ? Number(p[1]) : inherited(),
        })
      }
      continue
    }

    const m = ITEM.exec(line)
    if (!m) continue
    const lead = LEADING.exec(m[3])
    const text = lead ? m[3].slice(lead[0].length) : m[3]
    items.push({
      text: plain(text),
      done: text.startsWith('~~') ? true : m[2] === undefined ? null : m[2] !== ' ',
      section,
      depth: Math.floor(m[1].replace(/\t/g, '  ').length / 2),
      priority: lead ? Number(lead[1]) : inherited(),
    })
  }
  return items.some(i => i.done !== null) ? items.filter(i => i.done !== null) : items
}

// { file, items } for the task file under `root`, or { file: null, items: [] }.
// `file` is its path from the root: "TASKS.md", "docs/TASKS.md".
export function readTaskFile(root) {
  const file = findTaskFile(root)
  if (!file) return { file: null, items: [] }
  return { file: path.relative(root, file), items: parseTaskFile(fs.readFileSync(file, 'utf8')) }
}
