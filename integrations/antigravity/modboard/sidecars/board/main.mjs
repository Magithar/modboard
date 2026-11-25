// modBOARD's side panel for Antigravity. A thin shell: the page and the work
// come from the modboard package installed on this machine (lib/sidecar.mjs),
// which `board antigravity` names in MODBOARD_HOME when it installs this
// plugin, so updating modboard updates the panel. MODBOARD_DEFAULT_DIR is the
// board it shows when the conversation's folder has none.
//
// Antigravity starts this file with its own Node.js and sets the port;
// 'sidecar_sdk' is resolved by Antigravity.

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Response, SidecarApp } from 'sidecar_sdk'

const HOME = process.env.MODBOARD_HOME
const app = new SidecarApp()
const json = (body, status = 200) => new Response(JSON.stringify(body), { contentType: 'application/json', status })

if (!HOME) {
  app.page('/', () => '<!doctype html><meta charset="utf-8"><p style="font:14px system-ui;padding:16px">modBOARD isn\'t set up here yet: run <code>board antigravity</code> in a terminal, then turn this plugin off and on again.</p>')
} else {
  const { boardBridge, sidecarPage } = await import(pathToFileURL(path.join(HOME, 'lib', 'sidecar.mjs')).href)
  const bridge = boardBridge({ bin: path.join(HOME, 'bin', 'board.mjs'), fallback: process.env.MODBOARD_DEFAULT_DIR || undefined })
  process.on('exit', () => bridge.close())

  app.page('/', () => sidecarPage())
  // POST only, so it carries the sidecar's token: no other page or program
  // on this machine can read the board or press its buttons through here.
  app.api('/api/call', async data => {
    try {
      return await bridge.call(data)
    } catch (err) {
      return json({ error: String(err?.message ?? err), code: err?.code ?? -32603 }, 400)
    }
  })
}

app.run()
