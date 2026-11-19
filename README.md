# agent-board

A task board several coding agents share at once. Two Claude Code sessions, a
Codex session and a person can all claim tasks from it, see who holds what,
and hand unfinished work to each other without losing context.

![How agent-board fits together: who works on the board, the CLI down to storage, what you see, and a task's life](docs/system.png)

The diagram's source is plain text, [`docs/system.txt`](docs/system.txt).
After editing it, `node docs/render.mjs` rebuilds every diagram's page and image.

One zero-dependency Node CLI owns all state. The Claude Code mod is an
adapter over that CLI. It adds what only Claude Code's host can provide: the
session's identity, a heartbeat on every tool call, and a live pane. Any
other agent uses the same CLI directly.

> **Early access.** The Claude Code mod uses Claude Code's function-hooks API,
> which is early access and can change between releases. It needs Claude Code
> **2.1.295 or newer**. The CLI has no such dependency.

## How it works

- **Storage is a block.** The engine never touches files. It reads a snapshot
  from a Store and commits conditional writes ("only if this task is still at
  the version I read"). Any backend that can do that atomically can hold a
  board. See [Make your own block](#a-storage-block-an-adapter).
- **Where the board lives:** `.agent-board/` next to the git *common* dir, so
  every worktree of a repo shares one board. Set `BOARD_DIR` to override it.
  Add `.agent-board/` to `.gitignore`, because it is runtime state.
- **Claims:** one lock per board (an atomic `mkdir`). The state file is
  replaced with an atomic rename. Exactly one claimant wins, and only the
  owner can note, release or finish a task.
- **Leases:** a claim lasts 15 minutes (`BOARD_LEASE_MS`). `heartbeat` or
  `note` renews it. An expired claim goes back to todo, and the ledger records
  it, so an agent that crashed doesn't hold a task forever. A Claude session
  pings the board every minute while it is open, so if one is killed outright
  its claims go back after 3 minutes of silence (`BOARD_PRESENCE_MS`), not 15.
  An agent that never ran `board register` (a plain shell) keeps the lease
  alone.
- **Names:** start a session with `BOARD_AGENT=frontend` to name it. If
  another live session already holds the name, the new one becomes
  `frontend-2` and gets a toast explaining why. Without a name, a session is
  `claude:<session id>`. An open session keeps its name with a presence
  heartbeat; a name is freed when its session ends or goes silent for
  3 minutes.
- **Handoffs:** `release --handoff "..."` leaves a note that the next agent
  reads with `show` before it continues. When a Claude session ends (exit,
  `/clear`, resume, logout), the mod releases everything that session holds,
  with an automatic handoff. That matters because a restarted session comes
  back with a new identity.
- **Done means verified:** `done` needs a `--note` saying how the task was
  checked, against its `--accept` criteria if it has any.
- **Ledger:** every change is appended to `ledger.jsonl`, including lost
  claims (`claim-rejected`, with the holder). `board doctor` checks that the
  ledger and the state agree.

## Install

**The CLI (any agent):**

```bash
git clone https://github.com/Magithar/agent-board.git
cd agent-board && npm link        # puts `board` on your PATH
```

Or, inside a project: `npm install --save-dev github:Magithar/agent-board`,
then `npx board ...`. A storage block's own package can depend on it and
import `agent-board/lib/contract.mjs` for its tests.

**The Claude Code mod:**

```bash
BOARD_AGENT=frontend claude --plugin-dir /path/to/agent-board
```

`BOARD_AGENT` is optional. It sets the name this session uses on the board.

## Use

**Any agent (Codex, OpenCode, a shell):**

```bash
export BOARD_AGENT=codex                  # who you are; unique per session
board list                                # ○ todo  ◐ claimed  ● done
board show T-001                          # description, notes, handoffs
board claim T-001                         # exit 6 if another agent holds it
board note T-001 "what changed"           # also renews your lease
board heartbeat                           # renew all your leases
board release T-001 --handoff "done X, left Y, see Z"
board done T-001 --note "ran X, saw Y"    # required: how you verified it
board release-all                         # free everything you hold
board add "title" --desc "..." --accept "how to tell it is done"
board agents                              # live agents
board view                                # every task and live agent, as JSON
board doctor                              # ledger vs state
```

Each command answers in a line or two for a person (`claimed T-001 … it's
yours until 14:05`); `--json` prints the data instead, for scripts. `view`
and `events` are for programs and always print JSON. Exit codes: 2 usage, 3 board busy, 4 no such
task, 5 not yours, 6 held by another agent, 7 name in use.

For agents other than Claude, put this protocol in their instructions
(`AGENTS.md`):

> Claim a task before working on it. Note progress. If you stop without
> finishing, release it with a handoff. Never touch a task another agent holds.

**Claude Code** gets these tools: `board_list`, `board_show`, `board_add`,
`board_claim`, `board_note`, `board_release` and `board_done`. Tool activity
renews the session's leases.

The CLI and the tools keep the board's precise terms (claim, release,
handoff, lease) because agents act on them. The display uses plain words
instead, so you can read it without learning those terms.

## What you see

The display shows only what needs you. Everything else waits until you ask.

**One line above the prompt**, always visible while there's work on the board:

```
2 tasks waiting · 1 in progress   T-005 was stopped partway, pick it up   5-hour limit ▓▓▓▓▓▓░░░░ 64%   model Sonnet 5.5   effort medium
```

The line never wraps, and stays clear of Claude Code's own `[-]` control at
its right end. In a narrow window its parts shorten first, then the
last ones drop off. The first block (the summary) keeps its full form longest,
and the alert outlasts the counts:

```
124 cols   2 tasks waiting   5-hour limit ▓▓▓▓▓▓░░░░  64%   model Sonnet 5.5   effort low
 64 cols   2 tasks waiting   5h ▓▓▓░░  64%   Sonnet 5.5   low
 38 cols   2 tasks waiting   5h ▓▓▓░░  64%
 20 cols   2 tasks waiting
```

The alert names the one thing that needs you: a task someone stopped partway
that nobody has picked up, or an agent that stopped responding (its claim is
about to run out). Usage appears only once a limit passes 50%. It's green
with room left, yellow from 70% and red from 90%. With nothing waiting or in
progress, the line disappears.

**`/board`** opens the full pane:

```
 In progress
 ◐  T-004  Add a test script           you're on it
 ◐  T-007  Write the README            backend is on it
 ◐  T-006  Add a LICENSE file          codex stopped responding

 Needs picking up
 ○  T-005  Ghost task                  frontend stopped partway · see its note

 Not started
 ○  T-008  Add dark mode

 3 done

 Usage
 5-hour limit   ▓▓▓▓▓▓░░░░  64%   resets 12:00
 weekly limit   ▓▓░░░░░░░░  20%   resets in 3d
```

Both are stacks of display blocks, chosen in the plugin's settings (`/config`)
as comma-separated lists, in order:

| Block | Band | Pane | Shows |
|---|---|---|---|
| `summary` | ✓ | | what's waiting and in progress, and the one thing that needs you |
| `tasks` | | ✓ | in progress, then work stopped partway, then not started, then a count of done |
| `usage` | ✓ | ✓ | plan usage per window: in the band past 50%, in the pane with resets |
| `model` | ✓ | ✓ | the session's model; click it to switch to the next one |
| `effort` | ✓ | ✓ | the effort level; click it to step to the next one, wrapping from the highest to the lowest |
| `clock` | ✓ | ✓ | the time |
| `context` | ✓ | ✓ | context fill and the session's cost |
| `agents` | | ✓ | who is live on the board |

The defaults are `band: summary,usage,model,effort` and `pane: tasks,usage`.

Each row says who has a task as a sentence (`backend is on it`, `frontend
stopped partway`) rather than a bare name, which could mean whoever made,
holds or dropped it.

Click `model` or `effort` to switch: each click runs Claude Code's own
`/model` or `/effort`, the same as typing the command. (In the `/board` pane
they also answer to `m` and `e`.) Note that `/effort` saves the level as your
default for new sessions, except `max`, which lasts for this session only. The `models` setting lists what
the model block steps through (default `opus,sonnet,haiku`), and `efforts`
lists the effort levels (default `low,medium,high,xhigh,max`). A model or
effort changed by hand shows on the next request. Until the session's first
request, the effort block shows the level it will start on:
`CLAUDE_CODE_EFFORT_LEVEL` if set, else the model's own `effortLevel` under
`modelSettings`, else the general `effortLevel` setting.

**Your own blocks.** Show a command's output with no code, or write a block
of your own: see [Make your own block](#make-your-own-block).

## Make your own block

agent-board is built from blocks, and you can add your own. There are two
kinds:

| Kind | What it does | How many | Where you choose it |
|---|---|---|---|
| **Storage block** (an adapter) | holds the board: a folder, a database, a server | one per board | `.agent-board/config.json` |
| **Display block** | draws part of the board inside a Claude session | many, in order | the plugin's `band` and `pane` settings |

![How blocks work: the three ways to make your own, how a storage block (an adapter) is found, what the engine asks of it, where display blocks come from and how the band fits them on one line](docs/blocks.png)

The diagram's source is plain text, [`docs/blocks.txt`](docs/blocks.txt).

### A storage block (an adapter)

Write one when the board should live somewhere other than a local folder,
for example so agents on different machines can share it. The engine keeps
every rule (claims, leases, handoffs). A block only stores records and
refuses writes that are out of date, so it never needs to know what a task
is.

**How an adapter works.** Every record carries a version, and every write
says which version it expects. Say agents A and B both claim T-001 at the
same moment:

1. Both read the board with `snapshot()`. T-001 is at version 3, and nobody
   holds it.
2. Both decide the claim is fine, and both send `commit`: "claim T-001, only
   if it is still at version 3".
3. A's commit lands first. The adapter sees version 3, writes the claim, and
   T-001 moves to version 4.
4. B's commit finds version 4, not 3, so the adapter writes nothing and
   answers `{ ok: false, conflict: 'T-001' }`.
5. The engine reads again for B, sees that A holds T-001, and refuses B:
   "T-001 is already claimed by A" (exit 6). The ledger records B's attempt
   as `claim-rejected`.

Three things follow from this:

- **The engine decides; the adapter keeps versions honest.** Claims, leases,
  handoffs and names are all rules in the engine. An adapter for a new
  backend never has to reimplement them.
- **The check and the write must be one step.** A transaction, a conditional
  write or a lock. If an adapter checks the version and then writes in two
  separate steps, A and B can both pass the check, and two agents end up
  holding one task. The contract tests below race ten claims to catch this.
- **The ledger makes it checkable.** Each commit appends its events with the
  writes. If a crash ever leaves the two out of step, `verify()` says so, and
  `board doctor` reports it.

**1. Write the module.** One file that exports `createStore(config, { dir })`.
`config` is everything in `.agent-board/config.json`, so your block's own
settings (a URL, a table name) go there too. `dir` is the `.agent-board/`
folder. It returns five methods, all of which may be async:

```js
// my-block.mjs
export function createStore(config, { dir }) {
  return {
    // The store's clock, in ms. Leases are timed by it, so every machine
    // agrees. A database should answer with its own time.
    now: () => Date.now(),

    // Every record, each with the version it stands at:
    //   { tasks: { 'T-001': { ...task, version: 3 } },
    //     agents: { frontend: { ...agent, version: 1 } } }
    snapshot: async () => { /* read everything */ },

    // writes: [{ kind: 'task' | 'agent', key, value, expect }]
    // events: ledger entries to append
    // Apply every write and append every event, or nothing at all, and only
    // if each record still stands at `expect` (0 means it must not exist).
    // An applied record's version becomes expect + 1. A null value deletes.
    // Answer { ok: true }, or { ok: false, conflict: key } to have the
    // engine read again and retry.
    commit: async ({ writes, events }) => { /* one transaction */ },

    // Ledger events with seq > since, in order. Give each appended event the
    // next seq and an `at` time.
    events: async (since = 0) => { /* ... */ },

    // Does the ledger agree with the state? This is what `board doctor` reports.
    verify: async () => ({ ok: true, problems: [] }),
  }
}
```

`commit` is the only hard part: it must be all-or-none, and checking the
versions and writing must happen as one step (a database transaction, a
conditional write, a lock). [`examples/store-memory.mjs`](examples/store-memory.mjs)
is a complete, working block in about 20 lines to copy from, and
[`lib/store-file.mjs`](lib/store-file.mjs) is the built-in one.

**2. Test it against the contract.** The engine relies on a few rules and
nothing else: one winner when many agents claim one task, distinct ids when
they add at once, stale writes refused, one live session per name. They ship
as a test suite:

```js
// my-block.test.mjs, run with: node --test
import { storeContract } from 'agent-board/lib/contract.mjs'
import { createStore } from './my-block.mjs'

storeContract('my block', () => createStore({ /* test settings */ }, { dir: '/tmp/board-test' }))
```

Each run should start from an empty board, so give each `createStore` call a
fresh table or folder.

**3. Point a board at it.** In `.agent-board/config.json`, name it in one of
three ways. Everything besides `store` is passed to your block:

```json
{ "store": "file" }                                     the built-in default
{ "store": "./stores/my-block.mjs", "url": "..." }      a block file, relative to .agent-board/
{ "store": "agent-board-my-block", "url": "..." }       a block published as a package
```

Then check it: `board add "first task"`, `board view`, and `board doctor`.
The CLI refuses a block that won't load or is missing a method, and says
which (exit 2).

**4. Share it (optional).** Publish it as a package whose entry exports
`createStore` (through `exports` or `main`), with `agent-board` as a
dev dependency for the contract tests. Anyone can then
`npm install agent-board-my-block` in their project and name it in
`config.json`. A package is found the way Node finds any package: in the
`node_modules` of the project that holds the board, or a folder above it.

### A display block from a command (no code)

The quickest way to show something of your own. The `blocks` setting (in
`/config`) maps a block name to a shell command. Every 30 seconds the command
runs, and the block shows the first line it prints, cut to 60 characters:

```json
{"ci": "gh run list -L1 --json conclusion -q '.[0].conclusion'", "branch": "git branch --show-current"}
```

Then name them in `band` or `pane` like a built-in block
(`band: summary,ci,usage`). In the band a command block shows as
`ci success`, or just `success` when the line is short.

- Names are lowercase letters, digits and dashes, up to 16 characters, and
  can't reuse a built-in block's name. A bad entry is skipped, with a toast
  saying why.
- A command that fails (non-zero exit) or prints nothing shows nothing.
- The setting lives in your user config, not in the project, so opening
  someone else's repo can never make your session run its commands.

### A display block in code

For a block that reads the board itself, or reacts to a click. Each built-in
block is its own file in [`hooks/blocks/`](hooks/blocks/), and yours is a file
of the same shape:

```tsx
// hooks/blocks/mine.tsx: how many tasks are mine
import { words, type Block } from './types'

export const mine: Block = {
  name: 'mine',
  // The band: forms widest first. The band takes the widest that fits,
  // and leaves the block out when even the last one doesn't.
  band: ({ ui: { Text }, tasks, who }) => {
    const n = tasks.filter(t => t.claim?.owner === who).length
    if (!n) return null // nothing to say: the block takes no room
    return [words(Text, `${n} mine`), words(Text, `${n}`)]
  },
  // The pane: one part of /board, or null.
  pane: ({ ui: { Text }, tasks, who }) => (
    <Text>{tasks.filter(t => t.claim?.owner === who).length} tasks are mine</Text>
  ),
}
```

Every block gets the same context (see [`types.tsx`](hooks/blocks/types.tsx)):
the tasks, the live agents, who this session is, plan usage, the model and
effort, the time, the width, your command blocks' output, and `act` for
switching the model or effort when the block is clicked. A block may draw in
the band, the pane or both.

Then list it in [`index.ts`](hooks/blocks/index.ts) (an import, and its name
in `BLOCKS`), name it in the `band` or `pane` setting, and run
`claude plugin test .`. Claude Code mods can't load code at runtime, so a
code block lives in your copy of the mod: fork this repo, or send it as a
pull request if others would want it.

## What has been tested

These tests ran on 2026-10-12 with two live Claude Code sessions (Sonnet 5.5,
v2.1.296), one shell acting as Codex, and no extra instructions to the agents
beyond the tool descriptions:

| Test | Result |
|---|---|
| Both sessions claim the same task at once | one wins; the other reports the holder and does no work |
| Both told "do the next task on the board" | they collided on one task; the loser moved to another by itself; each claimed before writing files |
| One session does part 1 and releases with a handoff | the other read the handoff and resumed from part 2 without redoing part 1 |
| `codex` claims a task from the shell | Claude was refused, said so, and left it alone |
| An agent's lease runs out | the task returns to todo, and the ledger records `expire` |

Automated tests: `npm test` runs the CLI tests (a 20-way claim race,
ownership, handoff, lease expiry, heartbeat, rejected-claim logging, verified
done, release-all) and the store contract against the file block and an
in-memory reference block (concurrent claims and adds, stale writes, names).
It also checks that the CLI loads a block named in `config.json` and refuses
a broken one. `claude plugin test .` runs the mod tests (the pane's sections
and alerts, the band and when it stays quiet, names and their fallback, the
tools, the verification note, release on session end, usage, and choosing
blocks).

## Known limitations

- **It doesn't work across machines yet.** The storage socket is in place,
  but the only block built is local files. A database or server block comes
  when a real cross-device need does.
- **Usage is per session.** The usage block shows the session's own plan
  usage, which Claude Code reports, not the other agents'.
- **A crash skips the release on session end.** If a Claude process is killed
  outright, its claims are freed once its session has been silent for
  3 minutes. A plain CLI agent that never registered waits out its lease
  (15 minutes).
- **A verification note is the agent's own claim.** The board requires one
  but doesn't run the check itself.

## License

MIT
