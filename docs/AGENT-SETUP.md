# Setting up modBOARD (for an agent to read)

You are a coding agent asked to set up modBOARD in this project. modBOARD is a
shared task board in the repo that every agent and person works from. Follow
these steps, run each command, and tell the person what you did.

People can hand you this page with one line:

> Read https://github.com/Magithar/modboard/blob/main/docs/AGENT-SETUP.md and set up modBOARD here.

## 1. Install the CLI

Check whether it is already there: `board where`. If not:

```bash
npm install -g modboard
```

If global installs aren't allowed, use `npm install --save-dev modboard` and
run every command below as `npx board …`.

## 2. Keep the board out of git

The board lives in `.modboard/` at the repo root, shared by every worktree.
Add it to `.gitignore` if it isn't there:

```bash
grep -qxF '.modboard/' .gitignore 2>/dev/null || echo '.modboard/' >> .gitignore
```

## 3. Tell this project's agents how to use it

Add this to `AGENTS.md`, creating the file if needed. Don't remove what is
already there:

```markdown
## Shared board

This repo has a shared task board (modBOARD). Work from it:

- Take work with `board claim --next` (or `board claim <id>`). Never work on a task another agent holds.
- Read `board show <id>` first: its acceptance criteria and any handoff.
- Note progress with `board note <id> "..."`; record passing checks with `board check <id> "<command>"`.
- Finish with `board done <id> --note "how you verified it"`, or stop with `board release <id> --handoff "done X; left Y; see Z"`.
- Run long commands (a full test suite, a build) as `board run <id> -- <command>`, which keeps your claim alive while they run.
- Never run `board trust`. If a command exits 12, tell the person: they trust a storage block themselves.

Agents other than Codex: set `BOARD_AGENT` to your name first.
```

Don't run `board trust` during setup either. If the project's
`.modboard/config.json` names a storage block other than `file`, tell the
person to read it and run `board trust` themselves; it asks at a terminal.

If the project has a `CLAUDE.md` and the person uses Claude Code, tell them
about the Claude Code mod (step 5) rather than adding the protocol there.

## 4. Install the skill (optional)

Agents that load skills can learn the full protocol from one:

```bash
npx skills add Magithar/modboard
```

## 5. Claude Code (optional, the person does this)

Claude Code also gets a line above the prompt, the `/board` pane and
`board_*` tools from the modBOARD mod. That needs Claude Code 2.1.295 or newer
and a clone of the repo, started with
`claude --plugin-dir /path/to/modboard`. Tell the person. Don't change their
Claude Code settings yourself.

## 6. Check it works

```bash
board add "Try the board" --accept "board list shows it"
board list
```

You should see `○ T-001  Try the board`. Ask the person whether to keep that
task, or claim and finish it:
`board claim T-001 --as <name>` then
`board done T-001 --as <name> --note "board list showed it"`.

## 7. Tell the person

Say what you installed, which files you changed (`.gitignore`, `AGENTS.md`),
and that `board list` shows the board. Point them to the README for the
rest: https://github.com/Magithar/modboard#readme
