# Roadmap

What's planned for modboard, and what's waiting on what. Nothing here is
promised by a date. Shipped work goes in the [changelog](CHANGELOG.md).

## Next

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
