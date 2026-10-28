/**
 * What a chat's own transcript says about its pull requests: every GitHub PR link it wrote (an
 * agent's `gh pr create`, a pasted URL) and every branch it ran on. Claude Code stamps
 * `gitBranch` on each message; Codex names the branch once, in its session meta. Only the end of
 * a transcript is read, and only stores that hold one chat per file: a database holds others too.
 */
export interface ChatSources {
  urls: { url: string; at: string | null }[];
  branches: { branch: string; at: string | null }[];
  started_at: string | null;
}

export const SOURCE_SCAN_BYTES = 32 * 1024 * 1024;
const PER_CHAT_FILES = new Set(["claude-transcript", "codex-transcript", "pi-transcript", "omp-transcript", "omo-transcript", "gjc-transcript", "cmd-transcript", "grok-transcript"]);
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;

export async function chatSources(path: string, source: string): Promise<ChatSources> {
  const sources: ChatSources = { urls: [], branches: [], started_at: null };
  if (!PER_CHAT_FILES.has(source)) return sources;
  const file = Bun.file(path);
  const size = file.size;
  const start = Math.max(0, size - SOURCE_SCAN_BYTES);
  const lines = (await file.slice(start, size).text()).split("\n");
  // a cut first line is half a record
  if (start > 0) lines.shift();
  for (const line of lines) if (line.length > 0) scanLine(line, sources);
  return sources;
}

export function scanLine(line: string, into: ChatSources): void {
  let record: unknown = null;
  try { record = JSON.parse(line); } catch { /* still scanned for links */ }
  const fields = typeof record === "object" && record !== null ? record as Record<string, unknown> : {};
  const at = typeof fields["timestamp"] === "string" ? fields["timestamp"] : null;
  if (at !== null && into.started_at === null) into.started_at = at;
  const payload = fields["payload"];
  const codexGit = fields["type"] === "session_meta" && typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)["git"] : undefined;
  const branch = typeof fields["gitBranch"] === "string" ? fields["gitBranch"]
    : typeof codexGit === "object" && codexGit !== null && typeof (codexGit as Record<string, unknown>)["branch"] === "string" ? (codexGit as Record<string, string>)["branch"] : null;
  if (branch && into.branches.at(-1)?.branch !== branch) into.branches.push({ branch, at });
  for (const match of line.matchAll(PR_URL)) {
    const url = `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`;
    if (!into.urls.some((seen) => seen.url === url)) into.urls.push({ url, at });
  }
}
