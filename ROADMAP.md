# Roadmap

What's planned for modboard, and what's waiting on what. Nothing here is
promised by a date. Shipped work goes in the [changelog](CHANGELOG.md).

## Next

### Checks: command blocks that keep their last result

Your command blocks (tests, CI, anything with an output) gathered under one
heading, each keeping its last good result when the command stops working,
and saying how old it is.

```
▾ Checks

  tests   ✓ 42 passed · login · 12 min ago
  ci      success · not updating since 14:02
```

- A `checks` block, ticked and moved like any other, shows every command
  block under a **Checks** heading, in the order the `blocks` setting names
  them. Folded, one line: `▸ Checks · tests ✓ · ci ✓`.
- A command that fails keeps its last good output instead of going blank.
- A result older than 5 minutes says its age in grey; one whose command has
  failed for 5 minutes says `not updating since 14:02` in yellow, and the
  folded heading turns yellow too. Both times are settings.
- A command that has never succeeded says so in the pane, rather than
  showing nothing.
- In the pane only; the band stays as it is.

### Colours: `/board colours`

Change the board's colours without touching a setting. `/board colours`
opens a short screen, one row a colour, each drawn as the thing it colours:

```
 Colours · click one to change it

   In progress · Fix login          terminal
   T-004 · 3 open · from TASKS.md   grey
   1 active                         green
   [T-005]   ▓▓▓▓▓▓▓░░░  75%        yellow
   ▓▓▓▓▓▓▓▓▓░  95%   not updating   red

   reset
```

- Click a row and Claude Code asks which colour: three ready ones, or any
  typed under Other (`#ff8800`, `orange`, `rgb(255,136,0)`).
- Every place that means the same thing follows: text covers headings,
  buttons and task titles; grey covers IDs, counts and labels; yellow covers
  the unfinished boxes, idle rows and bars from 70%; red covers bars from
  90% and the `board not updating` line.
- Kept between sessions; **reset** puts them back.
- `modBOARD`'s green is fixed and never offered.

It's a separate piece: the board works without it. A first version is
built on the `colours` branch, kept out of the release until it settles.

Left before it ships:

- Try the click-to-pick flow by hand in a live session (the test kit
  can't answer Claude Code's question dialog).
- Work through the issues found trying it.
- Decide how a fixed colour should behave across light and dark themes.
- Check exact colours on terminals with 256 colours only (macOS Terminal).
