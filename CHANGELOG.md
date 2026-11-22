# Changelog

All notable changes to modboard. Versions follow [semantic versioning](https://semver.org/).
modboard was called agent-board until 0.5.0.

## Unreleased

### Added

- **`blocks` on the band, before `modBOARD`**, in the logo's orange. It opens
  the pane at a list of the blocks the board can show; click a row to tick it
  on or off, then **Board** (or `modBOARD`) to see the board. A newly ticked
  block goes last. Pressed again while the list shows, `blocks` closes the
  pane. The choice is kept between sessions; a `pane` setting changed in
  `/config` since wins over it.
- Every block with a part in the pane is on the list by itself, your command
  blocks too (described by their command). `model`, `effort`, `clock` and
  `context` stay off it: the band or `compact` shows them already, and
  `pixel-clock` is the clock to tick. They still work when named in `pane`.

- **`pixel-clock`**: the time in large pixel digits, three rows tall, with
  the weather beside it and the next alarm under it. In the band, the time
  plainly with the next alarm.
- **`weather`**: `☀ 18°` on the band, from Open-Meteo, once `location` is set
  in `/config` (a city or `latitude,longitude`; `units` for °F). Nothing is
  sent before then, and only the location. Read every 20 minutes; offline,
  the last reading stays and says how old it is.
- **An alarm**: set `alarm` in `/config`, or `/board alarm 7:30` from the
  prompt (`/board alarm off` clears it). At its minute: a toast, a
  notification, a chime for up to a minute, and a **stop** button on the clock.
- **Ring when it's done**: `board add "…" --ring` (or `board ring T-004`,
  `--off` to undo) flags a task, and the pixel clock's alarm chimes three
  times when it turns done, whoever finished it: Claude, Codex or a person.
  `board_add` takes `ring: true` for agents.
- **`board_alarm`**, a tool for Claude agents: ring now with a note, or once
  at a time or in some minutes. At most once a minute for ringing now;
  `/board alarm` lists the ones it set and `/board alarm off` clears them.
- **modboard asks where you are** for the weather, once, when you tick
  `pixel-clock`: your IP's city, a city you type, or not
  now. Esc means no weather; `/board location`, or asking Claude (the
  `board_location` tool), asks again. Kept between sessions; `location` in
  `/config` wins over it.
- **An Order tab on the list of blocks**: the ticked blocks, numbered in the
  board's order, with **▲ ▼** to move one a place. The moved row lights up
  for a moment. The order is
  kept between sessions. Each tick and move is saved as it's
  made; at the right of the tabs, in yellow: `saved · added agents · order
  changed`. A **Board** tab replaces **Done**. The **Blocks** tab ticks, as before.

### Changed

- **The pixel clock's column**: beside the digits, one column of three rows:
  the weather and place, the conditions, the next alarm. Too narrow, it goes
  under the digits. An alarm note that only repeats the time ("Alarm set for
  2 PM" at 14:00) is left out.
- **`agents` is one line**: `Live  ● claude 1 (you)  ○ codex 1`, a green dot
  for an agent seen in the last 90 seconds, a grey one for the quiet. All of
  it grey but the dots, since none of it is pressable.
- **The pane opens at once**, from `modBOARD`, a task's box or `/board`, on the
  last reading, and reads the board again just after.
- **Smoother scrolling.** The 3-second poll writes only what changed, so the
  pane is no longer redrawn for nothing; and each drawing reads what it needs
  at once, not one value after another.

## 0.7.1 — 2026-11-21

A session that crashes now keeps its place, as a session that hands off
does. The idea came from a reader, who asked for the last known path even if
it might be stale.

### Changed

- **A crashed session's work shows as unfinished.** When the board frees a
  task because its session went silent, or its lease ran out, and its agent
  had recorded work on it (a note or a check), it writes a handoff for it:
  "claude 1 stopped responding (its session went silent); read the notes
  above". The task then waits under Unfinished, named after the agent that
  left it, not under Not started. A task claimed with nothing recorded still
  goes back to Not started.
- **That handoff carries the last place the work was seen**, from the task's
  latest note that has one (a check, usually), so the `where`, `path` and
  `check` rows show. It is marked as such, since the work may have moved on
  after: `login @ 9056822 · last known, may be stale` in the pane, and
  `(last known, may be stale)` in `board show`.

### Docs

- The README says what happens to a crashed session's task. The roadmap item
  is done and gone from the roadmap.

## 0.7.0 — 2026-11-21

A handoff now says where the work is and what last passed there, so the next
agent can pick it up quickly.

### Added

- **Handoffs record where the work is.** `release` and `release-all` save the
  worktree, branch and commit, and whether anything is uncommitted. That
  includes the handoff a Claude session writes when it ends. `board show`
  prints them under the handoff, and `release` says where the work is.
- **`board check <id> "<command>"`** runs a check in your checkout and
  records it only if it passes, with the worktree and commit it ran at. A
  failed check exits 8 and records nothing, and only the task's holder can
  run one. `--passed` records a check you already ran yourself; `board show`
  marks it as reported.
- **A `board_check` tool for Claude Code**, which records a check the agent
  ran and saw pass. `board_show` and `board_release` now tell agents about
  the worktree and the last check.
- **Under a handoff in `/board`**, apart from its points, three rows a blank
  line apart, grey labels and plain values, lined up like the Limits rows:
  - `where`: the branch and commit, and any uncommitted changes.
  - `path`: the worktree, from `~`, cut from the start so its own folder
    shows. It is a button: a click puts `cd '<path>'` on the clipboard and
    it reads `✓ copied` for a moment; where the surface can't copy, a toast
    gives the path.
  - `check`: the last check that passed, and whether it ran before later
    changes.

### Docs

- The README and the tutorial cover `board check`, what a handoff records,
  and the new rows; the protocol for agents now says to record checks that
  pass.

## 0.6.3 — 2026-11-20

Two pane blocks get names that say what they show, so the pane setting no
longer lists two blocks that both start with "task".

### Changed

- **`tasks` is now `work`**: who's doing what, in the In progress,
  Unfinished, Not started and Done groups.
- **`taskfile` is now `todo`**: your task.md, under the pane's To do heading.
- **The default pane setting** is `work,todo,compact,usage`.
- **The old names still work.** A `pane` or `band` setting that names `tasks`
  or `taskfile` shows the same blocks as before, so nothing needs changing
  after an update. Both old names stay reserved, so a block of your own can't
  take them; neither can `work` or `todo`. A block of your own already called
  `work` or `todo` is now skipped, with a toast saying why: rename it in
  **Your own blocks**.

### Docs

- The README's block table, the tutorial and both diagrams use the new names.

## 0.6.2 — 2026-11-20

modBOARD is now described as what it is: one board for every agent and every
person, where you decide what's on it. No code changed; the CLI and the mod
work as in 0.6.1.

### Docs

- **A new tagline**: "One board for every agent and every person. You decide
  what's on it." It replaces "one task board" in the README, the npm
  description, the plugin description and the GitHub About text.
- **The README leads with blocks.** "What it does" says who it's for (several
  agents at once, switching between agents, your project at a glance), and its
  table starts with choosing what's on the board. Quick start gains an
  optional step 4, choosing your blocks, and What you see and Settings point
  to making your own.
- **The tutorial follows**: its intro ends with choosing what the board shows,
  part 8 opens by explaining blocks and adds a `branch` block beside `ci`,
  and When something looks wrong covers a block that shows nothing or is
  skipped.
- **Keywords**: `dashboard` and `configurable` replace `task-board` and
  `kanban` on npm, in the plugin and on GitHub.

## 0.6.1 — 2026-11-20

`board` refuses a flag it doesn't take instead of dropping it, found by
the first live run with real Codex, and every push now runs CI.

### Changed

- **`board` refuses a flag the command doesn't take**, and names the ones it
  does: `board: add doesn't take --description; it takes --as, --json, --desc,
  --accept`. Before, a guessed flag was dropped without a word, so an agent
  that wrote `--description` saved its task with no description. Found by a
  live run with Codex.

### Tested

- **A live run with real Codex** (Codex CLI 0.155.1), where before a shell
  stood in for it. Told only to do what it could, it took the name `codex 1`
  by itself, claimed before writing, finished with a verification note after
  `done` without one was refused, and left a task another agent held alone.
  The README's Testing section has the results.
- **CI on GitHub Actions.** Every push to `main` and every pull request runs
  `npm test` on Node 18, 20 and 22, and `claude plugin validate .` and
  `claude plugin test .` with the latest Claude Code.

### Docs

- The README has a CI badge, the Codex run, and exit code 2 now covers a
  flag the command doesn't take.

## 0.6.0 — 2026-11-20

Sessions name themselves, the board shows your project's own task file with
its priorities, and the display is quieter and clickable: colour, marks and
words appear only where they tell you something.

### Added

- **Sessions are named for you**, by what they run and when they joined:
  `claude 1`, `claude 2`, `codex 1`. Nothing to set: a Claude session joins
  when it starts, and a Codex thread when it first runs `board` (Codex marks
  its shells with `CODEX_THREAD_ID`). A session keeps its name while it's
  open; a new one takes the lowest free number. `BOARD_AGENT` still picks a
  name of your own. New `board join` and `board whoami` commands.
- **Your task.md on the board.** When the project has a `task.md`,
  `tasks.md` or `todo.md` (upper or lower case) at its root or in `docs/`,
  the pane shows what's left in it under **To do**, read again on each
  click. Checked-off items stay out. Nothing in it is claimed or written; to
  work an item through the board, `board add` it.
- **Task file priorities.** P0–P9 are read from headings (`## P0 — …`,
  `## Sync (P1)`), from items (`- [ ] P2 …`, which wins over its heading)
  and from tables with a Priority column. A priority button beside To do
  turns through the tiers the file has, `P0`, `P1`, …, `all`, the way the
  effort button turns through levels. `all` lists every item with its
  priority, unprioritised ones last, marked with a dash.
- **`board taskfile`** prints the task file's items; `--json` gives them as
  data. It reads no board and writes nothing.
- **A `compact` block**: the context window as a bar, like the 5-hour
  limit's, and a button that compacts the conversation, the call `/compact`
  makes. It shows from the start: Claude Code's own estimate until the first
  reply, then each reply's measurement.
- **A `modBOARD` button on the band**, bold in the logo's green, at the
  line's right end. It opens the `/board` pane, and closes it when it's
  open. On a short line, model and effort drop before it.
- **Collapsible groups.** In progress, Unfinished, Not started and Done are
  each a heading you click to open or close, with a count: `▾ In progress ·
  3`. What needs you starts open; Not started and Done start closed.
- **A Done group** lists what's finished, latest first, and who finished it.
- **A Limits heading** over the context and 5-hour bars, which folds like
  the groups. Folded, it keeps the figures: `▸ Limits · context 72% ·
  5-hour 64%`, each yellow or red as its bar would be.
- **A red line when the board stops answering**: `board not updating: …`
  at the top of the pane, with the reason, until the `board` CLI answers
  again.
- **A taller `/board` pane**, room for the whole board. Where the surface
  gives less, the pane scrolls with the mouse wheel.
- **A tutorial**, [docs/TUTORIAL.md](docs/TUTORIAL.md): from install to two
  agents sharing a board, reading the display, your task.md, other agents,
  settings, and what to do when something looks wrong.
- **A roadmap**, [ROADMAP.md](ROADMAP.md), starting with `/board colours`.
- **A logo**, at the top of the README.

### Changed

- **Default blocks.** The band is now `summary,model,effort,board`; the
  5-hour limit and the context moved to the pane, which is
  `tasks,taskfile,compact,usage`.
- **A shorter band**: `2 waiting · 1 active   [T-005]   Sonnet 5.5   low`.
  `active` is green, and the model and effort lose their labels.
- **Each unfinished task is a yellow box on the band**: `[T-005] [T-008]`,
  up to three, then `+N`. A box is a button: it opens `/board` at
  Unfinished, and pressed again folds the group. It replaces "T-005 stopped
  partway, pick it up".
- **A claim gone idle leaves the band**, since its lease frees it on its
  own; in the pane its row reads `codex 1 · idle`, in yellow.
- **"Needs picking up" is now "Unfinished"**, and its handoff shows under
  each task as points, one per part the agent separated with a semicolon.
  It replaces "see its note". Handoffs are now asked for as "done X; left Y;
  see Z".
- **A quieter pane.** It opens with `modBOARD`, this session's name and the
  counts. Rows lose their ◐/○ mark and name only who (`claude 2`, `you`),
  since the heading says what. IDs are grey. A heading's name is a bold
  button and its count grey beside it. Each open group has room around it,
  and a grey rule parts the board, To do and the bars.
- **Colour only when something needs you**: yellow from 70%, red from 90%.
  With room left, usage and context stay plain (usage used to be green).
- **The weekly limit is left off the board**; `/usage` has it.
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

### Docs

- The README is reorganised: what it does, a demo, a three-step quick
  start, everyday commands, what you see, settings, how it works, then
  making your own blocks, with reference material folded away.
- Screenshots of the `/board` pane and the task file, and a sharper live
  demo, re-recorded at retina resolution with the automatic names.
- The diagrams show the new names and groups, in the logo's green.

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
