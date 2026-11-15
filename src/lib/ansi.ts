/**
 * A command's output as the terminal draws it: SGR colours and styles (`ESC[…m`) become styled
 * spans, a carriage return within a line starts the line over (a progress bar keeps its last
 * frame), a backspace takes back a character, and every other escape (cursor moves, erases, OSC
 * titles and links, charset picks) is dropped. The 16 basic colours are the theme's terminal
 * colours (`ansi-fg-N` / `ansi-bg-N` classes in BackgroundTaskOutput.css); the 256-colour cube and
 * 24-bit colours are given as `rgb()`.
 */

export interface AnsiStyle {
  /** 0–15 for a palette colour, or an `rgb()` value */
  fg?: number | string;
  bg?: number | string;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  inverse?: true;
}

export interface AnsiSpan extends AnsiStyle { text: string }

// CSI … final byte, OSC … BEL/ST, a two-byte escape, or a lone ESC
const ESCAPE = /\x1b\[([0-9;:?]*)([\x40-\x7e])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][\x20-\x7e]?|\x1b[\x20-\x7e]?/g;

const CUBE = [0, 95, 135, 175, 215, 255];
function color256(n: number): number | string {
  if (n < 16) return n;
  if (n >= 232) { const grey = 8 + (n - 232) * 10; return `rgb(${grey}, ${grey}, ${grey})`; }
  const i = n - 16;
  return `rgb(${CUBE[Math.floor(i / 36)]}, ${CUBE[Math.floor(i / 6) % 6]}, ${CUBE[i % 6]})`;
}

/** Apply one SGR parameter list to `style`. */
function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((code) => code === "" ? 0 : Number(code));
  const next: AnsiStyle = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code === 0) { for (const key of Object.keys(next)) delete next[key as keyof AnsiStyle]; }
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) { delete next.bold; delete next.dim; }
    else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
    else if (code === 49) delete next.bg;
    else if (code === 38 || code === 48) {
      const key = code === 38 ? "fg" : "bg";
      if (codes[i + 1] === 5 && codes[i + 2] !== undefined) { next[key] = color256(codes[i + 2]!); i += 2; }
      else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) { next[key] = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`; i += 4; }
    }
  }
  return next;
}

const same = (a: AnsiStyle, b: AnsiStyle): boolean =>
  a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse;

/**
 * The text as lines of styled spans. `start` is the style in force where the text begins (the end
 * style of the text before it), so a long output can be drawn in parts; `end` is the style after it.
 */
export function ansiLines(text: string, start: AnsiStyle = {}): { lines: AnsiSpan[][]; end: AnsiStyle } {
  let style = start;
  const lines: AnsiSpan[][] = [];
  let line: AnsiSpan[] = [];
  const push = (chunk: string): void => {
    if (chunk === "") return;
    const last = line.at(-1);
    if (last !== undefined && same(last, style)) last.text += chunk;
    else line.push({ ...style, text: chunk });
  };
  const plain = (chunk: string): void => {
    let from = 0;
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i]!;
      if (char === "\n") { push(chunk.slice(from, i)); lines.push(line); line = []; from = i + 1; }
      // a carriage return not followed by a newline starts the line over
      else if (char === "\r") { push(chunk.slice(from, i)); if (chunk[i + 1] !== "\n") line = []; from = i + 1; }
      else if (char === "\b") {
        push(chunk.slice(from, i));
        const last = line.at(-1);
        if (last !== undefined) { last.text = last.text.slice(0, -1); if (last.text === "") line.pop(); }
        from = i + 1;
      }
    }
    push(chunk.slice(from));
  };
  let at = 0;
  for (const match of text.matchAll(ESCAPE)) {
    plain(text.slice(at, match.index));
    if (match[2] === "m") style = applySgr(style, match[1]!);
    at = match.index + match[0].length;
  }
  plain(text.slice(at));
  lines.push(line);
  return { lines, end: style };
}
