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
  const { Box, Text } = c.ui
  if (!c.problem) return null
  const { message, files } = splitProblem(c.problem)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="error">
        board not updating
      </Text>
      {/* Wrapped, not cut: it says what to do. */}
      <Box paddingLeft={INDENT}>
        <Text color="error">{message}</Text>
      </Box>
      {files.length ? (
        <Box flexDirection="column" paddingLeft={INDENT} marginTop={1}>
          {files.map(([label, file]) => (
            <Box key={`problem-${label}`}>
              <Box width={LABEL} flexShrink={0}>
                <Text dimColor>{label}</Text>
              </Box>
              <Text dimColor wrap="truncate">
                {cutStart(tilde(file, c.home), c.width - INDENT - LABEL - 4)}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}
