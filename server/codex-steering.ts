import { stripVTControlCharacters } from "node:util";

export interface CodexSteeringContext { agent: string | null; working: boolean; screen: string }
interface SteeringIO {
  read: () => Promise<CodexSteeringContext>;
  /** sends Escape; `fresh` is asked again when herdr is reached, and a stale write is withheld */
  escape: (fresh: () => boolean) => Promise<void>;
  restarting: () => void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

const STEERING_HINT = "Messages to be submitted after next tool call (press esc to interrupt and send immediately)";
const compact = (text: string) => text.replace(/\s/g, "");
function lastLine<T>(lines: T[], matches: (line: T) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index--) if (matches(lines[index]!)) return index;
  return -1;
}
/** The rows under the composer: the model and folder (with `fast` after the effort in Fast mode), context left, warnings, and (0.162) the shortcuts hint. */
export const FOOTER = /^(?:\S+(?:[ \t]+\S+){0,3}[ \t]+(?:default|minimal|none|low|medium|high|xhigh|max|ultra)(?:[ \t]+[Ff]ast)?[ \t]*·|\d+% context left\b|⚠\s*\d+\s*warnings?\b|(?:←[^·]*·\s*)?\?\s*for shortcuts\b|[/\\]|[A-Za-z]:\\)/;

const CODEX_WORKING = /^[•◦]\s*(?:Working|Waiting for background terminal|Reconnecting(?:\.{3}|…)?(?: waiting for network)?)\s*\((?:\d+[hms]\s*)+•\s*esc to interrupt\)(.*)$/;

function workingLine(line: string): boolean {
  const found = CODEX_WORKING.exec(line);
  if (!found) return false;
  const suffix = found[1]!.trim();
  if (!suffix) return true;
  const count = /^· (\d+) background/.exec(suffix)?.[1];
  if (!count) return false;
  const full = `· ${count} background terminal${count === "1" ? "" : "s"} running · /ps to view · /stop to close`;
  return suffix.endsWith("…") ? full.startsWith(suffix.slice(0, -1).trimEnd()) : suffix === full;
}

/** Only the bottom composer with a Codex footer identifies a live input panel. */
export function codexComposer(screen: string): { rows: { indent: number; text: string }[]; composer: number; status: number; footer: string[] } | null {
  const rows = stripVTControlCharacters(screen).split(/\r?\n/).map((raw) => {
    const line = raw.replace(/^│/, "").replace(/\s*│\s*$/, "").trimEnd();
    return { indent: line.length - line.trimStart().length, text: line.trim() };
  }).filter((row) => row.text);
  // A resize can reflow the tail of a previously drawn status; join only an exact known suffix.
  for (let index = 0; index + 1 < rows.length; index++) {
    const row = rows[index]!;
    if (!CODEX_WORKING.test(row.text) || workingLine(row.text)) continue;
    const joined = [row.text + rows[index + 1]!.text, `${row.text} ${rows[index + 1]!.text}`].find(workingLine);
    if (joined) { row.text = joined; rows.splice(index + 1, 1); }
  }
  const lines = rows.map((row) => row.text);
  const composer = lastLine(lines, (line) => /^[›»](?:\s+Ask Codex to do anything)?$/.test(line));
  if (composer < 0) return null;
  const footer = lines.slice(composer + 1);
  if (footer.length === 0 || footer.length > 4 || footer.some((line) => !FOOTER.test(line))) return null;
  let status = lastLine(lines.slice(0, composer), workingLine);
  if (lines.slice(status + 1, composer).some((line) => /^[›»]/.test(line)
    || (/^[•◦]/.test(line) && !/^[•◦]\s*(?:Messages to be submitted|Queued follow-up inputs)/.test(line)))) status = -1;
  return { rows, composer, status, footer };
}

/**
 * A native steering panel in the live composer, never a hint quoted in scrollback, whose last
 * entry is `text`: the message just submitted, not one that was already waiting. Codex wraps an
 * entry over indented rows and cuts a long one with a "…" row, so the entry is compared without
 * whitespace, and as the start of `text` when it was cut.
 */
export function codexSteeringPending(screen: string, text: string): boolean {
  const live = codexComposer(screen);
  if (!live) return false;
  const { rows, composer, status } = live;
  if (status < 0) return false;
  const panel = rows.slice(status + 1, composer);
  const isEntry = (row: { text: string }) => /^↳\s*\S/.test(row.text);
  const first = panel.findIndex(isEntry);
  if (first < 1) return false;
  if (compact(panel.slice(0, first).map((row) => row.text).join("").replace(/^[•◦]\s*/, "")) !== compact(STEERING_HINT)) return false;
  // the steering section ends at the next header: Codex lists end-of-turn and rejected inputs under their own
  const next = panel.findIndex((row, index) => index > first && /^[•◦]/.test(row.text));
  const section = panel.slice(first, next < 0 ? panel.length : next);
  // an entry starts at the arrows' indent; a deeper arrow is the message's own text on a continuation row
  const indent = section[0]!.indent;
  const entry = section.slice(lastLine(section, (row) => row.indent === indent && isEntry(row)));
  // Codex cuts a long entry with a "…" row of its own; an ellipsis ending a text row is the message's
  const cut = entry.length > 1 && entry[entry.length - 1]!.text === "…";
  const shown = compact((cut ? entry.slice(0, -1) : entry).map((row) => row.text).join("").replace(/^↳/, ""));
  const sent = compact(text);
  if (!sent || !shown) return false;
  return cut ? sent.startsWith(shown) : shown === sent;
}

/** Enter can leave steering pending until a tool boundary. Only Send now may interrupt it, and only for `text`. */
export async function interruptCodexSteering(explicit: boolean, text: string, submitted: CodexSteeringContext, io: SteeringIO): Promise<void> {
  if (!explicit || submitted.agent !== "codex" || !submitted.working) return;
  const now = io.now ?? Date.now;
  const wait = io.wait ?? Bun.sleep;
  const deadline = now() + 1500;
  const unconfirmed = () => new Error("Codex immediate delivery was not confirmed. Check the terminal before sending again.");
  while (now() < deadline) {
    // The caller rechecks live identity, lease, authority and interactive prompts in this read.
    const current = await io.read();
    if (now() >= deadline || current.agent !== "codex") throw unconfirmed();
    if (!current.working) return;
    if (codexSteeringPending(current.screen, text)) {
      io.restarting();
      // the RPC's connect is awaited: by the time herdr is written to, the deadline may have passed
      await io.escape(() => now() < deadline);
      return;
    }
    await wait(Math.min(50, deadline - now()));
  }
  throw unconfirmed();
}
