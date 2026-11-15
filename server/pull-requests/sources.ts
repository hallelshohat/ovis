/**
 * What a chat's own transcript says about its pull requests: every GitHub PR link it wrote (an
 * agent's `gh pr create`, a pasted URL) and every branch it ran on. Claude Code stamps
 * `gitBranch` on each message; Codex names the branch once, in its session meta.
 *
 * A transcript that is one append-only file is read whole once, a chunk at a time, and after that
 * only what was appended since (a file that shrank or was replaced is read again from the start).
 * A store that holds many chats (OpenCode's and Devin's databases, Hermes, Agy) is read through the
 * chat's own conversation pages: back to its beginning once, then its newest page.
 */
import { statSync } from "node:fs";
import type { ConversationTurn } from "../../shared/protocol.ts";

export interface ChatSources {
  urls: { url: string; at: string | null }[];
  branches: { branch: string; at: string | null }[];
  started_at: string | null;
}

/** One chat: who it is (a new chat in the same pane is another one) and how to read what it says. */
export interface Chat { id: string; read(): Promise<ChatSources> }

export const PER_CHAT_FILES = new Set(["claude-transcript", "codex-transcript", "pi-transcript", "omp-transcript", "omo-transcript", "gjc-transcript", "cmd-transcript", "grok-transcript"]);
export const MAX_PAGES = 500;
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;

const empty = (): ChatSources => ({ urls: [], branches: [], started_at: null });

/** How many bytes the file reader has read, all files together: tests see that an append reads only the append. */
export let fileBytesRead = 0;

const files = new Map<string, { ino: number; offset: number; carry: string; sources: ChatSources }>();
const pages = new Map<string, { sources: ChatSources; seen: Set<string> }>();

export function resetSourceCache(): void {
  files.clear();
  pages.clear();
  fileBytesRead = 0;
}

export async function fileSources(path: string): Promise<ChatSources> {
  let stat: { ino: number; size: number };
  try { stat = statSync(path); } catch { return empty(); }
  let state = files.get(path);
  if (!state || state.ino !== stat.ino || stat.size < state.offset) {
    state = { ino: stat.ino, offset: 0, carry: "", sources: empty() };
    files.set(path, state);
  }
  if (stat.size > state.offset) {
    const decoder = new TextDecoder();
    let carry = state.carry;
    for await (const chunk of Bun.file(path).slice(state.offset, stat.size).stream()) {
      fileBytesRead += chunk.byteLength;
      const lines = (carry + decoder.decode(chunk, { stream: true })).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) if (line.length > 0) scanLine(line, state.sources);
    }
    carry += decoder.decode();
    state.carry = carry;
    state.offset = stat.size;
  }
  // a last line not yet ended is read now and again once it is: a link there is found either way, once
  if (state.carry.length > 0) {
    const peek = structuredClone(state.sources);
    scanLine(state.carry, peek);
    return peek;
  }
  return structuredClone(state.sources);
}

export type PageReader = (page: { before?: string }) => Promise<{ turns: ConversationTurn[]; cursor: string | null }>;

/**
 * A chat in a shared store, by its pages: back to its beginning the first time; after that back from
 * its newest page until a page holds a turn already read, so pages that arrived between two reads
 * are all read, however many.
 */
export async function conversationSources(id: string, read: PageReader): Promise<ChatSources> {
  let known = pages.get(id);
  const first = !known;
  if (!known) {
    known = { sources: empty(), seen: new Set() };
    pages.set(id, known);
  }
  let page = await read({});
  for (let count = 1; ; count++) {
    const met = page.turns.some((turn) => known.seen.has(turnKey(turn)));
    scanTurns(page.turns, known.sources);
    for (const turn of page.turns) known.seen.add(turnKey(turn));
    if ((met && !first) || page.cursor === null || count >= MAX_PAGES) break;
    page = await read({ before: page.cursor });
  }
  return structuredClone(known.sources);
}

/** A turn's identity across reads: its time and what it says. */
function turnKey(turn: ConversationTurn): string {
  return `${turn.ts ?? ""}\0${Bun.hash(JSON.stringify(turn.parts)).toString(36)}`;
}

function scanTurns(turns: readonly ConversationTurn[], into: ChatSources): void {
  for (const turn of turns) {
    if (turn.ts !== null && (into.started_at === null || turn.ts < into.started_at)) into.started_at = turn.ts;
    collectUrls(JSON.stringify(turn.parts), turn.ts, into);
  }
  into.urls.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
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
  collectUrls(line, at, into);
}

function collectUrls(text: string, at: string | null, into: ChatSources): void {
  for (const match of text.matchAll(PR_URL)) {
    const url = `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`;
    const seen = into.urls.find((known) => known.url === url);
    if (!seen) into.urls.push({ url, at });
    else if (at !== null && (seen.at === null || at < seen.at)) seen.at = at;
  }
}

/** The chat a transcript file is: its path names it. */
export function fileChat(path: string): Chat {
  return { id: `file:${path}`, read: () => fileSources(path) };
}
