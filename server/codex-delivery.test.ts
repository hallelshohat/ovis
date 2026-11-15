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
