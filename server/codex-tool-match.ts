import { createReadStream, closeSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { codexNativeItem } from "./codex-items.ts";
import { codexComposer } from "./codex-steering.ts";
import { openBound, readBound } from "./conversation-shared.ts";
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
  const owners = readings.filter(({ evidence }) => evidence !== null && evidence.matches.size === shown.length);
  if (owners.length !== 1) return null;
  const owner = owners[0]!;
  return readings.some(({ path, evidence }) => evidence === null || path !== owner.path && (evidence.quoted.size === shown.length || evidence.pending.size > 0)) ? null : owner.path;
}

export const hasCodexToolActivity = (screen: string): boolean => toolPreviews(screen).length >= MIN_PAIRS;

/** Check complete competing histories: a matching command or quote may precede the tail window. */
export async function codexToolActivityConflict({ screen, segments }: { screen: string; segments: readonly HistorySegment[] }): Promise<boolean> {
  const shown = toolPreviews(screen);
  if (shown.length < MIN_PAIRS) return true;
  try {
    const stamp = historyStamp(segments), key = `${Bun.hash(JSON.stringify(shown))}:${stamp}`;
    const known = conflicts.get(key);
    if (known !== undefined) return known;
    const conflict = await scanConflict({ shown, segments });
    if (historyStamp(segments) !== stamp) return true;
    conflicts.set(key, conflict);
    if (conflicts.size > MAX_CONFLICT_READS) conflicts.delete(conflicts.keys().next().value!);
    return conflict;
  } catch { return true; }
}

const MAX_CONFLICT_READS = 64;
const conflicts = new Map<string, boolean>();

function historyStamp(segments: readonly HistorySegment[]): string {
  return segments.map(({ path, end, identity }) => {
    const now = statSync(path);
    return `${path}:${end}:${identity?.dev}:${identity?.ino}:${now.dev}:${now.ino}:${now.size}:${now.mtimeMs}:${now.ctimeMs}`;
  }).join("\0");
}

async function scanConflict({ shown, segments }: { shown: readonly Preview[]; segments: readonly HistorySegment[] }): Promise<boolean> {
  const evidence = newEvidence();
  for (const segment of segments) {
    if (segment.end === 0) continue;
    let fd: number;
    try {
      const identity = segment.identity ?? statSync(segment.path);
      fd = readBound([[segment.path, identity]], () => openBound(segment.path));
    } catch { return true; }
    let stream: ReturnType<typeof createReadStream>;
    try { stream = createReadStream(segment.path, { fd, end: segment.end - 1, encoding: "utf8" }); }
    catch { closeSync(fd); return true; }
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!weighLine({ line, shown, evidence }) || evidence.quoted.size === shown.length) return true;
      }
    } catch { return true; }
    finally { lines.close(); stream.destroy(); }
  }
  return evidence.pending.size > 0;
}

const MIN_PAIRS = 2;
const MIN_OUTPUT = 64;
const MIN_DISTINCT = 12;
const compact = (text: string) => text.replace(/\s+/g, "");
const letters = (text: string) => text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");
type Preview = { command: string; clipped: boolean; output: string; words: string[] };
const newEvidence = () => ({ matches: new Set<number>(), calls: new Set<string>(), quoted: new Set<number>(), pending: new Set<string>() });
type Evidence = ReturnType<typeof newEvidence>;

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
  let value: unknown;
  try { value = JSON.parse(line); } catch { return false; }
  const parsed = envelope.safeParse(value);
  if (!parsed.success) return false;
  const entry = parsed.data, payload = entry.payload;
  const strings = deepStrings(payload);
  shown.forEach((preview, index) => {
    if (!evidence.quoted.has(index) && strings.some((text) => mayQuoteOutput({ text, shown: [preview] }))) evidence.quoted.add(index);
  });
  const native = entry.type === "event_msg" ? codexNativeItem(payload["item"])?.display : null;
  const part = native?.part;
  const command = entry.type === "event_msg" ? commandEnvelope.safeParse(payload["item"]) : null;
  if (command?.success && (native == null || payload.type === "item_completed" && command.data["aggregated_output"] === undefined)) return false;
  if (part?.kind === "tool" && part.name === "exec_command") {
    evidence.pending.delete(native!.id);
    shown.forEach((preview, index) => {
      if (!commandMatches({ preview, command: part.summary })) return;
      if (payload.type === "item_completed" && (part.state === "ok" || part.state === "error") && compact(part.output).includes(preview.output)) {
        evidence.quoted.add(index);
        if (index === evidence.matches.size && !evidence.calls.has(native!.id)) {
          evidence.matches.add(index);
          evidence.calls.add(native!.id);
        }
      }
      if (part.state === "pending") evidence.pending.add(native!.id);
    });
  }
  const call = payload["call_id"];
  if (entry.type === "response_item" && typeof call === "string") {
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") evidence.pending.delete(call);
    if ((payload.type === "function_call" || payload.type === "custom_tool_call")
      && strings.some((command) => shown.some((preview) => compact(command).includes(preview.command)))) evidence.pending.add(call);
  }
  return true;
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

