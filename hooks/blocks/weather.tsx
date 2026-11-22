import type { Weather } from '../../types'
import { words, type Block } from './types'

// Open-Meteo's weather codes (WMO), as a sign and a word or two.
export function conditions(code: number): { sign: string; word: string } {
  if (code === 0) return { sign: '☀', word: 'clear' }
  if (code <= 2) return { sign: '⛅', word: 'partly cloudy' }
  if (code === 3) return { sign: '☁', word: 'cloudy' }
  if (code === 45 || code === 48) return { sign: '≋', word: 'fog' }
  if (code >= 51 && code <= 57) return { sign: '☂', word: 'drizzle' }
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { sign: '☂', word: 'rain' }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { sign: '❄', word: 'snow' }
  if (code >= 95) return { sign: '⚡', word: 'thunderstorm' }
  return { sign: '·', word: 'unknown' }
}

// A reading older than this says how old it is: the fetch failed since.
export const STALE_MS = 45 * 60_000

export const degrees = (n: number) => `${Math.round(n)}°`

// "18 min old", "3 h old": how long ago the last reading came in.
export function age(w: Weather, now: number) {
  const min = Math.round((now - w.at) / 60_000)
  if (now - w.at < STALE_MS) return ''
  return min < 120 ? `${min} min old` : `${Math.round(min / 60)} h old`
}

// The weather lines beside the pixel clock: the sign and temperature, the
// place, then the conditions and the day's high.
export function weatherLines(w: Weather, now: number): string[] {
  const { sign, word } = conditions(w.code)
  const old = age(w, now)
  return [`${sign}  ${degrees(w.temp)}`, w.place, `${word} · H ${degrees(w.high)}${old ? ` · ${old}` : ''}`]
}

export const weather: Block = {
  name: 'weather',
  // On the band alone: in the pane the weather sits beside the pixel clock.
  band: ({ ui: { Text }, weather: w, now }) => {
    if (!w) return null
    const { sign } = conditions(w.code)
    const short = `${sign} ${degrees(w.temp)}`
    const old = age(w, now)
    return [words(Text, old ? `${short} (${old})` : short, { dimColor: !!old }), words(Text, short, { dimColor: !!old })]
  },
}
