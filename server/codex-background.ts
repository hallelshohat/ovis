/**
 * A Codex session's background terminals (what its `/ps` lists): the exec sessions its commands
 * ran in once they outlived their first wait, read from the rollout. Each is a task `exec-<id>`
 * first discovered by the answer that named the session, with native events refining its start
 * time. It gathers polled output and ends with a CommandExecution completion or a chunk's exit
 * code. The sheet keeps only polled output, so it shows what the agent read of it. A session the
 * rollout never saw end runs while the pane still runs this Codex session, and is lost after.
 *
 * The rollout is read from where the last read stopped (its last ROLLOUT_WINDOW bytes the first
 * time), so a list polled every few seconds costs only what was appended.
 */
import { codexChunks, codexInputSessions } from "../shared/codex-chunks.ts";
import type { OmoTask } from "../shared/protocol.ts";
import { plain, readLines, remember } from "./claude-subagents.ts";
import { sliceOutput, type OutputSlice } from "./background-output.ts";
import { codexNativeItem } from "./codex-items.ts";
import { match } from "ts-pattern";
import { z } from "zod";

const ROLLOUT_WINDOW = 16 * 1024 * 1024;
const READ_BUDGET = 8 * 1024 * 1024;
/** what is kept of each session's output: a sheet shows its end */
const OUTPUT_KEEP = 512 * 1024;
const TITLE_LENGTH = 120;
const SESSION_LIMIT = 2048;
const RECENT_LIMIT = 10;
const RECENT_MS = 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;

interface Session {
  id: string; command: string | null; startedAt: number | null; endedAt: number | null; exitCode: number | null; output: string;
  callStartedAt: number | null; observedAt: number | null; nativeId: string | null; allowEarlyCompletion: boolean;
}
interface Completion { exitCode: number; endedAt: number | null }
interface NativeExecution { id: string; startedAt: number; endedAt: number | null; exitCode: number | null }

/** One tool call a Codex exec call made: a command it started, or a poll of a session. */
interface ExecCall { command: string | null; session: string | null; poll: boolean; polled?: Session }

export interface CodexBackground {
  /** the tool calls each exec call made, in order, by call id, until its answer */
  calls: Map<string, { startedAt: number | null; calls: ExecCall[] }>;
  sessions: Map<string, Session>;
  /** Process IDs are recycled; retain the latest native command identity and its lifetime. */
  nativeExecutions: Map<string, NativeExecution>;
}

export const codexBackgroundState = (): CodexBackground => ({ calls: new Map(), sessions: new Map(), nativeExecutions: new Map() });

/** A tool answer's text: a string, or the text blocks of a list. */
function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((block) => { const text = row(block)?.["text"]; return typeof text === "string" ? text : ""; }).join("\n");
  const nested = row(value)?.["output"];
  return typeof nested === "string" ? nested : "";
}

const unquote = (body: string): string => { try { return JSON.parse(`"${body}"`) as string; } catch { return body; } };

/** The tool calls an exec script makes (`tools.exec_command({cmd:"…"})`, `tools.write_stdin({session_id:N})`), in the order it names them. */
function scriptCalls(input: string): ExecCall[] {
  return [...input.matchAll(/tools\.(exec_command|write_stdin)\(\s*\{((?:[^"}]|"(?:[^"\\]|\\.)*")*)\}/g)].map((match) => {
    if (match[1] === "write_stdin") return { command: null, session: codexInputSessions(match[2]!)[0] ?? null, poll: true };
    const cmd = /"?cmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(match[2]!);
    return { command: cmd === null ? null : unquote(cmd[1]!), session: null, poll: false };
  });
}

/** Take one rollout line into `state`. */
export function feedCodexLine(state: CodexBackground, line: string): void {
  if (!/exec|session|exit/.test(line)) return;
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch { return; }
  const payload = row(entry?.["payload"]);
  if (payload === null) return;
  const at = typeof entry?.["timestamp"] === "string" ? Date.parse(entry["timestamp"]) : NaN;
  const when = Number.isFinite(at) ? at : null;
  if (entry?.["type"] === "event_msg") {
    feedNativeExecution({ state, payload, when });
    return;
  }
  if (typeof payload["call_id"] !== "string") return;
  const callId = payload["call_id"];
  if (payload["type"] === "function_call" && typeof payload["arguments"] === "string" && (payload["name"] === "exec_command" || payload["name"] === "write_stdin")) {
    let args: Row | null = null;
    try { args = row(JSON.parse(payload["arguments"])); } catch { /* cut: the session is named without its command */ }
    const cmd = args?.["cmd"];
    const command = Array.isArray(cmd) ? cmd.join(" ") : typeof cmd === "string" ? cmd : null;
    const session = payload["name"] === "write_stdin" ? codexInputSessions(payload["arguments"])[0] ?? null : null;
    rememberCalls({ state, callId, startedAt: when, calls: [{ command: payload["name"] === "exec_command" ? command : null, session, poll: payload["name"] === "write_stdin" }] });
    return;
  }
  if (payload["type"] === "custom_tool_call" && typeof payload["input"] === "string") {
    rememberCalls({ state, callId, startedAt: when, calls: scriptCalls(payload["input"]) });
    return;
  }
  if (payload["type"] !== "function_call_output" && payload["type"] !== "custom_tool_call_output") return;
  const parent = state.calls.get(callId);
  const calls = parent?.calls ?? [];
  state.calls.delete(callId);
  const chunks = codexChunks(outputText(payload["output"]));
  // one answer object per call, in order, when the counts agree: the call says which session a chunk that names none was
  const paired = chunks.length === calls.length;
  // shortcut: ambiguous early exits wait for a poll; use nested call IDs if Codex starts exposing them.
  const startedIds = calls.flatMap((call, index) => call.poll ? [] : [chunks[index]?.session ?? null]);
  const allowEarlyCompletion = paired && !startedIds.includes(null) && new Set(startedIds).size === startedIds.length;
  chunks.forEach((chunk, index) => {
    const call = paired ? calls[index] : calls.length === 1 ? calls[0] : undefined;
    const id = chunk.session ?? call?.session ?? null;
    if (id === null) return;
    let session = state.sessions.get(id);
    if (call?.poll && call.polled !== session) return;
    if (session === undefined || (paired && call && !call.poll && chunk.session !== null)) {
      // only the answer that first names a session starts it: a poll of one not seen began before the window
      session = { id, command: chunk.session !== null ? call?.command ?? null : null, startedAt: when, endedAt: null, exitCode: null, output: "",
        callStartedAt: call && !call.poll ? parent?.startedAt ?? null : null, observedAt: when, nativeId: null, allowEarlyCompletion };
      remember(state.sessions, id, session, SESSION_LIMIT);
      const execution = state.nativeExecutions.get(id);
      if (execution !== undefined) applyNativeExecution({ session, execution });
    }
    session.output = (session.output + chunk.text).slice(-OUTPUT_KEEP);
    if (chunk.exitCode !== null) finishCodexSession({ session, completion: { exitCode: chunk.exitCode, endedAt: when } });
  });
}

function rememberCalls({ state, callId, startedAt, calls }: { state: CodexBackground; callId: string; startedAt: number | null; calls: ExecCall[] }): void {
  for (const call of calls) if (call.session !== null) call.polled = state.sessions.get(call.session);
  remember(state.calls, callId, { startedAt, calls }, 512);
}

function feedNativeExecution({ state, payload, when }: { state: CodexBackground; payload: unknown; when: number | null }): void {
  const parsed = executionEventSchema.safeParse(payload);
  if (!parsed.success) return;
  const event = parsed.data;
  const display = codexNativeItem(event.item)?.display;
  if (!display?.processId || display.part.kind !== "tool") return;
  const part = display.part;
  const result = match(event.type)
    .with("item_started", () => part.state === "pending" ? { endedAt: null, exitCode: null } : null)
    .with("item_completed", () => {
      const endedAt = event.completed_at_ms ?? when;
      if (part.state === "pending" || part.exit_code === undefined || endedAt === null || endedAt < event.started_at_ms) return null;
      return { endedAt, exitCode: part.exit_code };
    })
    .exhaustive();
  if (result === null) return;
  const execution = { id: display.id, startedAt: event.started_at_ms, ...result };
  const previous = state.nativeExecutions.get(display.processId);
  if (previous && (previous.startedAt > execution.startedAt || (previous.id === execution.id && previous.endedAt !== null))) return;
  remember(state.nativeExecutions, display.processId, execution, SESSION_LIMIT);
  const session = state.sessions.get(display.processId);
  if (session !== undefined) applyNativeExecution({ session, execution });
}

function applyNativeExecution({ session, execution }: { session: Session; execution: NativeExecution }): void {
  if (session.nativeId !== null && session.nativeId !== execution.id) return;
  if (session.nativeId === null) {
    if (session.observedAt === null || execution.startedAt > session.observedAt) return;
    if (session.callStartedAt !== null && execution.startedAt < session.callStartedAt) return;
    if (execution.endedAt !== null && execution.endedAt < session.observedAt && !(session.callStartedAt !== null && session.allowEarlyCompletion)) return;
    session.nativeId = execution.id;
    session.startedAt = execution.startedAt;
  }
  if (execution.exitCode !== null) finishCodexSession({ session, completion: { exitCode: execution.exitCode, endedAt: execution.endedAt } });
}

const executionEventSchema = z.object({
  type: z.enum(["item_started", "item_completed"]), item: z.unknown(),
  started_at_ms: z.number().int().nonnegative(), completed_at_ms: z.number().int().nonnegative().optional(),
});

function finishCodexSession({ session, completion }: { session: Session; completion: Completion }): void {
  if (session.endedAt !== null) return;
  session.exitCode = completion.exitCode;
  session.endedAt = completion.endedAt ?? session.startedAt ?? 0;
}

const iso = (at: number | null): string | null => at === null ? null : new Date(at).toISOString();

/** The sessions as tasks: running ones first (oldest first), then up to ten that ended in the last day, newest first. */
export function codexBackgroundTasks(state: CodexBackground, live: boolean, now = Date.now()): OmoTask[] {
  const running: OmoTask[] = [];
  const ended: OmoTask[] = [];
  for (const session of state.sessions.values()) {
    const done = session.endedAt !== null;
    const command = session.command;
    const task: OmoTask = {
      id: `exec-${session.id}`,
      title: (command ?? "Background command").split("\n")[0]!.slice(0, TITLE_LENGTH),
      category: "shell", model: null,
      status: done ? (session.exitCode === 0 ? "completed" : "failed") : live ? "running" : "lost",
      started_at: iso(session.startedAt), ended_at: iso(session.endedAt),
      turns: null, tool_calls: null, tokens: null,
      detail_kind: "output", kind: "exec", command, exit_code: session.exitCode, tool_use_id: null,
    };
    if (task.status === "running") running.push(task);
    else if (now - (session.endedAt ?? session.startedAt ?? 0) <= RECENT_MS) ended.push(task);
  }
  const time = (value: string | null): number => value === null ? 0 : Date.parse(value);
  running.sort((a, b) => time(a.started_at) - time(b.started_at));
  ended.sort((a, b) => (time(b.ended_at) || time(b.started_at)) - (time(a.ended_at) || time(a.started_at)));
  return [...running, ...ended.slice(0, RECENT_LIMIT)];
}

/** One session's output as the output route gives it, read from the kept text. */
export function codexSessionOutput(state: CodexBackground, taskId: string, from: number | null): OutputSlice | null {
  const session = state.sessions.get(taskId.replace(/^exec-/, ""));
  if (session === undefined) return null;
  const bytes = Buffer.from(session.output, "utf8");
  return sliceOutput(bytes.length, from, (position, length) => bytes.subarray(position, position + length));
}

const reads = new Map<string, { id: string; offset: number; skipping: boolean; state: CodexBackground }>();

/** The background state of the rollout at `path`, read on from where the last read stopped. */
export function readCodexBackground(path: string): CodexBackground | null {
  const stat = plain(path);
  if (stat === null) return null;
  let read = reads.get(path);
  if (read === undefined || read.id !== stat.id || read.offset > stat.size) {
    const from = Math.max(0, stat.size - ROLLOUT_WINDOW);
    read = { id: stat.id, offset: from, skipping: from > 0, state: codexBackgroundState() };
  }
  remember(reads, path, read, 64);
  const current = read;
  while (current.offset < stat.size) {
    const next = readLines(path, current.offset, stat, READ_BUDGET, (line) => feedCodexLine(current.state, line), current.skipping);
    if (next.failed || next.offset === current.offset) break;
    current.offset = next.offset;
    current.skipping = next.skipping;
  }
  return current.state;
}

const located = new Map<string, { path: string | null; at: number }>();
/** how long a pane's rollout, once found, is taken as its own: finding it asks herdr and lists processes */
const LOCATE_MS = 5000;
const LOCATE_WAIT_MS = 1000;

/**
 * The background state of the Codex session a pane runs now, null for a pane that runs none.
 * `locate`: the rollout of a Codex pane (codex.ts codexTranscriptPath), injected so the route's
 * tests need no Codex.
 */
export async function paneCodexBackground(paneId: string, locate: (paneId: string) => Promise<string | null>, now = Date.now()): Promise<CodexBackground | null> {
  let known = located.get(paneId);
  if (known === undefined || now - known.at > LOCATE_MS) {
    // herdr slow to answer: no Codex list this time, the next ask looks again
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), LOCATE_WAIT_MS); });
    const path = await Promise.race([locate(paneId).catch(() => null), late]).finally(() => clearTimeout(timer));
    if (path === null) return null;
    known = { path, at: now };
    remember(located, paneId, known, 256);
  }
  return known.path === null ? null : readCodexBackground(known.path);
}
