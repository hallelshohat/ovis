### Added
- A chat's pull requests: the links its agent wrote and the PRs of every branch it ran on, read
  with `gh` in the pane's folder. The one that needs you leads, with +N for the others, on its
  sidebar rows, in the message box's strip and in the header; an inspector beside the pane (a sheet
  on a narrow window) lists their checks and review, asks the agent to fix failing checks through
  the message box, and squashes and merges after a confirmation. The thread shows where each PR was
  opened, merged or closed, and where the agent switched branch.

### Changed
- The workbench look: each pane is a panel inset from the app's chrome, dialogs that hold a form
  or a list open as a sheet down the right side, a diff takes the pane's place, and a work block's
  tool calls hang on a timeline whose nodes fill as each call settles.
- One section label style everywhere, one empty state for diffs, the changes list and the palette,
  and motion for dialogs, menus, the inspector, list reordering and pull request states, all still
  under reduced motion.
