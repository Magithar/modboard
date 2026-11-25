// Secrets for blocks (an API token a command needs), kept in the OS's own
// store: the macOS Keychain, or the Secret Service on Linux (secret-tool).
// Never in a file modBOARD writes, never in a command's arguments, and never
// sent to a display: a block gets one by name at run time, and modBOARD has
// no command that hands one back. Your settings keep only the names.
//
// BOARD_TEST_SECRETS_FILE stands in for the store in tests; nothing else
// reads it.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const SERVICE = 'modboard'
export const SECRET_NAME = /^[a-z][a-z0-9_.-]{0,39}$/i
const VALUE_MAX = 4096

const fail = (message, code = 2) => Object.assign(new Error(message), { code })

function checkName(name) {
  if (!SECRET_NAME.test(name ?? '')) throw fail('a secret name is letters, digits, _ . -, up to 40, starting with a letter')
}

// The stores. Each: set(name, value), get(name) → value | null, remove(name).
const macos = {
  set(name, value) {
    // `security -i` reads the command from stdin, so the value is in no
    // process's arguments. Its line is quoted like a shell's.
    const q = s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    execFileSync('/usr/bin/security', ['-i'], {
      input: `add-generic-password -U -a ${q(name)} -s ${SERVICE} -l ${q(`modBOARD: ${name}`)} -w ${q(value)}\n`,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    if (this.get(name) !== value) throw fail('the keychain did not keep it', 3)
  },
  get(name) {
    try {
      return execFileSync('/usr/bin/security', ['find-generic-password', '-a', name, '-s', SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '')
    } catch {
      return null
    }
  },
  remove(name) {
    try {
      execFileSync('/usr/bin/security', ['delete-generic-password', '-a', name, '-s', SERVICE], { stdio: 'ignore' })
    } catch {}
  },
}

const secretTool = bin => ({
  set(name, value) {
    execFileSync(bin, ['store', `--label=modBOARD: ${name}`, 'service', SERVICE, 'account', name], { input: value, stdio: ['pipe', 'ignore', 'pipe'] })
  },
  get(name) {
    try {
      return execFileSync(bin, ['lookup', 'service', SERVICE, 'account', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '') || null
    } catch {
      return null
    }
  },
  remove(name) {
    try {
      execFileSync(bin, ['clear', 'service', SERVICE, 'account', name], { stdio: 'ignore' })
    } catch {}
  },
})

const fileStore = file => {
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }
  const write = all => fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 })
  return {
    set: (name, value) => write({ ...read(), [name]: value }),
    get: name => read()[name] ?? null,
    remove: name => {
      const all = read()
      delete all[name]
      write(all)
    },
  }
}

export function secretStore() {
  if (process.env.BOARD_TEST_SECRETS_FILE) return fileStore(process.env.BOARD_TEST_SECRETS_FILE)
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/security')) return macos
  if (process.platform === 'linux') {
    const bin = ['/usr/bin/secret-tool', '/usr/local/bin/secret-tool'].find(p => fs.existsSync(p))
    if (bin) return secretTool(bin)
    throw fail('secrets need secret-tool (libsecret) on Linux: install it, then try again', 3)
  }
  throw fail(`secrets aren't supported on ${process.platform} yet`, 3)
}

export function setSecret(name, value, store = secretStore()) {
  checkName(name)
  if (typeof value !== 'string' || !value) throw fail('a secret needs a value')
  if (value.length > VALUE_MAX || /[\r\n\0]/.test(value)) throw fail(`a secret is one line, at most ${VALUE_MAX} characters`)
  store.set(name, value)
  return { secret: name, set: true }
}

export function getSecret(name, store = secretStore()) {
  checkName(name)
  return store.get(name)
}

export function removeSecret(name, store = secretStore()) {
  checkName(name)
  store.remove(name)
  return { secret: name, removed: true }
}

// Every occurrence of a secret's value in a text, masked.
export function mask(text, values) {
  let out = text
  for (const v of values) if (v && v.length >= 4) out = out.split(v).join('••••')
  return out
}
