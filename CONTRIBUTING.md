# Contributing to modboard

Thanks for helping. modboard is small on purpose: one CLI with no
dependencies, an engine that holds every rule, and blocks around it. Most
contributions are a new block, a fix, or clearer wording, and all three are
welcome.

## Set up

You need Node.js 18 or newer. For the Claude Code mod, you also need Claude
Code 2.1.295 or newer.

```bash
git clone https://github.com/Magithar/modboard.git
cd modboard
npm link                                # puts your copy's `board` on your PATH
claude --plugin-dir "$PWD"              # runs your copy of the mod
```

There is nothing to install: the CLI and engine use only Node's standard
library.

## Before you open a pull request

Run all three, and make sure they pass:

```bash
npm test                    # the CLI and the storage contract
claude plugin test .        # the mod: band, pane, tools, settings
claude plugin validate .    # the mod's manifest and hooks
```

Then:

- **Add a test for new behavior.** CLI and engine tests live in `test/`,
  mod tests in `tests/`. A fix should come with the test that would have
  caught it.
- **Update `CHANGELOG.md`** under a new "Unreleased" heading for anything a
  user would notice.
- **Update the README** if you change a command, a setting or what the
  display shows.
- **If you change a diagram**, edit its `.txt` in `docs/` and run
  `node docs/render.mjs` to rebuild the images. Never edit the `.png` by hand.

## Where things go

| You want to | Change |
|---|---|
| Change a rule (claims, leases, handoffs, names) | `lib/engine.mjs`, with a test in `test/cli.test.mjs` |
| Change a CLI command or its output | `bin/board.mjs` |
| Keep the board somewhere new | a storage block: see below |
| Show something new in Claude Code | a display block: see below |
| Change the mod's tools, heartbeat or settings | `hooks/register.tsx`, `.claude-plugin/plugin.json` |

## Adding a block

The README's [Make your own block](README.md#make-your-own-block) walks
through each kind.

- **A storage block** (an adapter) usually belongs in its own package, such
  as `modboard-postgres`, not in this repo. It must pass the contract tests in
  `modboard/lib/contract.mjs`. Open an issue if you'd like it listed in the
  README.
- **A display block** goes in `hooks/blocks/` as its own file, listed in
  `hooks/blocks/index.ts`. Add tests in `tests/pane.test.tsx` for what it
  shows, including when it shows nothing. The band never wraps, so give it a
  narrower form and check it fits.
- **A block that only shows a command's output** needs no code at all: the
  `blocks` setting already does that.

## Style

- **Plain words in anything a person reads**: the band, the pane, CLI output,
  docs. "Stopped partway", not "released with handoff". The CLI flags and the
  tools keep the precise terms (claim, lease, handoff), because agents act on
  them.
- **Say a thing once.** If the heading or the order already says it, the row
  doesn't: under "In progress", a row names only who ("backend").
- **Colour only when something needs the person**: theme `warning` from
  70%, `error` from 90%, and alerts. Nothing is green for "fine".
- **Show what's left, then a count.** Long lists stop at eight rows
  (`SHOWN` in `hooks/blocks/types.tsx`) and end in "N more". Work that needs
  the person is never cut.
- **One look for one idea.** Anything that fills up uses the bar in
  `hooks/blocks/meter.tsx`: the context and the 5-hour limit both do.
- **No new dependencies** in the CLI or engine.
- **Commit messages** say what changed and why, in a short first line and,
  where it helps, a few lines below it.

## Reporting a problem

Open an issue at [Magithar/modboard](https://github.com/Magithar/modboard/issues)
with what you ran, what you expected and what happened. Include the output of
`board doctor` if the board's state looks wrong.

By contributing, you agree that your contributions are licensed under the
project's [MIT license](LICENSE).
