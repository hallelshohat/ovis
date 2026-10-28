# Live-output screens

Real panes of an agent running a slow command, read by `src/lib/workBlocks.test.ts`
(`screenToolOutput`, `codexLiveOutput`). Recorded 2026-10-28 in a private tmux, 120 columns, with
the prompt "Run exactly this one shell command in the foreground: cd /tmp && for i in 1 2 3 4 5 6;
do echo "progress line $i …"; sleep 2; done; sleep 90; echo finished". The scratch folder's path
reads `/tmp/work`; blank rows in the middle of a screen are cut.

- `claude-2.1.312-running-120.txt`: Claude Code 2.1.312 at 21s. It prints no output while a command
  runs, only `(21s · 7 lines)`: the lines are in Claude's `tasks/<id>.output` file.
- `claude-thinking-two-commands-120.txt`: the pane of the OVS-13 screenshot (a Claude Code of the
  same week), typed out row by row from it.
- `codex-0.165.0-running-120.txt`: Codex 0.165.0 at 33s, "Waiting for background terminal".
- `codex-0.165.0-running-parts.json`: that Codex run's rollout records for the command, as
  `createCodexTranscriptParser` turns them into tool parts (each `write_stdin` poll's chunk).
