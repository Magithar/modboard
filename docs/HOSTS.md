# modBOARD in each app

Every app reaches the board one of two ways:

- **The `board` CLI.** Any agent that can run a shell command can claim,
  note, hand off and finish tasks. This is how agents work from the board,
  everywhere. `docs/AGENT-SETUP.md` sets a project up for it.
- **`board mcp`.** A local MCP server that shows the board. An app that
  draws MCP Apps shows it as a live widget, with Claim, Note and Release
  buttons for the person; an app that doesn't gets the same board as text.

Both need the CLI installed: `npm install -g modboard`.

Nothing is listed as working until it has been tried in that app. "Not yet
tried" means the setup below follows the app's own documentation, and no
more.

| App | How | Board as | Tried |
|---|---|---|---|
| Claude Code | the modBOARD mod (`/plugin install`) | band and `/board` pane | yes |
| Codex desktop app | the Codex plugin, below | live widget, buttons | yes, as the plugin: widget, Claim and Release |
| Codex CLI | the Codex plugin, below | text | yes |
| Claude Desktop | its MCP config, below | live widget, buttons | yes |
| VS Code (Copilot Chat) | `.vscode/mcp.json`, below | widget, per VS Code's MCP Apps support | not yet |
| Antigravity | the modBOARD panel (`board antigravity`), below | live board in the side pane, buttons | yes (2026-11-26): the board shows, Claim reaches the board |
| Goose | a command-line extension | widget, per Goose's MCP Apps support | not yet (not installed here) |
| OpenClaw | `openclaw mcp add` | unknown | not yet (not installed here) |
| Gemini CLI | — | — | no: it has stopped working for individual Google accounts, which now go to Antigravity |
| Cursor, Aider, Amp, OpenCode, any shell agent | the `board` CLI and `docs/AGENT-SETUP.md` | text, from `board list` | the CLI works anywhere a shell does |

## Codex (desktop app and CLI)

```bash
npm install -g modboard
codex plugin marketplace add Magithar/modboard
codex plugin add modboard@modboard
```

Restart the ChatGPT app, then ask "show the board". The plugin brings two
things: the board server (`board mcp`) and the skill that teaches Codex to
work from the board. Codex asks before it calls a plugin's tool; allow
modboard's.

What we learned installing it (Codex 0.172), which is why the plugin is the
way it is:

- A plugin's local server starts in the session's project folder, so
  `board mcp` finds that project's board with nothing to configure.
- `${PLUGIN_ROOT}` is not expanded in the server's command, and a symlink in
  the plugin is not copied on install. So the server is the installed
  `board` command, and the skill is a real copy (`test/codex-plugin.test.mjs`
  keeps it equal to `skills/modboard`).
- The widget's buttons go through `board_act`, which Codex keeps from the
  model: asked for its modboard tools, Codex names only `board_view`.

Without the plugin, `codex mcp add modboard -- board mcp` adds just the
server. Use one or the other: both are named `modboard`.

## Claude Desktop

Claude Desktop starts its servers in `/`, so name the project with `--dir`.
In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "modboard": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/modboard/bin/board.mjs", "mcp", "--dir", "/path/to/your/project"]
    }
  }
}
```

Use absolute paths: Claude Desktop doesn't load your shell's PATH (nvm,
Homebrew). One entry shows one project's board. Restart Claude, then ask in
a chat "show the board".

## VS Code (not yet tried)

VS Code draws MCP Apps in Copilot Chat. In the project, `.vscode/mcp.json`:

```json
{
  "servers": {
    "modboard": { "type": "stdio", "command": "board", "args": ["mcp", "--dir", "${workspaceFolder}"] }
  }
}
```

## Antigravity

Antigravity doesn't draw MCP Apps, but it runs plugins with a side panel.
modBOARD ships one:

```bash
board antigravity
```

Then in Antigravity: **Customizations → Installed**, turn **modboard** on
(off and on again after an update), and in a conversation open **⋮ →
Plugins → modBOARD**. The panel is the same page Codex and Claude Desktop
draw, in Antigravity's theme, with the same buttons.

It shows the board of the conversation's project when that folder has one;
otherwise (Antigravity's CLI Project, the welcome screen, a folder without
a board) it shows the default board: the project you ran `board antigravity`
in, or `board antigravity --dir <project>`. Its header names the project.

How it works: the panel's server (`lib/sidecar.mjs`) starts `board mcp` for
that project and passes the page's calls through, only `board_view` and
`board_act`, on requests that carry the panel's token, so no other program
or page on the machine can read the board or press its buttons through it.
`board antigravity` records where modboard is installed, so updating
modboard updates the panel.

Antigravity can also reach the board as an MCP server, as text for its
model: add `"modboard": { "command": "board", "args": ["mcp", "--dir",
"/path/to/your/project"] }` under `mcpServers` in
`~/.gemini/config/mcp_config.json`, then quit and reopen Antigravity. Its
model then sees `board_view` only.

## Goose and OpenClaw (not yet tried)

Both run local MCP servers: add `board` with the arguments `mcp --dir
/path/to/your/project` (Goose: `goose configure`, a command-line extension;
OpenClaw: `openclaw mcp add modboard --command board --arg mcp --arg --dir
--arg /path/to/your/project`). Goose draws MCP Apps; OpenClaw's support for
them isn't documented.

## Who can press the buttons

The buttons go through `board_act`, which acts for the person. MCP Apps
marks it for the widget only, but not every app keeps it from its model:
Antigravity handed it to its model. So `board mcp` offers `board_act` only
to an app that says, when it connects, that it draws MCP Apps (the
`io.modelcontextprotocol/ui` extension). Codex's desktop app and Claude
Desktop say so, and their buttons work; the Codex CLI and Antigravity
don't, and their models see only `board_view`.

## Presence

The board frees a claim when its agent stops: Claude Code sends a presence
ping; Codex and plain shell agents are watched through their process
(`lib/holder.mjs`), and every claim has a lease besides. Codex's own hooks
could renew claims on each tool call, but Codex runs a plugin's hooks only
in the desktop app, after the person trusts them, and the process watch
already frees a stopped Codex's claims. So the plugin ships no hooks for
now.
