// Makes hooks/sounds/alarm.wav, the alarm's chime, from plain sine tones: two
// beeps at 880 Hz (A5), then one at 1320 Hz (E6), each faded in and out over
// 5 ms, then half a second of silence. Nothing is recorded or taken from a
// sound library, so the chime is the project's own, under its licence.
// 16 kHz, 8-bit, mono: about 16 KB.
//
//   node docs/alarm.mjs
import { writeFileSync } from 'node:fs'

const RATE = 16000
// [frequency in Hz (0 is silence), seconds]
const PARTS = [
  [880, 0.12],
  [0, 0.06],
  [880, 0.12],
  [0, 0.06],
  [1320, 0.18],
  [0, 0.5],
]

const samples = []
for (const [freq, seconds] of PARTS) {
  const n = Math.round(RATE * seconds)
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 80, (n - i) / 80)
    samples.push(freq ? Math.round(128 + 90 * fade * Math.sin((2 * Math.PI * freq * i) / RATE)) : 128)
  }
}

// A WAV file: a 44-byte header, then the samples.
const wav = Buffer.alloc(44 + samples.length)
wav.write('RIFF', 0)
wav.writeUInt32LE(36 + samples.length, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16) // format chunk size
wav.writeUInt16LE(1, 20) // PCM
wav.writeUInt16LE(1, 22) // mono
wav.writeUInt32LE(RATE, 24)
wav.writeUInt32LE(RATE, 28) // bytes per second
wav.writeUInt16LE(1, 32) // bytes per sample
wav.writeUInt16LE(8, 34) // bits per sample
wav.write('data', 36)
wav.writeUInt32LE(samples.length, 40)
Buffer.from(samples).copy(wav, 44)

writeFileSync(new URL('../hooks/sounds/alarm.wav', import.meta.url), wav)
