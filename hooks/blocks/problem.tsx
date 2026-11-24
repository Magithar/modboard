import type { Ctx } from './types'
import { tilde } from './attention'

// Why the board couldn't be read, laid out to be read: a red heading, the
// reason under it, and any files it names on rows of their own, cut from the
// start to fit (the end of a path is what tells it apart). The storage-block
// message ends "… The block: <file>, named in <file>"; those become rows.
const FILES = /^(.*?)\. The block: (.+), named in (.+)$/s

export function splitProblem(text: string): { message: string; files: [string, string][] } {
  const m = FILES.exec(text)
  if (!m) return { message: text, files: [] }
  return { message: `${m[1]}.`, files: [['block', m[2]!], ['config', m[3]!]] }
}

const LABEL = 8
const INDENT = 2

const cutStart = (text: string, room: number) => {
  const chars = [...text]
  return chars.length <= room ? text : `…${chars.slice(chars.length - Math.max(1, room - 1)).join('')}`
}

// The project a .modboard/config.json belongs to: where board trust runs.
const projectOf = (config: string) => config.replace(/\/\.(modboard|agent-board)\/config\.json$/, '')
const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

export function Problem(c: Ctx) {
  const { Box, Button, Text } = c.ui
  if (!c.problem) return null
  const { message, files } = splitProblem(c.problem)
  const config = files.find(([label]) => label === 'config')?.[1]
  // Each row is a button, as a handoff's path is: a press copies it, and the
  // row says ✓ copied for a moment. The run row copies the fix itself.
  const rows: { label: string; shown: string; text: string; instead: string }[] = [
    ...files.map(([label, file]) => ({ label, shown: cutStart(tilde(file, c.home), c.width - INDENT - LABEL - 4), text: file, instead: `the ${label} is ${file}` })),
    ...(config
      ? [{ label: 'run', shown: 'board trust', text: `cd ${quote(projectOf(config))} && board trust`, instead: `run board trust in ${projectOf(config)}` }]
      : []),
  ]
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="error">
        board not updating
      </Text>
      {/* Wrapped, not cut: it says what to do. */}
      <Box paddingLeft={INDENT}>
        <Text color="error">{message}</Text>
      </Box>
      {rows.length ? (
        <Box flexDirection="column" paddingLeft={INDENT} marginTop={1}>
          {rows.map(row => {
            const key = `problem-${row.label}`
            const copied = c.copied === key
            return (
              <Box key={key}>
                <Box width={LABEL} flexShrink={0}>
                  <Text dimColor>{row.label}</Text>
                </Box>
                <Button key={`copy-${key}`} plain onPress={(press: { surface: string }) => c.act.copy(key, row.text, press.surface, row.instead)}>
                  <Text color={copied ? 'success' : undefined} dimColor={!copied && row.label !== 'run'} bold={row.label === 'run' && !copied} wrap="truncate" hover={{ underline: true }}>
                    {copied ? '✓ copied' : row.shown}
                  </Text>
                </Button>
              </Box>
            )
          })}
        </Box>
      ) : null}
    </Box>
  )
}
