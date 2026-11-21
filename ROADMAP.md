# Roadmap

What's planned for modboard, and what's waiting on what. Nothing here is
promised by a date. Shipped work goes in the [changelog](CHANGELOG.md).

## Next

### Crashed sessions keep their place

A session that hands off or exits leaves the worktree and the last check
that passed. One that crashes or is killed can't: the board frees its task
after 3 minutes of silence, with a note that it stopped responding. That
note isn't a handoff, so the task lands in Not started, and the pane shows
no `where`, `path` or `check` for it.

- Free a silent session's task as a handoff, so it shows under Unfinished
  ("claude 1 stopped responding; read the notes above").
- Give it the last known worktree, from the task's latest check, so the
  `where`, `path` and `check` rows show and the next agent knows where to
  start.
- Mark that worktree as possibly stale, since the session may have kept
  working after its last check:

  ```
  where  login @ 9056822 · last known, may be stale
  ```

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
