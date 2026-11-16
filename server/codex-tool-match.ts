import { z } from "zod";
import { codexNativeItem } from "./codex-items.ts";
import { codexComposer } from "./codex-steering.ts";
import { isCodexHistoryCurrent, scanCodexHistory, type CodexHistoryScan, type CodexHistorySpan } from "./codex-history-scan.ts";
import type { HistorySegment } from "./codex.ts";
import { deepStrings } from "../shared/json-text.ts";
import { ENTITY, ENTITY_STEPS, throughEntities } from "../shared/entity-text.ts";

/** Completed native calls can identify a tool-only viewport; raw quoted tool text cannot. */
export function matchCodexToolActivity({ screen, candidates }: {
  screen: string; candidates: readonly { path: string; text: string }[];
}): string | null {
  const shown = toolPreviews(screen);
  if (shown.length < MIN_PAIRS) return null;
  const readings = candidates.map(({ path, text }) => ({ path, evidence: readEvidence({ text, shown }) }));
  return toolOwner({ readings, shown });
}

/** Reuse each loaded history's index when new tools replace the previous viewport. */
export async function matchCodexToolHistories({ screen, candidates }: {
  screen: string; candidates: readonly { path: string; segments: readonly HistorySegment[] }[];
}): Promise<string | null> {
  const shown = toolPreviews(screen);
  if (shown.length < MIN_PAIRS) return null;
  const readings = await Promise.all(candidates.map(async ({ path, segments }) => ({ path, evidence: await toolHistoryEvidence({ shown, segments }) })));
  return toolOwner({ readings, shown });
}

function toolOwner({ readings, shown }: { readings: readonly { path: string; evidence: Evidence | null }[]; shown: readonly Preview[] }): string | null {
  const owners = readings.filter(({ evidence }) => evidence !== null && evidence.matches.size === shown.length);
  if (owners.length !== 1) return null;
  const owner = owners[0]!;
  return readings.some(({ path, evidence }) => evidence === null || path !== owner.path
    && (evidence.quoted.size === shown.length || hasPending({ pending: evidence.pending, shown }))) ? null : owner.path;
}

export const hasCodexToolActivity = (screen: string): boolean => toolPreviews(screen).length >= MIN_PAIRS;

/** Check complete competing histories: a matching command or quote may precede the tail window. */
export async function codexToolActivityConflict({ screen, segments }: { screen: string; segments: readonly HistorySegment[] }): Promise<boolean> {
  const shown = toolPreviews(screen);
  if (shown.length < MIN_PAIRS) return true;
  const evidence = await toolHistoryEvidence({ shown, segments });
  return evidence === null || evidence.quoted.size === shown.length || hasPending({ pending: evidence.pending, shown });
}

async function toolHistoryEvidence({ shown, segments }: { shown: readonly Preview[]; segments: readonly HistorySegment[] }): Promise<Evidence | null> {
  const indexed = await scanCodexHistory({ key: "tool-index", segments, cache: indexes, initial: newToolIndex,
    each: (index, line, span) => indexToolLine({ index, line, span }) });
  if (indexed === null) return null;
  const selected = toolSpans({ index: indexed.value, shown, paths: segments.map(({ path }) => path) });
  if (selected.length === 0) return await isCodexHistoryCurrent(indexed) ? { ...newEvidence(), pending: indexed.value.pending } : null;
  const key = JSON.stringify(shown);
  const cache = conflicts.get(key) ?? new Map<string, CodexHistoryScan<Evidence>>();
  conflicts.delete(key);
  conflicts.set(key, cache);
  if (conflicts.size > KEPT_SCREENS) conflicts.delete(conflicts.keys().next().value!);
  const identities = new Map(indexed.files.map((file) => [file.path, file.stat]));
  const scan = await scanCodexHistory({ key: "tool-activity", segments: selected.map((span) => ({ ...span, identity: identities.get(span.path)! })), cache, initial: newEvidence,
    each: (evidence, line) => weighLine({ line, shown, evidence }) });
  if (scan === null || !await isCodexHistoryCurrent(indexed)) return null;
  // Selected quote records may omit completions; pending calls come from the whole prefix.
  return { ...scan.value, pending: indexed.value.pending };
}

const indexes = new Map<string, CodexHistoryScan<ToolHistoryIndex>>();
// Each screen must retain its peers' progress while other screens are recovering.
const conflicts = new Map<string, Map<string, CodexHistoryScan<Evidence>>>();
const KEPT_SCREENS = 64;

const MIN_PAIRS = 2;
const MIN_OUTPUT = 64;
const MIN_DISTINCT = 12;
const compact = (text: string) => text.replace(/\s+/g, "");
const letters = (text: string) => text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");
type Preview = { command: string; clipped: boolean; output: string; words: string[] };
const newEvidence = () => ({ matches: new Set<number>(), calls: new Set<string>(), quoted: new Set<number>(), pending: new Map<string, PendingCall[]>() });
type Evidence = ReturnType<typeof newEvidence>;
type PendingCall = { command: string; native: boolean };
interface ToolHistoryIndex { commands: Map<string, CodexHistorySpan[]>; quotes: CodexHistorySpan[]; pending: Map<string, PendingCall[]> }
const newToolIndex = (): ToolHistoryIndex => ({ commands: new Map(), quotes: [], pending: new Map() });

function indexToolLine({ index, line, span }: { index: ToolHistoryIndex; line: string; span: CodexHistorySpan }): boolean {
  const read = readToolLine(line);
  if (read === null) return false;
  const { part, strings, completed } = read;
  // An entity can stand for the letters in "Ran"; keep its record for the exact comparison too.
  if (strings.some((text) => letters(text).includes("Ran") || text.includes("&"))) index.quotes.push(span);
  if (part?.kind === "tool" && part.name === "exec_command" && completed) {
    const command = compact(part.summary), spans = index.commands.get(command) ?? [];
    spans.push(span);
    index.commands.set(command, spans);
  }
  updatePendingCalls({ pending: index.pending, read });
  return true;
}

function updatePendingCalls({ pending, read }: { pending: Map<string, PendingCall[]>; read: NonNullable<ReturnType<typeof readToolLine>> }): void {
  const { payload, part, native, strings } = read;
  if (part?.kind === "tool" && part.name === "exec_command") {
    pending.delete(native!.id);
    if (part.state === "pending") pending.set(native!.id, [{ command: part.summary, native: true }]);
  }
  const call = payload["call_id"];
  if (read.entry.type === "response_item" && typeof call === "string") {
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") pending.delete(call);
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      pending.set(call, [...pending.get(call) ?? [], ...strings.map((command) => ({ command: compact(command), native: false }))]);
    }
  }
}

function hasPending({ pending, shown }: { pending: Map<string, PendingCall[]>; shown: readonly Preview[] }): boolean {
  return [...pending.values()].some((calls) => calls.some((call) => shown.some((preview) =>
    call.native ? commandMatches({ preview, command: call.command }) : call.command.includes(preview.command))));
}

function toolSpans({ index, shown, paths }: { index: ToolHistoryIndex; shown: readonly Preview[]; paths: readonly string[] }): CodexHistorySpan[] {
  const selected = [...index.quotes];
  for (const [command, spans] of index.commands) {
    if (shown.some((preview) => commandMatches({ command, preview }))) selected.push(...spans);
  }
  return [...new Map(selected.map((span) => [`${span.path}\0${span.start}`, span])).values()]
    .sort((left, right) => paths.indexOf(left.path) - paths.indexOf(right.path) || left.start - right.start);
}

function toolPreviews(screen: string): Preview[] {
  const live = codexComposer(screen.slice(Math.max(0, screen.lastIndexOf("OpenAI Codex (v"))));
  if (live === null) return [];
  const rows = live.rows.slice(0, live.status < 0 ? live.composer : live.status);
  const previews: Preview[] = [];
  for (let at = 0; at + 1 < rows.length; at++) {
    const row = rows[at]!, next = rows[at + 1]!;
    if (row.indent !== 0 || !row.text.startsWith("• Ran ") || next.indent !== 2 || !next.text.startsWith("└ ")) continue;
    const command = row.text.slice("• Ran ".length);
    const output = [next.text.slice(2)];
    for (let end = at + 2; end < rows.length && rows[end]!.indent >= 4; end++) {
      const text = rows[end]!.text;
      if (output.at(-1)!.endsWith("…") || /^(?:…|\.\.\.)|^\+ (?:\d+ lines\b|Show details\b)/.test(text)) break;
      output.push(text);
    }
    const visible = output.join("\n").replace(/…$/, "");
    const substantial = letters(visible);
    if (substantial.length < MIN_OUTPUT || new Set(substantial).size < MIN_DISTINCT) continue;
    const words = [...new Set(visible.normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean))].sort((a, b) => b.length - a.length);
    previews.push({ command: compact(command.replace(/…$/, "")), clipped: command.endsWith("…"), output: compact(visible), words });
  }
  return [...new Map(previews.map((preview) => [`${preview.command}\0${preview.output}`, preview])).values()];
}

function readEvidence({ text, shown }: { text: string; shown: readonly Preview[] }): Evidence | null {
  const evidence = newEvidence();
  for (const line of text.split("\n")) if (!weighLine({ line, shown, evidence })) return null;
  return evidence;
}

const envelope = z.object({ type: z.string(), payload: z.looseObject({ type: z.string().optional() }) });
const commandEnvelope = z.looseObject({ type: z.literal("CommandExecution") });

function weighLine({ line, shown, evidence }: { line: string; shown: readonly Preview[]; evidence: Evidence }): boolean {
  if (!line.trim()) return true;
  const read = readToolLine(line);
  if (read === null) return false;
  const { strings } = read;
  shown.forEach((preview, index) => {
    if (!evidence.quoted.has(index) && strings.some((text) => mayQuoteOutput({ text, shown: [preview] }))) evidence.quoted.add(index);
  });
  updatePendingCalls({ pending: evidence.pending, read });
  weighToolCalls({ read, shown, evidence });
  return true;
}

function readToolLine(line: string) {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  const parsed = envelope.safeParse(value);
  if (!parsed.success) return null;
  const entry = parsed.data, payload = entry.payload;
  const strings = deepStrings(payload);
  const native = entry.type === "event_msg" ? codexNativeItem(payload["item"])?.display : null;
  const part = native?.part;
  const command = entry.type === "event_msg" ? commandEnvelope.safeParse(payload["item"]) : null;
  if (command?.success && (native == null || payload.type === "item_completed" && command.data["aggregated_output"] === undefined)) return null;
  const completed = payload.type === "item_completed" && part?.kind === "tool" && (part.state === "ok" || part.state === "error");
  return { entry, payload, native, part, strings, completed };
}

function weighToolCalls({ read, shown, evidence }: { read: NonNullable<ReturnType<typeof readToolLine>>;
  shown: readonly Preview[]; evidence: Evidence;
}): void {
  const { native, part, completed } = read;
  if (part?.kind === "tool" && part.name === "exec_command") {
    shown.forEach((preview, index) => {
      if (!commandMatches({ preview, command: part.summary })) return;
      if (completed && compact(part.output).includes(preview.output)) {
        evidence.quoted.add(index);
        if (index === evidence.matches.size && !evidence.calls.has(native!.id)) {
          evidence.matches.add(index);
          evidence.calls.add(native!.id);
        }
      }
    });
  }
}

function commandMatches({ preview, command }: { preview: Preview; command: string }): boolean {
  const actual = compact(command);
  return preview.command !== "" && (preview.clipped ? actual.startsWith(preview.command) : actual === preview.command);
}

function mayQuoteOutput({ text, shown }: { text: string; shown: readonly Preview[] }): boolean {
  const plain = letters(text);
  if (shown.some((preview) => plain.includes(`Ran${letters(preview.command)}`) && plain.includes(letters(preview.output)))) return true;
  const pieces = text.split(/&(?:#\d+|#[xX][\da-fA-F]+|[A-Za-z][A-Za-z0-9]+);/);
  if (pieces.length === 1) return false;
  // Reuse the message matcher's bounded entity comparison for Markdown quoting tool rows.
  const encoded = pieces.map(letters).join(ENTITY), steps = { left: ENTITY_STEPS };
  return shown.some((preview) => [`Ran${letters(preview.command)}`, ...preview.words]
    .every((word) => encoded.includes(word) || throughEntities({ text: encoded, word, steps })));
}
