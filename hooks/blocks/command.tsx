import type { Block } from './types'
import { words } from './types'

// A block of your own, with no code: the `blocks` setting names it and the
// shell command whose first line of output it shows, as JSON,
//   {"ci": "gh run list -L1 --json conclusion -q '.[0].conclusion'"}
// The name then goes in `band` or `pane` like any built-in block. The setting
// is yours (user config), never the project's, so cloning a repo cannot make
// your session run its commands.
export function commandBlock(name: string): Block {
  return {
    name,
    band: ({ ui: { Text }, custom }) => {
      const text = custom[name]
      if (!text) return null
      return [words(Text, `${name} ${text}`, { dimColor: true }), words(Text, text, { dimColor: true })]
    },
    pane: ({ ui: { Box, Text }, custom }) => {
      const text = custom[name]
      if (!text) return null
      return (
        <Box>
          <Box width={8}>
            <Text dimColor>{name}</Text>
          </Box>
          <Text wrap="truncate">{text}</Text>
        </Box>
      )
    },
  }
}

const NAME = /^[a-z][a-z0-9-]{0,15}$/

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
