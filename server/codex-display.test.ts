import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readCodexDisplay } from "./codex-display.ts";
import { codexSteeringPending } from "./codex-steering.ts";
import { answerKeys, parseInteractivePrompt } from "./prompt.ts";

const recording = (name: string) => readFileSync(join(import.meta.dir, "fixtures/codex-chat-parity", name), "utf8");

it("offers the recorded plan confirmation through the prompt card, with an explicit No row", () => {
  const prompt = parseInteractivePrompt("codex", recording("0.167.0-plan.txt"));
  expect(prompt).toMatchObject({ kind: "plan", question: "Implement this plan?" });
  expect(prompt?.options).toHaveLength(3);
  expect(prompt?.options[2]?.label).toContain("No, stay in Plan mode");
  expect(answerKeys(prompt!, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  expect(parseInteractivePrompt("codex", `${recording("0.167.0-plan.txt")}\n› Ask Codex to do anything\nGPT-6-Luna medium · /project`)).toBeNull();
});

it("shows the recorded 0.166 and 0.167 steering panel beside the live status", () => {
  for (const version of ["0.166.0", "0.167.0"]) {
    const screen = recording(`${version}-steering.txt`);
    const display = readCodexDisplay({ screen });
    expect(display?.pending_inputs).toHaveLength(1);
    expect(display?.pending_inputs[0]?.kind).toBe("steering");
    expect(display?.pending_inputs[0]?.text).toContain(version === "0.166.0" ? "OVS24_STEER:" : "OVS24_CURRENT_STEER:");
    expect(codexSteeringPending(screen, display!.pending_inputs[0]!.text)).toBe(true);
    expect(display?.status_lines.some((line) => line.includes("background terminal running"))).toBe(true);
  }
});

it("shows native Tab-queued input without adding its edit shortcut to the user's words", () => {
  const display = readCodexDisplay({ screen: recording("0.167.0-queued.txt") });
  expect(display?.pending_inputs).toEqual([{ kind: "queued", text: "OVS24_NATIVE_QUEUED: reply with turquoise after the current turn." }]);
  expect(display?.status_lines.some((line) => line.includes("Waiting for background terminal"))).toBe(true);
  expect(codexSteeringPending(recording("0.167.0-queued.txt"), display!.pending_inputs[0]!.text)).toBe(false);
});

it("keeps indented bullets and prompt marks inside native pending messages", () => {
  const text = "Please handle these:\n• alpha\n• beta\n› quoted prompt";
  const screen = recording("0.167.0-steering.txt").replace(/  ↳ OVS24_CURRENT_STEER:[^\n]+/, "  ↳ Please handle these:\n    • alpha\n    • beta\n    › quoted prompt");
  expect(readCodexDisplay({ screen })?.pending_inputs).toEqual([{ text, kind: "steering" }]);
  expect(codexSteeringPending(screen, text)).toBe(true);
});

it("shows pending input beside another terminal draft without authorizing Escape", () => {
  for (const draft of ["› A new unsent draft", "› A new unsent draft\n  with a second line"]) {
    const screen = recording("0.167.0-steering.txt").replace("› Ask Codex to do anything", draft);
    const display = readCodexDisplay({ screen });
    expect(display?.pending_inputs).toHaveLength(1);
    expect(display?.status_lines.some((line) => line.includes("Working"))).toBe(true);
    expect(codexSteeringPending(screen, display?.pending_inputs[0]?.text ?? "")).toBe(false);
  }
});

it("shows the real update notice, startup warning and model footer", () => {
  const display = readCodexDisplay({ screen: recording("0.166.0-update.ansi") });
  expect(display?.status_lines.join("\n")).toContain("Update available! 0.166.0 -> 0.167.0");
  expect(display?.status_lines.join("\n")).toContain("WARNING: proceeding");
  expect(display?.status_lines.join("\n")).toContain("GPT-6-Luna default");
  expect(display?.pending_inputs).toEqual([]);
});

it("shows the recorded status command's context, model, account and limit lines", () => {
  const lines = readCodexDisplay({ screen: recording("0.167.0-status.txt") })?.status_lines.join("\n");
  expect(lines).toContain("Context window:      97% left (20.4K used / 258K)");
  expect(lines).toContain("Monthly limit:");
  expect(lines).toContain("fixture@example.invalid");
  expect(lines).toContain("Permissions:         Workspace (Ask for approval)");
});

it("shows the real F2 warning details only while the warning viewer is current", () => {
  const screen = recording("0.167.0-warnings.txt");
  expect(readCodexDisplay({ screen })?.status_lines.join("\n")).toContain("Code Mode is unavailable");
  expect(readCodexDisplay({ screen: `${screen}\n› Ask Codex to do anything\nGPT-6-Luna medium · /project` })?.status_lines.join("\n")).not.toContain("Code Mode is unavailable");
});

it("does not resurrect a panel above a later reply or accept a quoted composer", () => {
  const pending = recording("0.166.0-steering.txt");
  const settled = pending.replace("› Ask Codex to do anything", "• Done.\n\n› Ask Codex to do anything");
  expect(readCodexDisplay({ screen: settled })?.pending_inputs).toEqual([]);
  expect(readCodexDisplay({ screen: settled })?.status_lines.some((line) => line.includes("Working"))).toBe(false);
  expect(codexSteeringPending(settled, "OVS24_STEER: include violet in your final reply. Continue waiting for release.")).toBe(false);
  expect(readCodexDisplay({ screen: `${pending}\n$ shell prompt` })).toBeNull();
});
