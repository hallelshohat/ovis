### Added
- Every background task of a Claude Code or Codex session is in the composer's task list: background
  commands, Monitor watches, workflows and subagents of Claude Code, and Codex's background
  terminals, each with its kind, command, state, start, duration and exit code, also for tasks
  started before Ovis opened.
- Opening a background command, a monitor, a workflow or a Codex background terminal shows its
  output streaming live as the terminal printed it, with its ANSI colours, following the end until
  you scroll up.
- A chat card that started a background task says whether it runs, ended or failed (with its exit
  code) and opens it; the task's end shows in the chat as it happens.

### Changed
- A subagent's detail reads like the chat: its prompt as your bubble, its words as formatted text
  and its tool calls as the chat's work rows. Ended subagents open too.
