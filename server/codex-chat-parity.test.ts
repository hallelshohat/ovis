import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodexTranscriptParser, parseCodexTranscript } from "./codex.ts";
import { codexNativeItem } from "./codex-items.ts";
import { codexToolImage, forgetTranscriptState, transcriptPage, transcriptToolOutput } from "./conversation.ts";
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

it.each(["same-task", "replacement-task"])("labels a message after interruption, including reused turn IDs (%s)", (nextId) => {
  const parser = createCodexTranscriptParser();
  const write = (payload: object) => parser.write(JSON.stringify({ type: "event_msg", timestamp: "2026-11-15T16:00:00Z", payload }) + "\n");
  write({ type: "task_started", turn_id: "same-task" });
  write({ type: "user_message", message: "start" });
  write({ type: "turn_aborted", turn_id: "same-task", reason: "interrupted" });
  write({ type: "task_started", turn_id: nextId });
  write({ type: "user_message", message: "follow up" });
  expect(parser.snapshot().at(-1)).toMatchObject({ role: "user", native_turn_id: nextId, input_kind: "interrupted" });
  write({ type: "user_message", message: "steer again" });
  expect(parser.snapshot().at(-1)?.input_kind).toBe("steering");
});

it("does not carry steering across a completed task with a reused ID", () => {
  const payloads = [
    { type: "task_started", turn_id: "task" }, { type: "user_message", message: "start" },
    { type: "task_complete", turn_id: "task" }, { type: "task_started", turn_id: "task" },
    { type: "user_message", message: "new task" },
  ];
  const turns = parseCodexTranscript(payloads.map((payload) => JSON.stringify({ type: "event_msg", payload })).join("\n"));
  expect(turns.at(-1)?.input_kind).toBeUndefined();
});

it("keeps identical messages on opposite sides of an interruption separate", () => {
  const payloads = [
    { type: "task_started", turn_id: "first" }, { type: "user_message", message: "repeat" },
    { type: "turn_aborted", turn_id: "first", reason: "interrupted" }, { type: "task_started", turn_id: "second" },
    { type: "item_completed", turn_id: "second", item: { type: "UserMessage", id: "next", content: [{ type: "text", text: "repeat" }] } },
  ];
  const turns = parseCodexTranscript(payloads.map((payload) => JSON.stringify({ type: "event_msg", timestamp: "2026-11-15T16:00:00Z", payload })).join("\n"));
  expect(turns.filter((turn) => turn.role === "user")).toHaveLength(2);
  expect(turns.at(-1)?.input_kind).toBe("interrupted");
});

it("does not call an unclassified abort an interruption", () => {
  const payloads = [
    { type: "task_started", turn_id: "task" }, { type: "user_message", message: "start" },
    { type: "turn_aborted", turn_id: "task" }, { type: "task_started", turn_id: "task" },
    { type: "user_message", message: "retry" },
  ];
  const turns = parseCodexTranscript(payloads.map((payload) => JSON.stringify({ type: "event_msg", payload })).join("\n"));
  expect(turns.at(-1)?.input_kind).toBeUndefined();
});

it.each(["task_complete", "turn_aborted"])("does not take another task's %s for an end to current steering", (type) => {
  const payloads = [
    { type: "task_started", turn_id: "current" }, { type: "user_message", message: "start" },
    { type, turn_id: "other", reason: "interrupted" }, { type: "user_message", message: "follow up" },
  ];
  const turns = parseCodexTranscript(payloads.map((payload) => JSON.stringify({ type: "event_msg", payload })).join("\n"));
  expect(turns.at(-1)).toMatchObject({ native_turn_id: "current", input_kind: "steering" });
});

it("distinguishes the recorded Codex 0.169 interrupt-and-resubmit from accepted steering", () => {
  const turns = parseCodexTranscript(readFileSync(fixture("0.169.0-interrupted"), "utf8"));
  const copies = turns.filter((turn) => turn.role === "user" && turn.parts.some((part) => part.kind === "text" && part.text.startsWith("STEER_ovis:")));
  expect(copies).toHaveLength(2);
  expect(copies[0]?.input_kind).toBe("steering");
  expect(copies[1]?.input_kind).toBe("interrupted");
  expect(copies[0]?.native_turn_id).not.toBe(copies[1]?.native_turn_id);
});

it("keeps interruption labels across cached and cold conversation pages", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-interrupted-page-"));
  try {
    const path = join(root, "rollout.jsonl");
    writeFileSync(path, readFileSync(fixture("0.169.0-interrupted"), "utf8"));
    const live = transcriptPage("codex-transcript", path);
    expect(live.turns.at(-1)?.input_kind).toBe("interrupted");
    const payloads = [
      { type: "task_complete", turn_id: live.turns.at(-1)?.native_turn_id },
      { type: "task_started", turn_id: "next-task" }, { type: "user_message", message: "next task" },
    ];
    appendFileSync(path, payloads.map((payload) => JSON.stringify({ type: "event_msg", payload }) + "\n").join(""));
    const settled = transcriptPage("codex-transcript", path);
    expect(settled.turns.at(-2)?.input_kind).toBe("interrupted");
    expect(settled.turns.at(-1)?.input_kind).toBeUndefined();
    forgetTranscriptState();
    expect(transcriptPage("codex-transcript", path).turns).toEqual(settled.turns);
    expect(live.turns.at(-1)?.input_kind).toBe("interrupted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each([1, 10])("keeps interruption labels at cold page boundaries with %i prompts", (prompts) => {
  const root = mkdtempSync(join(tmpdir(), "codex-interrupted-boundary-"));
  try {
    const path = join(root, "rollout.jsonl");
    const recording = readFileSync(fixture("0.169.0-interrupted"), "utf8");
    const replacement = parseCodexTranscript(recording).at(-1)!;
    expect(replacement.input_kind).toBe("interrupted");
    const later = Array.from({ length: prompts * 2 - 1 }, (_, index) => [
      { type: "task_started", turn_id: `later-${index}` },
      { type: "user_message", message: `Later task ${index}` },
      { type: "agent_message", message: `Later answer ${index}` },
      { type: "task_complete", turn_id: `later-${index}` },
    ].map((payload) => JSON.stringify({ type: "event_msg", payload }) + "\n").join(""));
    writeFileSync(path, recording);
    expect(transcriptPage("codex-transcript", path, { prompts }).turns.at(-1)).toEqual(replacement);
    appendFileSync(path, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: replacement.native_turn_id } }) + "\n" + later.slice(0, prompts - 1).join(""));
    const warm = transcriptPage("codex-transcript", path, { prompts });
    expect(warm.turns[0]).toMatchObject({ native_turn_id: replacement.native_turn_id, input_kind: "interrupted" });
    forgetTranscriptState();
    const cold = transcriptPage("codex-transcript", path, { prompts });
    expect(cold.turns).toEqual(warm.turns);
    if (cold.cursor === null) throw new Error("The interruption must be on an older page");
    const preceding = transcriptPage("codex-transcript", path, { prompts, before: cold.cursor });
    expect(preceding.turns.some((turn) => turn.input_kind === "steering")).toBe(true);
    expect(transcriptPage("codex-transcript", path, { prompts }).turns).toEqual(cold.turns);

    appendFileSync(path, later.slice(prompts - 1).join(""));
    forgetTranscriptState();
    const newest = transcriptPage("codex-transcript", path, { prompts });
    expect(newest.turns.every((turn) => turn.input_kind === undefined)).toBe(true);
    if (newest.cursor === null) throw new Error("The replacement message must be on an older page");
    forgetTranscriptState();
    const older = transcriptPage("codex-transcript", path, { prompts, before: newest.cursor });
    expect(older.turns).toEqual(cold.turns);
    expect(older.turns[0]).toMatchObject({ native_turn_id: replacement.native_turn_id, input_kind: "interrupted" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each([
  { type: "task_complete", turn_id: "previous" },
  { type: "turn_aborted", turn_id: "previous" },
  { type: "turn_aborted", turn_id: "previous", reason: "unknown" },
  { type: "turn_aborted", turn_id: "other", reason: "interrupted" },
])("does not infer interruption from a preceding page's outcome: %j", (outcome) => {
  const root = mkdtempSync(join(tmpdir(), "codex-outcome-boundary-"));
  try {
    const path = join(root, "rollout.jsonl");
    const payloads = [
      { type: "task_started", turn_id: "previous" }, { type: "user_message", message: "previous" }, outcome,
      { type: "task_started", turn_id: "current" }, { type: "user_message", message: "current" },
    ];
    writeFileSync(path, payloads.map((payload) => JSON.stringify({ type: "event_msg", payload }) + "\n").join(""));
    forgetTranscriptState();
    const current = transcriptPage("codex-transcript", path, { prompts: 1 }).turns[0];
    expect(current?.native_turn_id).toBe("current");
    expect(current?.input_kind).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
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

// Synthetic regression from the review's supported event shapes; no live session data.
it("keeps both runtime notices and completion on an aborted turn", () => {
  const turn = parseCodexTranscript(readFileSync(fixture("runtime-abort"), "utf8")).find((turn) => turn.role === "assistant");
  expect(turn).toMatchObject({ native_turn_id: "runtime-failure", turn_complete: true, end_ts: "2026-11-08T10:48:04Z", parts: [
    { kind: "notice", native: true, source: "warning", text: "Connection interrupted; retrying" },
    { kind: "notice", native: true, source: "error", text: "Retry limit reached" },
  ] });
});
