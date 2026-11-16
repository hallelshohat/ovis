### Fixed
- Chat keeps the conversation visible and retries automatically while its history is still being
  read, instead of showing "Couldn't load the conversation" for a temporary read delay.
- Codex conversation recovery reuses history evidence as tool output advances, so large active
  sessions can finish loading without restarting their history scan for every new tool result.
