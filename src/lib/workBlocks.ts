import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
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

/**
 * A turn the way the terminal draws it: in the order it was written. Each piece of the agent's
 * prose stands where it was said, and the actions between two of them (tool calls, reasoning,
 * skills) are one run, folded as one block. Blank prose splits nothing.
 */
export type TurnSegment = { kind: "text"; part: TextPart } | { kind: "actions"; parts: ConversationPart[] };

export function turnSegments(parts: ConversationPart[]): TurnSegment[] {
  const segments: TurnSegment[] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      if (part.text.trim().length > 0) segments.push({ kind: "text", part });
      continue;
    }
    const last = segments.at(-1);
    if (last?.kind === "actions") last.parts.push(part);
    else segments.push({ kind: "actions", parts: [part] });
  }
  return segments;
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

/**
 * The end of the pane's screen as a running command's live output: the transcripts record a call's
 * output only once it ends, so while it runs the terminal is the only place it is. The agent's own
 * input box under it is not output: Claude Code draws it between two rules, so the screen is cut at
 * the first rule near the bottom. A screen with no rule keeps its last lines.
 */
export function liveOutputTail(screen: string, maxLines = 12): string {
  const lines = screen.split("\n");
  const bottom = Math.max(0, lines.length - 15);
  const rule = lines.findIndex((line, index) => index >= bottom && /^[─━]{20,}/.test(line));
  const kept = rule === -1 ? lines : lines.slice(0, rule);
  while (kept.length > 0 && kept.at(-1)!.trim().length === 0) kept.pop();
  return kept.slice(-maxLines).join("\n");
}

/**
 * end_ts is the latest activity time, not proof that an approval-blocked turn finished.
 *
 * `sentOver` is the assistant turn that was last when a message was sent. The pushed status turns
 * `working` before the transcript holds the new user message, so until it does, that finished turn
 * is still the last one and must not be titled as if it were the one running. The turn itself, not
 * its time: a turn may have no `ts`, and the browser's clock and the transcript's need not agree.
 */
export function isLiveWorkTurn(turn: ConversationTurn, last: boolean, status?: string, sentOver?: ConversationTurn | null): boolean {
  if (turn === sentOver) return false;
  return last && turn.role === "assistant" && (status === "working" || status === "blocked");
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
