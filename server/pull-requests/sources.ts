/**
 * What a chat's own transcript proves it created, and every branch it ran on. Claude Code stamps
 * `gitBranch` on each message; Codex names the branch once, in its session meta.
 *
 * A transcript that is one append-only file is read whole once, a chunk at a time, and after that
 * only what was appended since (a file that shrank or was replaced is read again from the start).
 * A store that holds many chats (OpenCode's and Devin's databases, Hermes, Agy) is read through the
 * chat's own conversation pages: back to its beginning once, then its newest page.
 */
import { statSync } from "node:fs";
import { z } from "zod";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { createdPrUrls, creationRecordUrls, type CreationCalls } from "./creation.ts";

export interface ChatSources {
  urls: { url: string; at: string | null }[];
  branches: { branch: string; at: string | null }[];
  started_at: string | null;
}

/** One chat: who it is (a new chat in the same pane is another one) and how to read what it says. */
export interface Chat { id: string; read(): Promise<ChatSources> }

export const PER_CHAT_FILES = new Set(["claude-transcript", "codex-transcript", "pi-transcript", "omp-transcript", "omo-transcript", "gjc-transcript", "cmd-transcript", "grok-transcript"]);
export const MAX_PAGES = 500;

const empty = (): ChatSources => ({ urls: [], branches: [], started_at: null });

/** How many bytes the file reader has read, all files together: tests see that an append reads only the append. */
export let fileBytesRead = 0;

const files = new Map<string, { ino: number; offset: number; carry: string; sources: ChatSources; calls: CreationCalls }>();
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
    state = { ino: stat.ino, offset: 0, carry: "", sources: empty(), calls: new Map() };
    files.set(path, state);
  }
  if (stat.size > state.offset) {
    const decoder = new TextDecoder();
    let carry = state.carry;
    for await (const chunk of Bun.file(path).slice(state.offset, stat.size).stream()) {
      fileBytesRead += chunk.byteLength;
      const lines = (carry + decoder.decode(chunk, { stream: true })).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) if (line.length > 0) scanLine({ line, into: state.sources, calls: state.calls });
    }
    carry += decoder.decode();
    state.carry = carry;
    state.offset = stat.size;
  }
  // a last line not yet ended is read now and again once it is: a link there is found either way, once
  if (state.carry.length > 0) {
    const peek = structuredClone(state.sources);
    scanLine({ line: state.carry, into: peek, calls: structuredClone(state.calls) });
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
    if (turn.role === "assistant") for (const part of turn.parts) {
      if (part.kind === "tool") collectUrls({ urls: createdPrUrls({ part }), at: turn.ts, into });
    }
  }
  into.urls.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

const lineSchema = z.object({ timestamp: z.iso.datetime({ offset: true }).optional(), gitBranch: z.string().optional(), type: z.string().optional(), payload: z.unknown().optional() });
const metaSchema = z.object({ git: z.object({ branch: z.string() }).optional() });

function scanLine({ line, into, calls }: { line: string; into: ChatSources; calls: CreationCalls }): void {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  const parsed = lineSchema.safeParse(value);
  if (!parsed.success) return;
  const fields = parsed.data;
  const at = fields.timestamp ?? null;
  if (at !== null && (into.started_at === null || at < into.started_at)) into.started_at = at;
  const meta = fields.type === "session_meta" ? metaSchema.safeParse(fields.payload) : null;
  const branch = fields.gitBranch ?? (meta?.success ? meta.data.git?.branch : null);
  if (branch && into.branches.at(-1)?.branch !== branch) into.branches.push({ branch, at });
  collectUrls({ urls: creationRecordUrls({ value, calls }), at, into });
}

function collectUrls({ urls, at, into }: { urls: string[]; at: string | null; into: ChatSources }): void {
  for (const url of urls) {
    const seen = into.urls.find((known) => known.url === url);
    if (!seen) into.urls.push({ url, at });
    else if (at !== null && (seen.at === null || at < seen.at)) seen.at = at;
  }
}

/** The chat a transcript file is: its path names it. */
export function fileChat(path: string): Chat {
  return { id: `file:${path}`, read: () => fileSources(path) };
}
