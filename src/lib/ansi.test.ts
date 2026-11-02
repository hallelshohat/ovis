import { describe, expect, it } from "bun:test";

import { ansiLines } from "./ansi.ts";

const lines = (text: string) => ansiLines(text).lines;

describe("ansiLines", () => {
  it("colours red text and resets after it", () => {
    expect(lines("a \x1b[31mred\x1b[0m b")).toEqual([[{ text: "a " }, { fg: 1, text: "red" }, { text: " b" }]]);
  });

  it("reads bright colours, bold and background together", () => {
    expect(lines("\x1b[1;92;44mok\x1b[22;39;49m")).toEqual([[{ bold: true, fg: 10, bg: 4, text: "ok" }]]);
  });

  it("reads 256-colour and 24-bit colours", () => {
    expect(lines("\x1b[38;5;196mx\x1b[48;2;1;2;3my")).toEqual([[{ fg: "rgb(255, 0, 0)", text: "x" }, { fg: "rgb(255, 0, 0)", bg: "rgb(1, 2, 3)", text: "y" }]]);
    expect(lines("\x1b[38;5;3mz")).toEqual([[{ fg: 3, text: "z" }]]);
  });

  it("drops OSC titles and links but keeps their text, and drops cursor moves", () => {
    expect(lines("\x1b]0;title\x07\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\\x1b[2K\x1b[1Gdone")).toEqual([[{ text: "linkdone" }]]);
  });

  it("keeps a progress bar's last frame", () => {
    expect(lines("10%\r50%\r100%\nnext\r\n")).toEqual([[{ text: "100%" }], [{ text: "next" }], []]);
  });

  it("carries a style across lines and from the text before", () => {
    const first = ansiLines("\x1b[33mone\ntwo");
    expect(first.lines).toEqual([[{ fg: 3, text: "one" }], [{ fg: 3, text: "two" }]]);
    expect(ansiLines("three\x1b[m", first.end).lines).toEqual([[{ fg: 3, text: "three" }]]);
  });

  it("takes back a character on backspace", () => {
    expect(lines("abc\bd")).toEqual([[{ text: "abd" }]]);
  });
});
