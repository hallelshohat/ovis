import { expect, it } from "bun:test";
import { codexDeliveryAccepted } from "./codex-delivery.ts";
import type { CommandTranscript } from "./conversation.ts";
import { commandTranscriptRecords } from "./outcome.ts";

const text = "REVIEW_UI_READY: acknowledge this marker and keep waiting.\nSecond line: 한글 👩🏽‍💻";
const user = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }) + "\n";
const snapshot = (log: string): CommandTranscript => ({ identity: "same transcript", end: Buffer.byteLength(log), records: commandTranscriptRecords(log) });

it("confirms a fresh canonical user record with exact multiline text", () => {
  const anchor = snapshot(user);
  const current = snapshot(user + user);
  expect(codexDeliveryAccepted({ anchor, current, text })).toBe(true);
  expect(codexDeliveryAccepted({ anchor, current, text: text.replace("Second line", "Secondline") })).toBe(false);
});

it.each([
  "<environment_context>ROUND2_LITERAL: acknowledge this exact example, then continue waiting.</environment_context>",
  "<permissions instructions>literal permissions example</permissions instructions>",
  "<turn_aborted>literal interruption example</turn_aborted>",
  "<subagent_notification>literal notification example</subagent_notification>",
  "# AGENTS.md instructions for /example\n<INSTRUCTIONS>literal rules</INSTRUCTIONS>",
  '<send_user_message_question_reply>[{"answer":"literal answer","question":"example","questionItemId":"one"}]</send_user_message_question_reply>',
  "<skill>\n<name>example</name>\n<path>/example/SKILL.md</path>\n</skill>",
])("confirms literal user content independently of chat display filters: %s", (literal) => {
  const line = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: literal }] } }) + "\n";
  expect(codexDeliveryAccepted({ anchor: snapshot(user), current: snapshot(user + line), text: literal })).toBe(true);
});

it("matches the full raw content across text blocks without dropping context-shaped blocks", () => {
  const parts = ["literal example:", "<environment_context>example context</environment_context>", "한글 👩🏽‍💻"];
  const line = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: parts.map((text) => ({ type: "input_text", text })) } }) + "\n";
  const current = snapshot(user + line);
  expect(codexDeliveryAccepted({ anchor: snapshot(user), current, text: parts.join("\r\n") })).toBe(true);
  expect(codexDeliveryAccepted({ anchor: snapshot(user), current, text: [parts[0], parts[2]].join("\n") })).toBe(false);
});

it("does not reuse an identical historical record or a partial record begun before Enter", () => {
  expect(codexDeliveryAccepted({ anchor: snapshot(user), current: snapshot(user), text })).toBe(false);
  expect(codexDeliveryAccepted({ anchor: snapshot(user.slice(0, 50)), current: snapshot(user), text })).toBe(false);
});

it("does not take assistant acknowledgments or duplicate event echoes as user receipts", () => {
  const event = JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: text } }) + "\n";
  const assistant = user.replace('"role":"user"', '"role":"assistant"');
  for (const echo of [event, assistant]) {
    expect(codexDeliveryAccepted({ anchor: snapshot(user), current: snapshot(user + echo), text })).toBe(false);
  }
});

it("refuses missing, rewritten, replaced or switched transcripts", () => {
  const anchor = snapshot(user);
  const current = snapshot(user + user);
  expect(codexDeliveryAccepted({ anchor: null, current, text })).toBe(false);
  expect(codexDeliveryAccepted({ anchor, current: null, text })).toBe(false);
  expect(codexDeliveryAccepted({ anchor, current: { ...current, identity: "another transcript generation" }, text })).toBe(false);
  expect(codexDeliveryAccepted({ anchor: current, current: anchor, text })).toBe(false);
});
