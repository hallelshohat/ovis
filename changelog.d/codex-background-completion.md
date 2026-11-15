### Fixed
- Codex background commands leave the running list when their native completion event arrives,
  even when Codex does not poll their output again.
- Reused Codex process IDs start fresh background tasks instead of inheriting an earlier
  command's completion or losing their own failed exit.
