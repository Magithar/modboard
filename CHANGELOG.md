# Changelog

All notable changes to modboard. Versions follow [semantic versioning](https://semver.org/).
modboard was called agent-board until 0.5.0.

## Unreleased

- A `taskfile` block in the `/board` pane: when the checkout has a `task.md`
  (or `tasks.md`, `todo.md`), one line says how much of it is open, and
  clicking it (or pressing `t`) shows what's left under its headings, up to
  eight items, then a count of the rest. Checked-off items aren't shown. It's on
  by default (`pane: tasks,taskfile,usage`) and shows nothing without a file.
- The pane is quieter. Headings are dimmed, and rows lose their ◐/○ mark
  (the heading says the state). "Not started" shows eight tasks, then
  "N more"; in-progress and stopped-partway tasks are never cut. The usage
  bar is plain with room left and takes colour only from 70%.
- A `compact` block: the context window as a ring that fills (○ ◔ ◑ ◕ ●,
  yellow from 70%, red from 90%), and clicking it runs `/compact`. It's
  in the pane by default, and in the band once the context is half full.
- Usage is drawn with the same ring instead of a bar, so "how full" always
  looks the same.
- The band's default is now `summary,usage,compact`. Model and effort are
  still blocks you can add; Claude Code already shows both.
- Task rows only say who ("backend", "you"); the heading says what. "Needs
  picking up" is now "Stopped partway".
- The weekly limit is no longer shown on the board; the 5-hour limit stays.
- `board taskfile` prints that file's items; `--json` gives them as data. It
  reads no board and never writes one.

## 0.5.1 — 2026-11-19

Docs and package details only. The code is the same as 0.5.0.

- npm keywords now match the GitHub topics, so npm search finds modboard
  under `claude-code-plugin`, `llm-agents`, `coding-agents` and more.
- The package now includes `CHANGELOG.md`.
- The README links to the changelog and to a new contributing guide, and its
  badges show the license, release, npm downloads and Claude Code version.
- The live recording in the README is re-recorded with the modboard name.

## 0.5.0 — 2026-11-19

First release on npm: `npm install -g modboard`.

### Renamed

- **agent-board is now modboard**, everywhere: the npm package, the Claude Code
  plugin, the README and the GitHub repo
  ([Magithar/modboard](https://github.com/Magithar/modboard); the old URL redirects).
  npm refused `agent-board` as too close to an existing `agentboard`.
- The plugin's tools are now `mcp__modboard__board_*`, and the pane is titled
  "modboard".
- New boards go in `.modboard/`. A board already in `.agent-board/` keeps
  working where it is.
- Unchanged: the `board` command and the `BOARD_*` environment variables.

### Added

- **Your own display blocks, no code.** The `blocks` setting maps a name to a
  shell command; the block shows its first line of output, refreshed every
  30 seconds. It lives in your user config only, so a cloned repo can never
  make your session run its commands.
- **Model and effort blocks** that switch when clicked, by running Claude
  Code's own `/model` and `/effort`. The `models` and `efforts` settings list
  what they step through.
- **Readable CLI output.** Every command answers in a line or two for a
  person (`claimed T-001 … it's yours until 14:05`); `--json` prints the data
  for scripts. `view` and `events` stay JSON.
- **Storage blocks from npm.** A block published as a package is found in the
  `node_modules` of the project that holds the board, or any folder above it,
  not only beside modboard. Conditional `exports` and `main` both work.
- **Publishable package**: exports for the contract tests, the engine and the
  file block, so a storage block's own package can test itself with
  `modboard/lib/contract.mjs`.
- **README guide to making your own block**: storage blocks (adapters) step
  by step, with how the version check makes one claim win; display blocks
  from a command or in code. Both code examples run.
- **Diagrams** of how the system fits together and how blocks work, each
  rebuilt from plain text with `node docs/render.mjs`.
- **A live recording** in the README of three real Claude Code sessions
  sharing one board.

### Changed

- **Faster crash recovery.** A registered session that goes silent for
  3 minutes (`BOARD_PRESENCE_MS`) loses its claims, so a killed Claude process
  frees its tasks in 3 minutes instead of 15. Claims and notes count as signs
  of life. An agent that never registered keeps the 15-minute lease.
- **The display speaks plainly.** The band reads "2 tasks waiting · 1 in
  progress", and its alert "T-005 was stopped partway, pick it up". Pane rows
  say who has a task as a sentence ("backend is on it", "frontend stopped
  partway · see its note"), and waiting work splits into "Needs picking up"
  and "Not started". The CLI and tools keep the precise terms agents act on.
- **The band stays on one line at any width.** Blocks narrow, then drop from
  the end, and the summary narrows last, its alert outlasting its counts. It
  leaves room for Claude Code's own `[-]` control at the right end.
- **Usage is coloured by what is left**: green, yellow from 70%, red from 90%.
- **Effort shows the level a session will start on** before its first
  request: `CLAUDE_CODE_EFFORT_LEVEL`, else the model's own `effortLevel` under
  `modelSettings`, else the general `effortLevel`.

### Fixed

- The effort block no longer sticks at `xhigh` (it matched "high" inside it).
- The band no longer runs under Claude Code's `[-]` control.
- A test of silent sessions no longer fails when the test suites run in
  parallel.

## 0.4.0 — 2026-10-12

- **Storage and display become plug-in blocks.** `config.json` names the
  storage block: the built-in file block, a block file beside the board, or a
  package. A block that won't load or is missing a method is refused by name.
  The contract tests move to `lib/contract.mjs` so a block's author can run
  them, and `examples/store-memory.mjs` is a whole block to copy from.
- Display blocks are one file each in `hooks/blocks/`: summary, tasks, usage,
  clock, context and agents, chosen in the `band` and `pane` settings.
- **A calmer display.** A one-line band above the prompt shows only what needs
  you, and disappears when nothing is open. The `/board` pane groups work in
  progress above open work and folds done tasks into a count.

## 0.3.0 — 2026-10-12

- **Session names.** `BOARD_AGENT` names a Claude session on the board. A
  name another live session holds falls back to `name-2`, with a toast.
- **A storage socket.** The rules move into `lib/engine.mjs`, and storage sits
  behind a Store contract: snapshots and all-or-none conditional commits, the
  shape a database can honour in one transaction.
- **Pane blocks**: clock, usage, agents and tasks.

## 0.2.0 — 2026-10-12

Closes three gaps found by testing with live sessions.

- Lost claims go into the ledger as `claim-rejected`, naming the holder.
- `done` needs a `--note` saying how the task was checked, and tasks can carry
  `--accept` criteria.
- A Claude session that ends releases everything it holds, with a handoff.
  The CLI gains `release-all`.

## 0.1.0 — 2026-10-12

- A task board several agents share: one zero-dependency CLI owns the board,
  and a Claude Code mod adds tools, a live pane and lease heartbeats.
- Tested with two live Claude sessions and a shell standing in for Codex: one
  winner per claim, agents claim before editing, handoffs resume, and expired
  leases free the task.
