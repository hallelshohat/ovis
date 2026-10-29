import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { matchPart, searchPattern } from "../../shared/conversation-search.ts";
import { turnSkills } from "./skillActivity.ts";
import { isTodoTool, todoSnapshot, type TodoItem } from "./todos.ts";
import { t } from "./i18n.ts";

export type ToolPart = Extract<ConversationPart, { kind: "tool" }>;
export type ThinkingPart = Extract<ConversationPart, { kind: "thinking" }>;
export type TextPart = Extract<ConversationPart, { kind: "text" }>;

/**
 * A turn the way Codex shows it: tool calls, reasoning and explicit progress narration fold under
 * one "Worked for 7s · 1 edit" header. Every other assistant response stays in the main chat,
 * including an unphased response followed by more work or another answer.
 */
export interface SplitTurn {
  work: ConversationPart[];
  answer: TextPart[];
}

const isProse = (part: ConversationPart): part is TextPart => part.kind === "text" && part.text.trim().length > 0;
const isAnswer = (part: ConversationPart): part is TextPart => isProse(part) && part.phase !== "commentary";
const isWork = (part: ConversationPart): boolean => part.kind !== "text" || (isProse(part) && part.phase === "commentary");

export function splitTurn(parts: ConversationPart[]): SplitTurn {
  return { work: parts.filter(isWork), answer: parts.filter(isAnswer) };
}

/** `start`: the index of the run's first part in the turn, which names the run while it grows */
export type TurnSegment = { kind: "work"; start: number; parts: ConversationPart[] } | { kind: "answer"; start: number; parts: TextPart[] };
export type WorkSegment = Extract<TurnSegment, { kind: "work" }>;

/**
 * The turn in the agent's own order, as its terminal shows it: each run of work between two
 * prose runs is its own block. Narration stays visible beside answers, while splitTurn still
 * separates commentary from the copyable answer. Whitespace-only text is in neither.
 */
export function turnSegments(parts: ConversationPart[]): TurnSegment[] {
  const segments: TurnSegment[] = [];
  parts.forEach((part, index) => {
    const last = segments.at(-1);
    if (isProse(part)) {
      if (last?.kind === "answer") last.parts.push(part);
      else segments.push({ kind: "answer", start: index, parts: [part] });
    } else if (isWork(part)) {
      if (last?.kind === "work") last.parts.push(part);
      else segments.push({ kind: "work", start: index, parts: [part] });
    }
  });
  return segments;
}

/**
 * The name of each run's block, which also keeps its fold. A run keeps its name while its parts
 * change: words before its tools join it (a record marks them commentary, a blank one is filled
 * in), a part leaves it, or it splits or merges with another run (#2063). `previous` holds the name
 * of the run each part was in when the turn was last drawn, by part index. A run takes the first
 * of those names among its own parts that no earlier run has taken. Only then does a run with none
 * get `work:<start>`, so a new run never takes the name of a run already shown.
 *
 * A run that draws no block (`drawn`: hidden reasoning alone) has no fold to keep: the runs drawn
 * choose first, so it never takes a drawn block's name when the two split or merge (#2111). Its own
 * name is `dormant`, by part index as `previous` is: a run drawn again takes it back, its fold with
 * it, but only after every name a drawn run had.
 */
export function runNames(runs: readonly WorkSegment[], at: ReadonlyMap<ConversationPart, number>, previous: ReadonlyMap<number, string>,
  drawn: (run: WorkSegment) => boolean = () => true, dormant: ReadonlyMap<number, string> = new Map()): string[] {
  const used = new Set<string>();
  const kept: (string | undefined)[] = runs.map(() => undefined);
  const take = (index: number, from: ReadonlyMap<number, string>): void => {
    const name = runs[index]!.parts.map((part) => from.get(at.get(part)!)).find((name) => name !== undefined && !used.has(name));
    if (name !== undefined) { used.add(name); kept[index] = name; }
  };
  const shown = runs.flatMap((run, index) => drawn(run) ? [index] : []);
  const hidden = runs.flatMap((run, index) => drawn(run) ? [] : [index]);
  for (const group of [shown, hidden]) for (const from of [previous, dormant]) for (const index of group) if (kept[index] === undefined) take(index, from);
  return runs.map((run, index) => {
    if (kept[index] !== undefined) return kept[index];
    let name = `work:${at.get(run.parts[0]!)}`;
    while (used.has(name)) name += "+";
    used.add(name);
    return name;
  });
}

/** An answer run as the chat draws it: its words, and with request details on, each run of failed requests as one row. */
export type AnswerItem = { kind: "text"; part: TextPart } | { kind: "failed"; parts: TextPart[] };

/**
 * Consecutive requests the agent recorded as failed read as one row (#901); with `requestDetails`
 * off (a caller that wants them plain), each stays its error line.
 */
export function answerItems(parts: readonly TextPart[], requestDetails: boolean): AnswerItem[] {
  const items: AnswerItem[] = [];
  for (const part of parts) {
    const last = items.at(-1);
    if (!requestDetails || part.failed !== true) items.push({ kind: "text", part });
    else if (last?.kind === "failed") last.parts.push(part);
    else items.push({ kind: "failed", parts: [part] });
  }
  return items;
}

/**
 * With failed requests drawn as rows, the row a search's match (its matched words) is folded in: the
 * index of its first part, which names the row (`failed:<index>`). Null when the turn's first match
 * of those words, the one the search's snippet shows, is drawn outside every such row.
 */
export function foldedRequestsMatch(turn: ConversationTurn, match: string): number | null {
  const pattern = searchPattern(match);
  const index = pattern === null ? undefined : matchPart(turn, pattern);
  const part = index === undefined ? undefined : turn.parts[index];
  if (turn.role === "user" || part?.kind !== "text" || part.failed !== true) return null;
  for (const segment of turnSegments(turn.parts)) {
    if (segment.kind === "work") continue;
    const row = answerItems(segment.parts, true).find((item) => item.kind === "failed" && item.parts.includes(part));
    if (row?.kind === "failed") return turn.parts.indexOf(row.parts[0]!);
  }
  return null;
}

/**
 * A work block is open while its turn runs and folded once the turn settles: the answer stays
 * outside the fold, so a finished turn reads as its answer under one "Worked for" row.
 *
 * A settled turn keeps its block open when explicit commentary comes after the last answer, or
 * when commentary has no answer at all. Folding would hide the newest thing the agent said, or all
 * of it. It takes the turn's parts, not the split: the order decides.
 */
export function workStartsOpen(live: boolean, parts: ConversationPart[]): boolean {
  if (live) return true;
  const lastAnswer = splitTurn(parts).answer.at(-1);
  const after = lastAnswer === undefined ? 0 : parts.lastIndexOf(lastAnswer) + 1;
  // everything readable after the last answer part is work: it is inside the fold
  return parts.slice(after).some((part) => part.kind === "text" && part.text.trim().length > 0);
}

/**
 * Whether one block of a turn starts open, until the reader opens or closes it. `live` and `waiting`
 * are the block's own (only the turn's head runs or waits); `last`: no part of the turn comes after
 * its run. By default that is `workStartsOpen`: the running block open, a settled turn's last block
 * open for words said after its answer. With Collapse work on (Settings → Chat) every block starts
 * folded to its head line, the running one included, as the Codex and Claude apps keep one working
 * line (#2228); the block that waits on the user still opens, since it may hold what they answer.
 */
export function workBlockStartsOpen(block: { live: boolean; waiting: boolean; last: boolean }, parts: ConversationPart[], foldWork: boolean): boolean {
  if (foldWork) return block.waiting;
  return block.live || (block.last && workStartsOpen(false, parts));
}

type WorkCategory = "edit" | "read" | "command" | "other";

/** "{n} edit" / "{n} edits": both forms are translated, Korean uses one */
export const CATEGORY_LABEL: Record<WorkCategory, [singular: string, plural: string]> = {
  edit: ["{n} edit", "{n} edits"],
  read: ["{n} file read", "{n} file reads"],
  command: ["{n} command", "{n} commands"],
  other: ["{n} other tool", "{n} other tools"],
};

function categorize(name: string): WorkCategory {
  const lower = name.toLowerCase();
  // Codex's poll of a running command's terminal: it writes to stdin, it edits nothing
  if (lower === "write_stdin") return "command";
  if (/edit|write|patch|create_file|multiedit/.test(lower)) return "edit";
  if (/^(read|glob|grep|ls|list|search|find|cat)/.test(lower)) return "read";
  if (/bash|command|shell|exec|eval|run/.test(lower)) return "command";
  return "other";
}

/** A tool that runs a command in a shell: the terminal shows its output as it comes. */
export function isCommandTool(name: string): boolean {
  return categorize(name) === "command";
}

/**
 * A finished command's exit status, as the terminal prints it, from what the transcript records:
 * Claude starts a failed Bash result with `Exit code N` and flags a success `ok`; Codex writes the
 * code into the output. Null when the call is no command, still runs, or records no code.
 */
export function commandExitCode(part: ToolPart): number | null {
  if (!isCommandTool(part.name) || part.state === "pending") return null;
  const head = part.output.slice(0, 2000);
  const code = /^(?:Process exited with code|Exit code:?) (\d+)$/m.exec(head) ?? /"exit_code":\s*(\d+)/.exec(head);
  if (code !== null) return Number(code[1]);
  return part.state === "ok" ? 0 : null;
}

/**
 * "1 edit · 2 file reads · 1 command" — the block's header, in the order a reader cares about.
 * The failures are not in it (`workFailed`): a narrow header cuts this line short.
 */
export function workSummary(parts: readonly ConversationPart[]): string {
  const counts: Record<WorkCategory, number> = { edit: 0, read: 0, command: 0, other: 0 };
  for (const part of parts) {
    if (part.kind !== "tool") continue;
    // a todo update is the plan, pinned under the chat, not an edit: TodoWrite would match /write/
    if (!part.skill && !isTodoTool(part.name)) counts[categorize(part.name)] += 1;
  }
  const skills = turnSkills(parts).length;
  return [...(skills > 0 ? [t(skills === 1 ? "{n} skill" : "{n} skills", { n: skills })] : []), ...(Object.keys(counts) as WorkCategory[])
    .filter((category) => counts[category] > 0)
    .map((category) => t(CATEGORY_LABEL[category][counts[category] === 1 ? 0 : 1], { n: counts[category] }))]
    .join(" · ");
}

/**
 * How many calls failed, whatever they were. The folded header says it apart from the counts, where
 * it is never cut: it is what a glance at a finished turn must not miss, and the fold hides the row.
 */
export function workFailed(parts: readonly ConversationPart[]): number {
  return parts.filter((part) => part.kind === "tool" && part.error === true).length;
}

/** "7s" / "1m 12s" for a block header; null when the span is unknown or nonsense. */
export function formatWorkDuration(startTs: string | null, endTs: string | null): string | null {
  if (startTs === null || endTs === null) return null;
  const ms = Date.parse(endTs) - Date.parse(startTs);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return t("{s}s", { s: seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? t("{m}m {s}s", { m: minutes, s: rest }) : t("{m}m", { m: minutes });
  return t("{h}h {m}m", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

/** "12s" since a turn started, for a head that is still running; null when the time is unreadable. */
export function elapsedSince(ts: string | null, now: number): string | null {
  return formatWorkDuration(ts, ts === null ? null : new Date(Math.max(now, Date.parse(ts) || 0)).toISOString());
}

/** A running command's echo on the agent's screen: Claude's `⎿ $ cmd`, an older Claude's `⏺ Bash(cmd`, Codex's `• Running cmd`. */
const RUN_HEADER = /^\s*(?:⎿\s+\$\s|⏺\s+Bash\(|•\s+Running\s)/;
/** what the agent draws around a command's output: its timer, key hints, folded-line counts, a spinner word */
const RUN_CHROME = /^(?:\((?:\d|ctrl\+|esc\b).*\)|… ?\+\d+ lines.*|\+\d+ (?:more )?lines.*|Running…)$/;
const TIMER_SUFFIX = /\s*\(\d+(?:\.\d+)?[smh][^)]*\)$/;
/** A command as an echo shows it: tabs as spaces, a line break and the indent around it as one break, no blank ends. */
const echoForm = (text: string): string => text.replace(/\t/g, " ").replace(/ *\r?\n\s*/g, "\n").trim();

/**
 * A running command's output as the agent's screen shows it, when its own records do not hold it:
 * only the lines under that command's own echo. The echo must be the whole command, every space in
 * it as typed (`echo "A B"` is not `echo "AB"`): one the agent cut with "…" may be any command that
 * starts the same, so it shows nothing rather than maybe another command's output.
 * The agent's thinking and elapsed counters, its narration, the echo itself, key hints, tips and
 * the input box are left out, and a screen that does not show the command answers nothing rather
 * than something else.
 */
export function screenToolOutput(screen: string, command: string, maxLines = 12): string {
  const whole = echoForm(command);
  if (whole.length === 0) return "";
  const lines = screen.split("\n");
  for (let header = lines.length - 1; header >= 0; header--) {
    if (!RUN_HEADER.test(lines[header]!)) continue;
    const body = echoedBody(lines, header, whole);
    if (body !== null) return toolBody(lines, body, maxLines);
  }
  return "";
}

/** One row of a command's echo: its marker and its row's own indent and trailing blanks left out. */
const echoRow = (line: string): string => line.replace(RUN_HEADER, "").replace(/^\s*│/, "").trim();

/**
 * Where the output under a header starts, once the echo's own rows are passed (the echo wraps over
 * rows of its own: they are the command's text, not its output); null when the echo is not this
 * whole command. A wrap stands for a space, a line break of the command or nothing (a word cut at
 * the edge); only the joins that keep the echo the command's start are taken. The echo's last row
 * may end in Claude's timer, and an older Claude's `Bash(…)` in its closing parenthesis.
 */
function echoedBody(lines: readonly string[], header: number, whole: string): number | null {
  const target = /⏺\s+Bash\(/.test(lines[header]!) ? `${whole})` : whole;
  const ends = (echo: string): boolean => echo === target || echo.replace(TIMER_SUFFIX, "") === target;
  let echo = echoRow(lines[header]!);
  let at = header + 1;
  while (!ends(echo) && at < lines.length && lines[at]!.trim().length > 0) {
    const row = echoRow(lines[at]!);
    const next = ["", " ", "\n"].map((join) => echo + join + row).find((joined) => target.startsWith(joined) || ends(joined));
    if (next === undefined) break;
    echo = next;
    at++;
  }
  return ends(echo) ? at : null;
}

/** The call's own rows from `at`: up to a blank row, the input box's rule or a row back at the left edge, chrome left out. */
function toolBody(lines: readonly string[], at: number, maxLines: number): string {
  const body: string[] = [];
  for (; at < lines.length; at++) {
    const line = lines[at]!;
    if (line.trim().length === 0 || /^[─━]{20,}/.test(line) || !/^\s/.test(line)) break;
    const text = line.replace(/^(\s*)[⎿└│]/, (_, space: string) => `${space} `);
    if (!RUN_CHROME.test(text.trim())) body.push(text.replace(TIMER_SUFFIX, ""));
  }
  const indent = Math.min(...body.filter((line) => line.trim().length > 0).map((line) => /^\s*/.exec(line)![0].length));
  return body.map((line) => line.slice(Number.isFinite(indent) ? indent : 0).trimEnd()).slice(-maxLines).join("\n");
}

/** Every Codex exec session a call's input names (a poll's `session_id`), in order. */
const codexInputSessions = (input: string): string[] => [...input.matchAll(/session_id\W{1,3}(\d+)/g)].map((match) => match[1]!);

/** A JSON string's body from its first character on, read as far as it goes: a page may carry it cut (`… trimmed`). */
function jsonStringAt(text: string, at: number): { value: string; end: number } {
  const body = /^(?:[^"\\]|\\.)*/.exec(text.slice(at))![0];
  // a cut string may stop inside an escape: what is left of it is dropped
  const whole = body.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, "");
  try { return { value: JSON.parse(`"${whole}"`) as string, end: at + body.length + 1 }; } catch { return { value: "", end: at + body.length + 1 }; }
}

/**
 * The chunks of command output one Codex exec call read, each with the session it came from (null
 * when the chunk does not say). A native call's text starts with its own envelope (`Process running
 * with session ID N`, then `Output:`): the first `Output:` line is the envelope's, whatever the
 * command printed after it. An exec cell's answer holds one JSON object per tool it ran, several
 * sessions side by side when it ran several commands.
 */
function codexChunks(output: string): { session: string | null; text: string }[] {
  const text = output.replace(/\n… trimmed$/, "");
  const envelope = text.indexOf("Output:\n");
  if (envelope !== -1) {
    const native = /session ID (\d+)/.exec(text.slice(0, envelope));
    if (native !== null) return [{ session: native[1]!, text: text.slice(envelope + "Output:\n".length) }];
  }
  const chunks: { session: string | null; text: string }[] = [];
  for (const match of text.matchAll(/"output":"/g)) {
    const at = match.index + match[0].length;
    const { value, end } = jsonStringAt(text, at);
    // the session is a key of the same object: before the output, back to its brace, or after it, up to its close
    const before = text.slice(text.lastIndexOf("{", match.index) + 1, match.index);
    const after = text.slice(end, text.indexOf("}", end) === -1 ? undefined : text.indexOf("}", end));
    const session = /"session_id":\s*(\d+)/.exec(before)?.[1] ?? /"session_id":\s*(\d+)/.exec(after)?.[1] ?? null;
    chunks.push({ session, text: value });
  }
  return chunks;
}

/** A call's chunks with a session each: one that names none is the session the call's input polls, when it names one. */
function codexCallChunks(call: ToolPart, output: string): { session: string | null; text: string }[] {
  const polled = codexInputSessions(call.input);
  return codexChunks(output).map((chunk) => ({ session: chunk.session ?? (polled.length === 1 ? polled[0]! : null), text: chunk.text }));
}

/** The earlier calls of `parts` with output of the running call's Codex exec sessions; null when it names none. */
export function codexSessionCalls(parts: readonly ConversationPart[], part: ToolPart): ToolPart[] | null {
  const sessions = new Set(codexInputSessions(part.input));
  if (sessions.size === 0) return null;
  const calls: ToolPart[] = [];
  for (const other of parts) {
    if (other === part) break;
    if (other.kind !== "tool") continue;
    const named = codexInputSessions(other.input).some((id) => sessions.has(id))
      || codexCallChunks(other, other.output).some((chunk) => chunk.session !== null && sessions.has(chunk.session))
      // a cut output may have lost the session id with its tail: the whole one says
      || (other.output_ref !== undefined && /Output:\n|"output":"/.test(other.output));
    if (named) calls.push(other);
  }
  return calls;
}

/**
 * A running Codex command's output so far, from its own records: Codex runs a long command in an
 * exec session and records each chunk it read as the answer of a poll (`write_stdin`), so the
 * earlier calls of the turn on the running call's session hold it all, and only the chunks of that
 * session are taken from a call that read several. `parts` is the whole turn: the agent's words
 * between two polls do not hide the chunks before them. A chunk cut to the page's length is read
 * from `whole` (the call's whole output by its `output_ref`) once it is there. Null when the call
 * names no session (Codex's first call of a command, another agent's tool).
 */
export function codexLiveOutput(parts: readonly ConversationPart[], part: ToolPart, whole: ReadonlyMap<string, string> = new Map()): string | null {
  const calls = codexSessionCalls(parts, part);
  if (calls === null) return null;
  const sessions = new Set(codexInputSessions(part.input));
  return calls.flatMap((call) => codexCallChunks(call, (call.output_ref === undefined ? undefined : whole.get(call.output_ref)) ?? call.output))
    .filter((chunk) => chunk.session !== null && sessions.has(chunk.session))
    .map((chunk) => chunk.text).join("").replace(/\s+$/, "");
}

/** The ids of Claude Code task files the turn's results name: a background call's own file, which is no running command's. */
function claudeNamedTasks(parts: readonly ConversationPart[]): Set<string> {
  const ids = new Set<string>();
  for (const part of parts) {
    if (part.kind !== "tool") continue;
    for (const match of part.output.matchAll(/tasks\/([A-Za-z0-9_-]+)\.output|\bwith ID: ([A-Za-z0-9_-]+)/g)) ids.add(match[1] ?? match[2]!);
  }
  return ids;
}

/**
 * A running Claude Code command's output among the task files the server read for its turn
 * (oldest first): the files a result of the turn names are background tasks' and are left out; the
 * rest are the commands still running, in the order they started, as the turn's pending commands are.
 */
export function claudeLiveOutput(outputs: readonly { id: string; text: string }[], parts: readonly ConversationPart[], part: ToolPart): string {
  const named = claudeNamedTasks(parts);
  const files = outputs.filter((output) => !named.has(output.id));
  const running = parts.filter((other): other is ToolPart => other.kind === "tool" && other.state === "pending" && isCommandTool(other.name));
  const index = running.indexOf(part);
  // a file per running command, the last ones started: one not made yet leaves this row empty
  return index === -1 || files.length < running.length ? "" : files[files.length - running.length + index]!.text;
}

/**
 * end_ts is the latest activity time, not proof that an approval-blocked turn finished.
 *
 * `sentOver` is the assistant turn that was last when a message was sent. The pushed status turns
 * `working` before the transcript holds the new user message, so until it does, that finished turn
 * is still the last one and must not be titled as if it were the one running. The turn itself, not
 * its time: a turn may have no `ts`, and the browser's clock and the transcript's need not agree.
 *
 * A turn that ended on its final answer is over as well, with no send from here to say so: an agent
 * at work again is in a turn the transcript does not hold yet (one it began by itself when a
 * background task ended, or a message from the terminal or another device).
 */
export function isLiveWorkTurn(turn: ConversationTurn, last: boolean, status?: string, sentOver?: ConversationTurn | null): boolean {
  if (turn === sentOver) return false;
  if (status === "working" && endedOnAnswer(turn)) return false;
  return last && turn.role === "assistant" && (status === "working" || status === "blocked");
}

/** The turn's last part is its final answer: the agent ended the turn there. */
export function endedOnAnswer(turn: ConversationTurn): boolean {
  const end = turn.parts.at(-1);
  return end?.kind === "text" && end.phase === "final_answer";
}

/**
 * One todo call in a run of them. `state` is the transcript's own word for it (shared/protocol.ts):
 * `unknown` when it records none (Codex after its output, other agents, older servers). Nothing
 * here reads the output text or its emptiness for an outcome.
 */
export interface TodoAttempt {
  part: ToolPart;
  state: "ok" | "pending" | "error" | "unknown";
  /** the list this call left, null when it cannot be read */
  items: TodoItem[] | null;
}

/**
 * Todo calls the agent made one after another, with nothing between them, drawn as one row: the
 * plan's progress without a line per snapshot. Every attempt stays inside it, in order.
 */
export interface TodoGroup {
  /** stable while calls are appended and the page is polled again: the first call's own id, in its turn's row */
  id: string;
  attempts: TodoAttempt[];
  /**
   * The list the row stands for: the latest call that completed (`ok`, or done with no recorded
   * outcome). Null when none did. Its items are null when that list cannot be read; an earlier list
   * never stands in for it.
   */
  current: TodoAttempt | null;
  /** calls that have not answered, and calls that failed (by the transcript's flag) */
  pending: number;
  failed: number;
}

function attemptOf(part: ToolPart): TodoAttempt {
  return { part, state: part.state ?? "unknown", items: todoSnapshot(part) };
}

/**
 * The runs of two or more todo calls in a turn, by their first call. It walks the turn's own parts,
 * before hidden thinking, skills or the answer are taken out: any other part, narration included,
 * ends a run, so nothing the agent did between two updates is folded away. `rowKey` is the turn's
 * row in the timeline; with the first call's original index it names a run whose calls carry no id.
 */
export function todoGroups(parts: readonly ConversationPart[], rowKey: string): Map<ToolPart, TodoGroup> {
  const groups = new Map<ToolPart, TodoGroup>();
  let run: { start: number; parts: ToolPart[] } | null = null;
  const close = () => {
    if (run !== null && run.parts.length > 1) {
      const first = run.parts[0]!;
      const attempts = run.parts.map(attemptOf);
      let current: TodoAttempt | null = null;
      // a call flagged failed never stands for the list, whatever state it carries
      for (const attempt of attempts) if ((attempt.state === "ok" || attempt.state === "unknown") && attempt.part.error !== true) current = attempt;
      groups.set(first, {
        id: JSON.stringify([rowKey, first.call_id ?? `#${run.start}`]),
        attempts,
        current,
        pending: attempts.filter((attempt) => attempt.state === "pending").length,
        failed: attempts.filter((attempt) => attempt.state === "error" || attempt.part.error === true).length,
      });
    }
    run = null;
  };
  parts.forEach((part, index) => {
    if (part.kind === "tool" && !part.skill && isTodoTool(part.name)) {
      if (run === null) run = { start: index, parts: [] };
      run.parts.push(part);
    } else close();
  });
  close();
  return groups;
}

/** The rows a work block draws: skills are chips beside the prompt, thinking only when shown. */
export function visibleWorkParts(parts: ConversationPart[], showThinking: boolean): ConversationPart[] {
  return parts.filter((part) => part.kind !== "skill" && (showThinking || part.kind !== "thinking"));
}

/**
 * Whether the open work block's head says the agent waits for the user ("Needs you") instead of
 * "Working…". By the pane's status, not by a parsed prompt: a blocked pane whose menu no reader
 * knows waits just the same, and a question in Codex's queue leaves Codex working.
 */
export function isWaitingWorkTurn(live: boolean, status?: string): boolean {
  return live && status === "blocked";
}
