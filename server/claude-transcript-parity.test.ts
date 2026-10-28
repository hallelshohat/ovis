import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { parseClaudeTranscript } from "./claude-transcript.ts";
import { turnSegments } from "../src/lib/workBlocks.ts";

// One real Claude Code 2.1.310 exchange (text redacted): each content block of one API message is
// its own entry under one message id, and the request blobs, hooks and turn bookkeeping between
// them are noise the chat must skip.
const fixture = readFileSync(new URL("./claude-transcript-parity.fixture.jsonl", import.meta.url), "utf8");

it("draws a real exchange in the terminal's order: every text and tool once, where it was written", () => {
  const turns = parseClaudeTranscript(fixture);
  expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  const segments = turnSegments(turns[1]!.parts).map((segment) => segment.kind === "text"
    ? segment.part.text
    : segment.parts.map((part) => part.kind === "tool" ? `${JSON.parse(part.input).command} -> ${part.output}` : `${part.kind}: ${part.kind === "thinking" ? part.text : ""}`));
  expect(segments).toEqual([
    ["thinking: thinking 1"],
    "text 1",
    ["echo tool 1 -> out 1"],
    "text 2",
    ["echo tool 2 -> out 2"],
    "text 3",
  ]);
  expect(JSON.stringify(turns)).not.toContain("request body");
});
