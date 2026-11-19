// A project's own task.md, read for display. It is not the board: nothing in
// it can be claimed, and the board never writes it. `board taskfile` prints
// it, and the mod's taskfile block shows it in the /board pane.
//
// What it reads: headings become sections; list items ("- ", "* ", "+ ",
// "1. ") become items, with "[ ]" / "[x]" saying whether they are done.
// Everything else (prose, code blocks, tables) is left out.

import fs from 'node:fs'
import path from 'node:path'

export const NAMES = ['task.md', 'tasks.md', 'todo.md']

// The first of NAMES in `dir`, matched without regard to case, or null.
export function findTaskFile(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const name of NAMES) {
    const hit = entries.find(e => e.toLowerCase() === name)
    // A broken link or an unreadable entry is no task file, not an error.
    if (hit && fs.statSync(path.join(dir, hit), { throwIfNoEntry: false })?.isFile()) return path.join(dir, hit)
  }
  return null
}

const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/
const FENCE = /^\s*(```|~~~)/

export function parseTaskFile(text) {
  const items = []
  let section = ''
  let fenced = false
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const h = HEADING.exec(line)
    if (h) {
      section = h[1]
      continue
    }
    const m = ITEM.exec(line)
    if (!m) continue
    items.push({
      text: m[3],
      done: m[2] === undefined ? null : m[2] !== ' ',
      section,
      depth: Math.floor(m[1].replace(/\t/g, '  ').length / 2),
    })
  }
  return items
}

// { file, items } for the task file in `dir`, or { file: null, items: [] }.
export function readTaskFile(dir) {
  const file = findTaskFile(dir)
  if (!file) return { file: null, items: [] }
  return { file: path.basename(file), items: parseTaskFile(fs.readFileSync(file, 'utf8')) }
}
