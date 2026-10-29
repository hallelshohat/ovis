### Added
- A workspace that is a herdr-projects board task's space has the board's actions in its row menu
  (right-click on a desktop, ⋯ on a phone): Archive task, with Undo; Stop agent while it works;
  Approve plan, Allow request for a permission the agent waits for, or Approve and merge after a
  question; and Remove task after a question that names it and says unsaved or unmerged work is
  kept. Each PC's header has a Board tasks button listing every task on its board, also those whose
  space has closed, with the same actions and Archive done tasks for every repo or one. The board's
  own CLI does each action, and its message or refusal shows beside it; an approve for a step the
  task has already left is refused rather than merged.
  An action runs in the background: its task's row is greyed with what is under way (Archiving…,
  Removing…) until the board is done, and the rest of the page stays usable.
