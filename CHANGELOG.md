# Changelog

All notable changes to modboard. Versions follow [semantic versioning](https://semver.org/).
modboard was called agent-board until 0.5.0.

## Unreleased

The board can now show a project's own task file, with its priorities, and a
compact button. The display is quieter: colour, marks and words appear only
where they tell you something.

### Added

- **Sessions are named for you**, by what they run and when they joined:
  `claude 1`, `claude 2`, `codex 1`. Nothing to set: a Claude session joins
  when it starts, and a Codex thread when it first runs `board` (Codex marks
  its shells with `CODEX_THREAD_ID`). A session keeps its name while it is
  open; a new one takes the lowest free number. `BOARD_AGENT` still picks a
  name of your own. New `board join` and `board whoami` commands.
- **A `taskfile` block** in the `/board` pane. When the checkout has a
  `task.md`, `tasks.md` or `todo.md` (any case) at its root or in `docs/`,
  one line, `To do · 9 open`, says how much of it is open. Click it to see
  what's left, under a dim line naming the file (`from TASKS.md`): every open item, read again from the file on each click,
  so what you just added shows. Checked-off
  items stay in the file and out of the pane. Nothing in it is claimed or
  written; to work an item through the board, `board add` it.
- **Each task file item has a grey dot** before it, as a handoff's points do.
- **Task file priorities.** P0–P9 are read from headings (`## P0 — …`,
  `## Sync (P1)`), from items (`- [ ] P2 …`, which wins over its heading)
  and from tables with a Priority column.
- **A priority button**, bold like `compact`, beside the task file, which turns through the tiers
  the file has the way the effort button turns through levels: `P0`,
  `P1`, …, `all`, and round again. It starts on the most
  urgent and shows one tier at a time. `all` lists every priority in order,
  each row with its own priority, with unprioritised items last, marked
  with a dash.
- **A `compact` block**: the context window as a bar, like the 5-hour
  limit's, and a button that compacts the conversation,
  through Claude Code's own compaction, the call `/compact` makes. The bar
  shows from the start: Claude Code's local estimate of the context until
  the first reply, then each reply's measurement. It's always in the pane,
  and in the band.
- **Collapsible task groups.** In progress, Unfinished, Not started and
  Done are each a heading you click to open or close,
  with its count: `▾ In progress · 3`. What needs you starts open; Not
  started starts closed, so the whole board fits without scrolling.
- **`/board` asks for a taller pane**, room for the whole board. Where the
  surface gives less, the pane's body scrolls with the mouse wheel.
- **A tutorial**, [docs/TUTORIAL.md](docs/TUTORIAL.md): from install to two
  agents sharing a board, reading the display, your task.md and its
  priorities, other agents, settings, and what to do when something looks
  wrong.
- **`board taskfile`** prints the task file's items; `--json` gives them as
  data. It reads no board and writes nothing.

### Changed

- **Defaults.** The band is now `summary,model,effort,board`: the 5-hour limit
  and the context moved to the pane, which is `tasks,taskfile,compact,usage`.
- **A shorter band.** It reads `2 waiting · 1 active   [T-005]`: `active`
  in green, and each task left partway in a yellow box, with no "pick it
  up".
- **A red line when the board stops answering**: `board not updating: …`
  at the top of the pane, with the reason, while the `board` CLI fails. What
  is below it is the last board it read. It goes once the board answers.
- **Each unfinished task is a yellow box on the band**: `[T-005] [T-008]`,
  up to three, then `+N`. A box is a button: it opens `/board` at the
  Unfinished group, and pressed again folds the group; the pane stays open
  until `modBOARD` closes it. In the pane the id stays grey, like every other.
- **A claim gone idle leaves the band**, since its lease frees it on its
  own; in the pane its row reads `codex 1 · idle`, in yellow.
- **The band's model and effort lose their labels**: `Sonnet 5.5   low`,
  since each says what it is. The pane keeps them.
- **A `modBOARD` button on the band**, bold in the logo's green, opens the
  `/board` pane, and closes it when it's already open: a plain word, like
  the model's, at the line's right end by Claude Code's `[-]`.
  On a short line, model and effort drop before it.
- **The 5-hour limit keeps its bar**, now plain with room left instead of
  green.
- **Colour only when something needs you**: yellow from 70%, red from 90%.
  With room left, usage and context stay plain (usage used to be green).
- **The weekly limit is left off the board.** The 5-hour limit stays;
  `/usage` has the rest.
- **A quieter pane.** Rows lose their ◐/○ mark, since the heading says the
  state, and name only who ("backend", "you"), since the heading says what.
  "Needs picking up" is now "Unfinished". A heading's name is a bold
  button and its count is grey beside it, so only the name highlights. Opened, a group shows every
  task in it.
- **Work stopped partway shows its handoff** under the title, dim: what's
  done and what's left, as the agent wrote it, one point a line where it
  used semicolons. It replaces "see its note". Handoffs are now asked for as
  "done X; left Y; see Z".
- **Done is a group**, `▸ Done · 3`, closed like Not started. Opened, it
  lists what's finished, the latest first, and who finished each.
- **The pane opens with `modBOARD`**, bold in the logo's green (heading size
  where the surface has sizes), this session's name, and, at the right,
  what waits and what's active, as the band counts them.
- **Room around each open group**: a blank line under its heading and after
  its rows.
- **A grey rule between the pane's sections**: the board, To do, and the
  bars, which stay together as one.
- **The bars sit under a Limits heading**, `▾ Limits`, which folds like the
  task groups. It starts open. Folded, it keeps the figures, `▸ Limits ·
  context 72% · 5-hour 64%`, each yellow or red as its bar would be.
- **The clock** in the pane is dimmed instead of bold.

### Reading task files

- Tables are read when they have a task column and a priority or status
  column; a status of done, complete or ✅ counts as checked off.
- Struck-through items (`~~old plan~~`) count as done.
- Once a file checks anything off, its plain bullets are notes, not tasks,
  and are left out.
- Markdown marks (`**`, backticks, link syntax) and status emoji are taken
  off item text and headings for display.
- A broken link named `task.md` reads as no task file, not an error.

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
