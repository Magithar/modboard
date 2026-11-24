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

export function Problem(c: Ctx) {
  const { Box, Button, Text } = c.ui
  if (!c.problem) return null
  const { message, files } = splitProblem(c.problem)
  // Each file is a button, as a handoff's path is: a press copies the path,
  // so the file can be opened and read, and the row says ✓ copied for a
  // moment. Nothing here approves the code: that is a person's choice, made
  // at a terminal after reading it.
  const rows = files.map(([label, file]) => ({ label, shown: cutStart(tilde(file, c.home), c.width - INDENT - LABEL - 4), text: file, instead: `the ${label} is ${file}` }))
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
          {rows.map((row, i) => {
            const key = `problem-${row.label}`
            const copied = c.copied === key
            return (
              // A blank line between the rows, as between a handoff's facts.
              <Box key={key} marginTop={i ? 1 : 0}>
                <Box width={LABEL} flexShrink={0}>
                  <Text dimColor>{row.label}</Text>
                </Box>
                <Button key={`copy-${key}`} plain onPress={(press: { surface: string }) => c.act.copy(key, row.text, press.surface, row.instead)}>
                  <Text color={copied ? 'success' : undefined} dimColor={!copied} wrap="truncate" hover={{ underline: true }}>
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
