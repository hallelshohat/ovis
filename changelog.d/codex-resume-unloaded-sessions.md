### Fixed
- Working Codex chats match complete assistant messages whose Markdown is rendered in the terminal,
  including bold text and inline code, while preserving ambiguity and quoted-output checks.
  Equivalent HTML entity spellings remain ambiguous instead of selecting another conversation.
- Completed Markdown messages also match while Codex is idle; a shared phrase in a different
  conversation no longer blocks an otherwise unique complete message.
- Tool-only Codex screens can resolve through distinct completed native command/output pairs.
  Loaded competing histories, quoted output and picker resumes are checked before showing a chat.
- Resumed Codex chats recover after newer conversations finish and unload when the resumed
  thread is the only loaded conversation, even when tool activity pushes answers off screen.
  Recovery refuses ambiguous threads after a picker resume, including older threads from other folders.
