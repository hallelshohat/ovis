### Fixed
- Long messages sent through Herdr finish writing when its socket accepts only part of the request,
  instead of timing out. A sender that loses permission while waiting sends no remaining bytes.
- Antigravity chat can read its saved catalog when the temporary directory includes a symbolic link,
  as on macOS, without changing the original database or its side files.
