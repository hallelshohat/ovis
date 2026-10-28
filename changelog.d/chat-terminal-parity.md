### Changed
- Chat draws an agent's turn in the order the terminal does: what the agent says between tool calls
  stays in view where it said it, each run of tool calls folds into one row at its place, and a
  "Worked for" line closes the turn. Before, a finished turn folded everything the agent said
  before its last tool call under one block at the top.

### Added
- Chat shows live state like the terminal: a running tool call has a spinner, a running command
  opens on the pane's live output until its result arrives, a finished command shows its exit
  status, and "Working…" and "Thinking…" count the time elapsed.
