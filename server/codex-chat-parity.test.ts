import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodexTranscriptParser, parseCodexTranscript } from "./codex.ts";
import { codexNativeItem } from "./codex-items.ts";
import { codexToolImage, transcriptToolOutput } from "./conversation.ts";
import type { ConversationPart } from "../shared/protocol.ts";
import { parseConversationMetadata } from "./conversation-metadata.ts";
import { visibleWorkParts } from "../src/lib/workBlocks.ts";

// Recorded in an isolated Codex session on 2026-11-08. Paths are replaced; model context is removed.
const fixture = (version: string) => join(import.meta.dir, "fixtures/codex-chat-parity", `${version}.jsonl`);
const isNativeTool = (part: ConversationPart): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool" && part.native === true;

it("keeps the returned image and native action when a recorded exec also runs a command", async () => {
  const path = fixture("0.167.0-mixed-image");
  const text = readFileSync(path, "utf8");
  const visible = visibleWorkParts(parseCodexTranscript(text).flatMap((turn) => turn.parts), false);
  const images = visible.flatMap((part) => part.kind === "tool" ? part.images ?? [] : []);
  expect(images).toHaveLength(1);
  expect((await codexToolImage(path, images[0]!.ref, "/workspace/codex-parity"))?.mediaType).toBe("image/png");
  expect(visible.filter(isNativeTool).map((part) => part.name)).toEqual(["exec_command", "view_image"]);
  expect(visible.find((part) => part.kind === "tool" && part.name === "view_image")).toMatchObject({
    summary: "/workspace/codex-parity/probe.png", input: JSON.stringify({ path: "/workspace/codex-parity/probe.png" }),
  });
  expect(visible.some((part) => part.kind === "tool" && part.output === "IMAGE_COMMAND")).toBe(true);
});

it("keeps an image-only wrapper and incremental snapshots of the mixed image recording", () => {
  const lines = readFileSync(fixture("0.167.0-mixed-image"), "utf8").trimEnd().split("\n");
  const parser = createCodexTranscriptParser();
  for (const line of lines) {
    const before = parser.snapshot();
    const saved = JSON.stringify(before);
    parser.write(`${line}\n`);
    expect(JSON.stringify(before)).toBe(saved);
  }
  expect(parser.snapshot()).toEqual(parseCodexTranscript(lines.join("\n")));
  const imageOnly = lines.filter((line) => !line.includes('"type":"CommandExecution"')).join("\n");
  const visible = visibleWorkParts(parseCodexTranscript(imageOnly).flatMap((turn) => turn.parts), false);
  expect(visible.flatMap((part) => part.kind === "tool" ? part.images ?? [] : [])).toHaveLength(1);
  expect(visible.filter(isNativeTool).map((part) => part.name)).toEqual(["view_image"]);
});

it("pairs native image start/completion records and validates their required fields", () => {
  const item = { type: "ImageView", id: "image", path: "file:///C:/images/probe%20one.png" };
  const text = ["item_started", "item_completed"].map((type) => JSON.stringify({ type: "event_msg", payload: { type, item } })).join("\n");
  expect(parseCodexTranscript(text).flatMap((turn) => turn.parts)).toEqual([{
    kind: "tool", native: true, call_id: "image", name: "view_image", summary: "C:/images/probe one.png",
    input: JSON.stringify({ path: "C:/images/probe one.png" }), output: "", state: "ok",
  }]);
  expect(codexNativeItem({ ...item, path: 12 })).toBeNull();
  expect(codexNativeItem({ ...item, path: "" })).toBeNull();
});

describe.each(["0.166.0", "0.167.0"])("Codex %s terminal parity", (version) => {
  const text = readFileSync(fixture(version), "utf8");
  it("keeps reads, commands, command failures and file diffs as native display items", () => {
    const parts = parseCodexTranscript(text).flatMap((turn) => turn.parts);
    const tools = parts.filter(isNativeTool);
    expect(tools.some((part) => part.name === "read" && part.summary === "notes.txt" && part.output.includes("alpha=1"))).toBe(true);
    const failed = tools.find((part) => part.exit_code === (version === "0.166.0" ? 7 : 9));
    expect(failed).toMatchObject({ state: "error", error: true });
    expect(failed?.output).toContain("STDOUT");
    expect(failed?.output).toContain("STDERR");
    expect(tools.find((part) => part.name === "apply_patch")?.input).toContain(version === "0.166.0" ? "+beta=3" : "+gamma=4");
    expect(new Set(tools.map((part) => part.call_id)).size).toBe(tools.length);
    for (const tool of tools) expect(transcriptToolOutput("codex-transcript", fixture(version), tool.call_id!)).toBe(tool.output);
  });

  it("pairs native and model messages once and keeps steering inside the original task", () => {
    const turns = parseCodexTranscript(text);
    const steering = turns.findIndex((turn) => turn.input_kind === "steering");
    expect(steering).toBeGreaterThan(0);
    expect(turns[steering - 1]).toMatchObject({ native_turn_id: turns[steering]!.native_turn_id, turn_complete: false });
    expect(turns[steering + 1]?.native_turn_id).toBe(turns[steering]!.native_turn_id);
    expect(turns.filter((turn) => turn.role === "user" && turn.parts.some((part) => part.kind === "text" && part.text.startsWith(version === "0.166.0" ? "OVS24_STEER:" : "OVS24_CURRENT_STEER:")))).toHaveLength(1);
  });

  it("incremental appends match a whole read without mutating prior snapshots", () => {
    const parser = createCodexTranscriptParser();
    const lines = text.trimEnd().split("\n");
    for (let index = 0; index < lines.length; index++) {
      const before = parser.snapshot();
      const saved = JSON.stringify(before);
      parser.write(`${lines[index]}\n`);
      expect(JSON.stringify(before)).toBe(saved);
    }
    expect(parser.snapshot()).toEqual(parseCodexTranscript(text));
    const last = lines.pop()!;
    const partial = createCodexTranscriptParser();
    partial.write(`${lines.join("\n")}\n`);
    expect(partial.snapshot(last)).toEqual(parser.snapshot());
  });

  it("keeps the recorded token/context metadata", () => {
    const context = parseConversationMetadata(text, "codex-transcript").context;
    expect(context?.window).toBe(258400);
    expect(context?.used).toBeGreaterThan(0);
  });
});

it("pairs the recorded native plan with its model envelope exactly once", () => {
  const parts = parseCodexTranscript(readFileSync(fixture("0.167.0"), "utf8")).flatMap((turn) => turn.parts);
  expect(parts.filter((part) => part.kind === "text" && part.text.startsWith("## Two-step plan:"))).toHaveLength(1);
  expect(parts.some((part) => part.kind === "text" && part.text.includes("<proposed_plan>"))).toBe(false);
});

it("ignores malformed native items and private reasoning", () => {
  expect(codexNativeItem({ type: "CommandExecution", id: "bad", command: [3] })).toBeNull();
  expect(codexNativeItem({ type: "Reasoning", id: "r", summary_text: [], raw_content: ["PRIVATE"] })?.display?.part).toEqual({ kind: "thinking", native: true, text: "" });
});

it("keeps repeated identical steering sends while pairing all three recording sources", () => {
  const entries: { type: string; payload: unknown }[] = [{ type: "event_msg", payload: { type: "task_started", turn_id: "same-task" } }];
  for (const id of ["first", "second"]) {
    entries.push(
      { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id, content: [{ type: "text", text: "repeat" }] } } },
      { type: "event_msg", payload: { type: "user_message", message: "repeat" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "repeat" }] } },
    );
  }
  const turns = parseCodexTranscript(entries.map((entry) => JSON.stringify({ ...entry, timestamp: "2026-11-08T08:30:00Z" })).join("\n"));
  expect(turns).toHaveLength(2);
  expect(turns[1]).toMatchObject({ role: "user", native_turn_id: "same-task", input_kind: "steering" });
});

it("retrieves a native command's whole output when its timeline preview is cut", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-long-output-"));
  try {
    const output = "long command output\n".repeat(1000);
    const path = join(root, "rollout.jsonl");
    const text = JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: {
      type: "CommandExecution", id: "exec-long", command: ["sh", "-c", "cat large.txt"], cwd: "/project", parsed_cmd: [],
      status: "completed", aggregated_output: output, exit_code: 0,
    } } });
    writeFileSync(path, text);
    const tool = parseCodexTranscript(text)[0]?.parts.find(isNativeTool);
    expect(tool?.output_ref).toBe("exec-long");
    expect(tool?.output_size).toBe(output.length);
    expect(transcriptToolOutput("codex-transcript", path, "exec-long")).toBe(output);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("accepts compatibility event shapes for summaries, plan updates and warnings", () => {
  const events = [
    { type: "task_started", turn_id: "task" },
    { type: "item_completed", item: { type: "Reasoning", id: "r", summary_text: ["Check the focused tests."] } },
    { type: "plan_update", plan: [{ step: "Validate", status: "in_progress" }] },
    { type: "warning", message: "Connection interrupted; retrying" },
    { type: "error", message: "Retry limit reached" },
  ];
  const turns = parseCodexTranscript(events.map((payload) => JSON.stringify({ type: "event_msg", payload })).join("\n"));
  expect(turns[0]?.parts).toMatchObject([
    { kind: "thinking", text: "Check the focused tests." }, { kind: "tool", name: "update_plan", native: true },
    { kind: "notice", text: "Connection interrupted; retrying" }, { kind: "notice", text: "Retry limit reached" },
  ]);
});
