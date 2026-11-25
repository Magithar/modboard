# modBOARD — Universal board plan

One board, many hosts. Agent coordination is the first use case; the product
is a local-first board of blocks anyone can build. This plan covers getting
that board out of the terminal (MCP Apps hosts, a localhost page) without
changing the core. Design is kept in its own document.

## 0. Principles

How the code is written, borrowed from David Heinemeier Hansson where it fits
and left where it doesn't.

**Adopted**

- **One package.** The MCP server, the renderer and the localhost bench live
  in modboard. No separate services or packages.
- **No build step.** Plain `.mjs`, plain HTML, CSS and ES modules served as
  they are. No bundler, no framework, no Tailwind build.
- **Convention over configuration.** A block is found by where it lives and
  what it's called, not by a config file someone has to write.
- **Zero dependencies by default.** `node:` built-ins first. A dependency
  (the MCP SDK, most likely) comes in only when doing it by hand is worse.
- **Local-first.** No cloud, no Docker, no account needed for anything free.

**Not adopted**

- **Dropping types.** The block contract is a public, versioned interface
  other people's blocks code against. It stays typed in `types/index.d.ts`
  and JSDoc, which needs no build.
- **Fewer tests.** Security is enforced server-side, so it is tested
  server-side. The Claude Code mod is regression-tested every phase.

**The one tension.** DHH is omakase; modBOARD is open. The answer: an
opinionated core and contract, open blocks on top.

**Rules every phase keeps**

- The renderer holds no business logic. It shows block data and asks the
  server for named actions.
- A widget never supplies a command, a path or an executable. Action ids are
  names; the server decides what they do and checks every one.
- Security failures block a release. Visual limits get a fallback.
- Nothing is announced as supported until it is tested on that host.

## 1. Block contract (v1)

Independent of MCP Apps: the localhost page, MCP Apps hosts and the Claude
Code mod are all renderers of the same data. Defined in
`lib/block-data.mjs`, typed in `types/index.d.ts`. **Stable since Phase 2.**

```ts
interface BlockData<T = unknown> {
  id: string            // 'tasks', 'branch', …
  type: string          // which view draws it: one of VIEW_TYPES ('tasks', 'line')
  schemaVersion: 1
  title: string
  status: 'ready' | 'loading' | 'error'
  error?: string        // why, when status is 'error'
  data: T
  updatedAt: string     // ISO time
  actions: BlockAction[]
}

interface BlockAction {
  id: string            // a name the server knows, never a command
  label: string
  target?: string       // the item it acts on, e.g. 'T-005'
  input?: 'text'        // the person types a line for it (a note)
}
```

Rules that keep it stable:

- Within v1 a field may be added, never removed, renamed or given a new
  meaning. A renderer ignores fields it doesn't know.
- Anything else is v2. A renderer shows a block of a version it doesn't
  speak as "needs a newer modBOARD", never guesses.
- Every display checks each block (`checkBlock`) before showing it; a
  malformed one becomes an error card that says why (`safeBlock`), so a
  block someone else wrote can only break its own card.
- A task's actions come from one table (`TASK_ACTIONS`): the button, the
  server's check and the widget tool's schema all read it.
- Every renderer draws every view in `VIEW_TYPES`; an unknown type shows as
  its raw data. `test/renderers.test.mjs` checks they agree.

## 2. Security model

| Operation | Rule |
|---|---|
| View tasks | Allowed within the board's workspace |
| View installed blocks | Allowed for blocks the user turned on |
| Refresh git or CI block | Server runs that block's fixed, reviewed operation |
| Claim, note, release | The engine's existing ownership and validation |
| Widget supplies a command or path | Never |
| Run an unapproved block | Denied |
| Install an executable block | Explicit user approval |
| Change block permissions | User only |
| Read block secrets | Never; widgets get no raw credentials |

The localhost bench binds to `127.0.0.1` only and refuses any request whose
`Host` isn't local (no DNS rebinding).

## 3. Go/no-go (end of Phase 1)

| Test | Pass | Fallback | Result (2026-11-25) |
|---|---|---|---|
| HTML rendering | Interactive board | CLI text board | **Pass** in Codex desktop and Claude Desktop; text in Codex CLI |
| Widget tool calls | Act from the widget | Act through chat | **Pass** in both: Claim, Note, Release reach the real board |
| Refresh | Live board | Manual refresh | **Pass**, with a caveat: Claude Desktop pauses a widget in the background. The widget now times out a held call (15 s) and refreshes when it comes back into view |
| Persistence | Stays open | Inline snapshot | **Partly**: stays live in the same chat over ~15 min in both hosts; a long chat not checked |
| Local connectivity | Local-first | Defer that host | **Pass**: stdio, no network. Claude Desktop gives no cwd, so its entry `cd`s into the repo |
| Permission enforcement | Enable actions | Disable affected actions — **hard blocker** | **Pass**: `test/permissions.test.mjs`; both hosts keep the app-only `board_act` from the model |
| Claude Code regression | Continue | Fix first — **hard blocker** | **Pass**: 119 unit, 122 mod |
| Block contract | Proceed | Revise contract | **Proceed**: added `input: 'text'` on an action; nothing else needed |

**Decision: go.** Phase 2 starts. Carry forward:

- A host without a working-directory setting needs one: a `--dir` flag on
  `board mcp` would replace the `sh -c "cd …"` entry (2.4).
- A widget can be paused by its host; every call must fail visibly, never
  hang (done in the page, keep it in the shared renderer, 2.3).
- Persistence over a long chat is still to be watched; the fallback (the
  inline text) already works.

## 4. Tasks, scored with RICE

**RICE** = Reach × Impact × Confidence ÷ Effort.

- **Reach** — share of modBOARD users it touches next quarter, 1–10
  (10 = everyone; a single host is lower).
- **Impact** — 3 massive · 2 high · 1 medium · 0.5 low · 0.25 minimal.
- **Confidence** — 100% known · 80% likely · 50% guess.
- **Effort** — person-weeks.

Scores rank work within a phase. Phases still run in order: a later phase
depends on the go/no-go of the one before.

### Phase 1 — Prototype (P0)

| # | Task | R | I | C | E | RICE | Status |
|---|---|---|---|---|---|---|---|
| 1.1 | Define minimal block contract (`lib/block-data.mjs`, types) | 10 | 3 | 100% | 0.5 | **60** | done |
| 1.2 | Render tasks + ready blocks through the contract | 10 | 2 | 100% | 0.5 | **40** | done |
| 1.3 | Localhost test bench (`board serve`, read-only) | 8 | 2 | 100% | 0.5 | **32** | done |
| 1.4 | Regression-test Claude Code mod | 10 | 3 | 100% | 0.25 | **120** | passing (119 + 122) |
| 1.5 | Server-side actions: claim / note / release by name | 8 | 3 | 80% | 1 | **19** | done: Claim, Note and Release from the widget work in Codex desktop (T-005 as `human`, 2026-11-25) |
| 1.6 | Test permission enforcement (refusals, bad targets, Host check) | 10 | 3 | 100% | 0.5 | **60** | done: `test/permissions.test.mjs`, 8 end-to-end tests, every refusal leaves the board unchanged; found and fixed inherited JSON-RPC method names (`toString`) |
| 1.7 | Minimal MCP server exposing the board as an MCP App (`board mcp`) | 8 | 3 | 80% | 1.5 | **13** | done; works in Codex CLI as text |
| 1.8 | Test in Codex desktop | 5 | 2 | 50% | 0.5 | **10** | done: renders as a widget (2026-11-25), with expand button and Sources entry; Codex keeps `board_act` from the model |
| 1.9 | Test in Claude Desktop | 6 | 2 | 50% | 0.5 | **12** | done: renders as a widget in Claude Desktop chat (2026-11-25), with expand and source buttons. Desktop gives no cwd, so it starts `sh -c "cd <repo> && exec node bin/board.mjs mcp"`. Claude offers the model `board_view` only (app-only `board_act` hidden). Claim from the widget works (T-006 as `human`) |
| 1.10 | Test widget → tool calls, refresh, persistence | 6 | 3 | 50% | 0.5 | **18** | done: tool calls and refresh work in Codex desktop and Claude Desktop; Claude pauses background widgets, so calls now time out visibly and the page catches up when shown; persistence partly checked (see §3) |
| 1.11 | Record go/no-go decision | 10 | 2 | 100% | 0.1 | **200** | done: **go** (§3) |

### Phase 2 — Shared foundation (P1)

| # | Task | R | I | C | E | RICE | Status |
|---|---|---|---|---|---|---|---|
| 2.1 | Stabilise versioned contract | 10 | 2 | 80% | 0.5 | **32** | done: v1 rules in §1; `checkBlock` / `safeBlock` on every display; the widget shows "needs a newer modBOARD" for another version, and `loading` |
| 2.2 | Extend block registry to describe renderers | 8 | 2 | 80% | 1 | **13** | done: a block names its `view` (default `line`); the registry lists it |
| 2.3 | Reusable HTML renderer per block type | 8 | 2 | 80% | 1.5 | **11** | done for today's views: one `VIEWS` table in the page, the contract's `VIEW_TYPES` lists what every renderer draws. Splitting views into their own files waits for a third view |
| 2.4 | Host capability detection | 6 | 1 | 50% | 1 | **3** | done: learned from the host's answers, not its claims; a host that can't carry tool calls gets a still snapshot, buttons off, saying so |
| 2.5 | Server-side action validation, all actions | 10 | 3 | 80% | 1 | **24** | done: one `TASK_ACTIONS` table drives buttons, checks and the tool schema; a new action without a run stops modBOARD at start; non-string action names refused |
| 2.6 | Test approved command execution | 10 | 3 | 100% | 0.5 | **60** | done: `test/execution.test.mjs` runs `board mcp` as a host does; found and fixed: finding the board ran `git` from the plain PATH, so a project's own `git` could run |
| 2.7 | Cross-renderer compatibility tests | 8 | 1 | 80% | 1 | **6** | done: `test/renderers.test.mjs`; widget and bench get identical blocks |
| 2.8 | Regression-test Claude Code mod | 10 | 3 | 100% | 0.25 | **120** | passing (137 + 122) |
| 2.9 | `--dir` for hosts that give no folder (from §3) | 6 | 1 | 100% | 0.25 | **24** | done: `board mcp --dir <project>`, `board serve --dir`; replaces the `sh -c "cd …"` entry |

### Phase 3 — Platform expansion (P1)

| # | Task | R | I | C | E | RICE |
|---|---|---|---|---|---|---|
| 3.1 | Package Codex plugin (skill, hooks, MCP App) | 5 | 2 | 80% | 1 | **8** |
| 3.2 | Verify Antigravity | 3 | 1 | 50% | 0.5 | **3** |
| 3.3 | Verify OpenClaw | 2 | 1 | 50% | 0.5 | **2** |
| 3.4 | Verify VS Code | 5 | 1 | 50% | 0.5 | **5** |
| 3.5 | Evaluate Goose and other MCP hosts | 2 | 0.5 | 50% | 0.5 | **1** |
| 3.6 | Document CLI agents (Gemini CLI, Cursor, Aider, Amp…) | 6 | 1 | 100% | 0.5 | **12** |
| 3.7 | Presence hooks where hosts support them | 5 | 2 | 50% | 1 | **5** |
| 3.8 | Regression-test Claude Code mod | 10 | 3 | 100% | 0.25 | **120** |

### Phase 4 — Block ecosystem (P2)

| # | Task | R | I | C | E | RICE |
|---|---|---|---|---|---|---|
| 4.1 | Block secrets storage (OS keychain) | 6 | 3 | 80% | 1.5 | **10** |
| 4.2 | Network permissions per block | 6 | 3 | 80% | 1 | **14** |
| 4.3 | OAuth where a provider needs it | 3 | 1 | 50% | 2 | **0.8** |
| 4.4 | Release localhost dashboard | 8 | 2 | 80% | 0.5 | **26** |
| 4.5 | Clock, timer, weather | 6 | 1 | 80% | 1 | **5** |
| 4.6 | Calendar and appointments | 4 | 1 | 50% | 2 | **1** |
| 4.7 | EPL and cricket tickers | 3 | 0.5 | 50% | 1 | **0.8** |
| 4.8 | Radio and Spotify | 3 | 0.5 | 50% | 2 | **0.4** |
| 4.9 | Curated block store | 6 | 2 | 50% | 3 | **2** |
| 4.10 | Regression-test Claude Code mod | 10 | 3 | 100% | 0.25 | **120** |

### Phase 5 — Optional Pro services (P3)

| # | Task | R | I | C | E | RICE |
|---|---|---|---|---|---|---|
| 5.1 | Validate paid demand | 10 | 2 | 50% | 1 | **10** |
| 5.2 | Managed cross-device sync | 3 | 2 | 50% | 4 | **0.8** |
| 5.3 | Managed remote access | 2 | 2 | 50% | 4 | **0.5** |
| 5.4 | Telegram | 2 | 1 | 50% | 2 | **0.5** |
| 5.5 | Premium blocks | 2 | 1 | 50% | 2 | **0.5** |
| 5.6 | Team workspaces | 2 | 2 | 50% | 4 | **0.5** |
| 5.7 | Regression-test Claude Code mod | 10 | 3 | 100% | 0.25 | **120** |

Regression testing scores high in every phase because it is cheap and
everyone depends on it. It isn't a reason to start there: it runs with each
change.

## 5. Not now

- A dashboard per platform.
- Cloud infrastructure or subscriptions.
- A full block marketplace.
- A rendering framework of our own.
- Personal and entertainment blocks before the renderer is proven.

## 6. Decisions

| Decision | Direction |
|---|---|
| Product identity | Universal modular board |
| First implementation | Task block |
| Storage | Local-first |
| Cloud, Docker | Not required |
| Claude Code mod | Kept |
| Renderer | One shared HTML renderer |
| Platform integrations, custom blocks, localhost dashboard | Free |
| Managed services | Optional Pro |
| Compatibility claims | Only after testing |
