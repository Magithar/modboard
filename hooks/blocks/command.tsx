import type { Block, Ctx } from './types'
import { words } from './types'

// A block of your own, with no code: the `blocks` setting names it and the
// shell command whose first line of output it shows, as JSON,
//   {"ci": "gh run list -L1 --json conclusion -q '.[0].conclusion'"}
// The name then goes in `band` or `pane` like any built-in block. The setting
// is yours (user config), never the project's, so cloning a repo cannot make
// your session run its commands.
export function commandBlock(name: string, command = ''): Block {
  return {
    name,
    // On the list of blocks: the command it runs. The checks block lists them
    // all under one heading, so each one is off the list by itself.
    about: command || 'your command',
    listed: false,
    band: ({ ui: { Text }, custom }) => {
      const text = custom[name]
      if (!text) return null
      return [words(Text, `${name} ${text}`, { dimColor: true }), words(Text, text, { dimColor: true })]
    },
    pane: c => commandRow(c, name),
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`

// "12 min ago", "3 h ago", "2 d ago".
export function ago(ms: number) {
  const min = Math.max(1, Math.floor(ms / 60_000))
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

// Where a command block stands: fresh; old (its last success was a while ago);
// not updating (its command has failed for a while, the last good result is
// kept); or failing with nothing to show yet.
export type Standing = { text: string; note: string; stale: boolean } | null
export function standing(c: Ctx, name: string): Standing {
  const text = c.custom[name] ?? ''
  const st = c.commandState[name]
  if (!st) return text ? { text, note: '', stale: false } : null
  if (st.failing !== null && c.now - st.failing >= c.staleMs) {
    if (!text) return { text: '', note: 'not updating · the command fails', stale: true }
    return { text, note: `not updating since ${clock(st.ok ?? st.failing)}`, stale: true }
  }
  if (!text) return null
  if (st.ok !== null && c.now - st.ok >= c.staleMs) return { text, note: ago(c.now - st.ok), stale: false }
  return { text, note: '', stale: false }
}

// A result read as good or bad by its words: a failure in red, a success in
// green, anything else plain. A failure wins, so "1 failed, 41 passed" is red.
const BAD = /(^|[^a-z])(fail(s|ed|ure|ing)?|errors?|broken|red)([^a-z]|$)|[✗✘❌]/i
const GOOD = /(^|[^a-z])(success(ful)?|succeeded|pass(es|ed|ing)?|ok|green)([^a-z]|$)|[✓✔✅]/i
// "0 failed" and "0 errors" are no failure: "42 passed, 0 failed" is green.
const NONE = /(^|[^0-9])0 (fail(s|ed|ures?|ing)?|errors?)/gi
export const outcome = (text: string) => {
  const read = text.replace(NONE, ' ')
  return BAD.test(read) ? 'error' : GOOD.test(read) ? 'success' : undefined
}

// One command block as a row: its name, its last good result, and, when it
// is old, its age in grey, or, when its command keeps failing, a yellow
// "not updating since 14:02".
export function commandRow(c: Ctx, name: string) {
  const { Box, Text } = c.ui
  const s = standing(c, name)
  if (!s) return null
  return (
    <Box>
      <Box width={LABEL} flexShrink={0}>
        <Text dimColor>{name}</Text>
      </Box>
      <Box flexShrink={1}>
        {/* Grey unless its colour says something: nothing here is pressed, and white marks what is. */}
        <Text color={outcome(s.text)} dimColor={!outcome(s.text)} wrap="truncate">
          {s.text}
        </Text>
      </Box>
      {s.note ? (
        <Box flexShrink={0}>
          <Text color={s.stale ? 'warning' : undefined} dimColor={!s.stale}>
            {s.text ? ` · ${s.note}` : s.note}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

const NAME = /^[a-z][a-z0-9-]{0,15}$/

// The label column under Project: room for "changes" and a space after it.
export const LABEL = 10

// The `blocks` setting, read: name → command. What it cannot use is left out
// and said in `problems`, so a typo is reported and not silently dropped.
export function parseCommandBlocks(setting: unknown, taken: string[]): { commands: Record<string, string>; problems: string[] } {
  const commands: Record<string, string> = {}
  const problems: string[] = []
  if (setting === undefined || setting === null || String(setting).trim() === '') return { commands, problems }
  let parsed: unknown
  try {
    parsed = JSON.parse(String(setting))
  } catch {
    return { commands, problems: ['the blocks setting is not JSON; write it as {"name": "command"}'] }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { commands, problems: ['the blocks setting must be a JSON object'] }
  for (const [name, command] of Object.entries(parsed)) {
    if (!NAME.test(name)) problems.push(`block name "${name}": use lowercase letters, digits and -, up to 16`)
    else if (taken.includes(name)) problems.push(`block name "${name}" is a built-in block`)
    else if (typeof command !== 'string' || !command.trim()) problems.push(`block "${name}" needs a command`)
    else commands[name] = command
  }
  return { commands, problems }
}

// A command's output as one short line: its first non-empty line, cut to fit.
export const firstLine = (out: string) => (out.split('\n').map(l => l.trim()).find(Boolean) ?? '').slice(0, 60)
