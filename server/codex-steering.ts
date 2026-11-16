import { stripVTControlCharacters } from "node:util";

const STEERING_HINT = "Messages to be submitted after next tool call (press esc to interrupt and send immediately)";
const MAX_FOOTER_ROWS = 4;
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
export function codexComposer(screen: string): { rows: { indent: number; text: string }[]; composer: number; empty: boolean; status: number; footer: string[] } | null {
  const drawn = stripVTControlCharacters(screen).split(/\r?\n/).map((raw) => {
    const line = raw.replace(/^│/, "").replace(/\s*│\s*$/, "").trimEnd();
    return { indent: line.length - line.trimStart().length, text: line.trim() };
  });
  const rows = drawn.filter((row) => row.text);
  // A resize can reflow the tail of a previously drawn status; join only an exact known suffix.
  for (let index = 0; index + 1 < rows.length; index++) {
    const row = rows[index]!;
    if (!CODEX_WORKING.test(row.text) || workingLine(row.text)) continue;
    const joined = [row.text + rows[index + 1]!.text, `${row.text} ${rows[index + 1]!.text}`].find(workingLine);
    if (joined) { row.text = joined; rows.splice(index + 1, 1); }
  }
  const lines = rows.map((row) => row.text);
  const promptRow = (row: { text: string }) => /^[›»](?:\s|$)/.test(row.text);
  const column = Math.min(...rows.filter(promptRow).map((row) => row.indent));
  const composer = lastLine(rows, (row) => row.indent === column && promptRow(row));
  if (composer < 0) return null;
  let footerStart = lines.length;
  while (footerStart > composer + 1 && FOOTER.test(lines[footerStart - 1]!)) footerStart--;
  // A reflowed thread title continues the footer's first row, after the blank separating it from input.
  const wrappedStart = rows.findIndex((row, index) => index > composer && FOOTER.test(row.text) && drawn[drawn.indexOf(row) - 1]?.text === "");
  const wrapped = wrappedStart < 0 ? [] : rows.slice(wrappedStart);
  if (wrapped.length > 0 && wrapped.length <= MAX_FOOTER_ROWS && wrapped.every((row, index) => FOOTER.test(row.text)
    || (index > 0 && row.indent > column && row.indent === wrapped[0]!.indent && drawn[drawn.indexOf(row) - 1]?.text
      && wrapped.slice(1, index).every((previous) => !FOOTER.test(previous.text))))) footerStart = wrappedStart;
  const footer = lines.slice(footerStart);
  if (footer.length === 0 || footer.length > MAX_FOOTER_ROWS) return null;
  if (rows.slice(composer + 1, footerStart).some((row) => row.indent <= column)) return null;
  const empty = footerStart === composer + 1 && /^[›»](?:\s+Ask Codex to do anything)?$/.test(lines[composer]!);
  let status = lastLine(lines.slice(0, composer), workingLine);
  if (status >= 0 && rows.slice(status + 1, composer).some((row) => row.indent <= rows[status]!.indent && (/^[›»]/.test(row.text)
    || (/^[•◦]/.test(row.text) && !/^[•◦]\s*(?:Messages to be submitted|Queued follow-up inputs)/.test(row.text))))) status = -1;
  return { rows, composer, empty, status, footer };
}

/**
 * A native steering panel in the live composer, never a hint quoted in scrollback, whose last
 * entry is `text`: the message just submitted, not one that was already waiting. Codex wraps an
 * entry over indented rows and cuts a long one with a "…" row, so the entry is compared without
 * whitespace, and as the start of `text` when it was cut.
 */
export function codexSteeringPending(screen: string, text: string): boolean {
  const live = codexComposer(screen);
  if (!live?.empty) return false;
  const { rows, composer, status } = live;
  if (status < 0) return false;
  const start = rows.findIndex((row, index) => index > status && index < composer && row.indent === rows[status]!.indent && /^[•◦]/.test(row.text));
  if (start < 0) return false;
  const panel = rows.slice(start, composer);
  const isEntry = (row: { text: string }) => /^↳\s*\S/.test(row.text);
  const first = panel.findIndex(isEntry);
  if (first < 1) return false;
  if (compact(panel.slice(0, first).map((row) => row.text).join("").replace(/^[•◦]\s*/, "")) !== compact(STEERING_HINT)) return false;
  // the steering section ends at the next header: Codex lists end-of-turn and rejected inputs under their own
  const next = panel.findIndex((row, index) => index > first && row.indent < panel[first]!.indent && /^[•◦]/.test(row.text));
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
