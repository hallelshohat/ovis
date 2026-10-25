export type DiffSide = "old" | "new";
export type DiffLineKind = "context" | "addition" | "deletion";

export interface DiffFindLine {
  side: DiffSide;
  line: number;
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffFindMatch extends DiffFindLine {
  start: number;
  end: number;
}

export const DIFF_FIND_MAX_QUERY = 1024;

export function matchKey(match: Pick<DiffFindMatch, "side" | "line" | "start">): string {
  return `${match.side}:${match.line}:${match.start}`;
}

/**
 * File headers, hunk headers, the lines between hunks and git's
 * `\ No newline at end of file` marker are left out; a hunk ends when its counts are used up.
 */
export function diffFindLines(patch: string | null): DiffFindLine[] {
  if (patch === null) return [];
  const lines: DiffFindLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of patch.split("\n")) {
    if (oldLeft <= 0 && newLeft <= 0) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (header === null) continue;
      oldLine = Number(header[1]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLine = Number(header[3]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      // an empty side starts before its first line (`-0,0`): its next line is 1
      if (oldLeft === 0) oldLine += 1;
      if (newLeft === 0) newLine += 1;
      continue;
    }
    if (raw.startsWith("\\")) continue;
    const mark = raw[0];
    const text = raw.slice(1).replace(/\r$/, "");
    if (mark === "+") {
      lines.push({ side: "new", line: newLine, kind: "addition", oldLine: null, newLine, text });
      newLine += 1; newLeft -= 1;
    } else if (mark === "-") {
      lines.push({ side: "old", line: oldLine, kind: "deletion", oldLine, newLine: null, text });
      oldLine += 1; oldLeft -= 1;
    } else if (mark === " " || raw === "") {
      // a blank unchanged line some tools print without its space
      lines.push({ side: "new", line: newLine, kind: "context", oldLine, newLine, text });
      oldLine += 1; newLine += 1; oldLeft -= 1; newLeft -= 1;
    }
  }
  return lines;
}

export function findInDiff(lines: readonly DiffFindLine[], query: string): DiffFindMatch[] {
  const needle = query.slice(0, DIFF_FIND_MAX_QUERY);
  if (needle === "") return [];
  const matches: DiffFindMatch[] = [];
  for (const line of lines) {
    let from = 0;
    for (;;) {
      const start = line.text.indexOf(needle, from);
      if (start < 0) break;
      matches.push({ ...line, start, end: start + needle.length });
      from = start + needle.length;
    }
  }
  return matches;
}

export function stepMatch(index: number | null, total: number, direction: 1 | -1): number | null {
  if (total === 0) return null;
  if (index === null) return direction === 1 ? 0 : total - 1;
  return (index + direction + total) % total;
}

/**
 * The first line of each change, as VS Code's diff counts them: a run of removed and added lines
 * with no unchanged line between them is one change. Hunks are always split by unchanged lines,
 * so a run never spans two.
 */
export function diffChanges(lines: readonly DiffFindLine[]): DiffFindLine[] {
  return lines.filter((line, index) => line.kind !== "context" && (index === 0 || lines[index - 1]!.kind === "context"));
}

/**
 * Whether both whole sides of a file are the ones a patch was read from: the patch applied to the
 * old side gives the new side exactly, every line between and around its hunks included. A file
 * changed since the patch was read (an edit inside or outside a hunk, a line added above or
 * appended below) fails, and is never mixed into the patch's rows. Line endings are compared
 * without their carriage return, and a final newline the sides differ in alone is no change.
 */
export function contentsMatchPatch(lines: readonly DiffFindLine[], old: string, next: string): boolean {
  const split = (text: string): string[] => {
    const parts = text.split("\n").map((line) => line.replace(/\r$/, ""));
    if (parts.at(-1) === "") parts.pop();
    return parts;
  };
  const oldLines = split(old);
  const newLines = split(next);
  const rebuilt: string[] = [];
  // the next old line not yet copied, 1-based
  let at = 1;
  for (const line of lines) {
    // the unchanged lines before this one are the old side's, copied as they are
    const until = line.oldLine ?? at + (line.newLine! - 1 - rebuilt.length);
    while (at < until) {
      if (at > oldLines.length) return false;
      rebuilt.push(oldLines[at - 1]!);
      at += 1;
    }
    if (line.oldLine !== null) {
      if (oldLines[at - 1] !== line.text) return false;
      at += 1;
    }
    if (line.newLine !== null) {
      if (rebuilt.length + 1 !== line.newLine) return false;
      rebuilt.push(line.text);
    }
  }
  while (at <= oldLines.length) { rebuilt.push(oldLines[at - 1]!); at += 1; }
  return rebuilt.length === newLines.length && rebuilt.every((line, index) => line === newLines[index]);
}
