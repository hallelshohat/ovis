import { describe, expect, it } from "bun:test";
import { codexSteeringPending } from "./codex-steering.ts";

const hint = "Messages to be submitted after next tool call (press esc to interrupt and send immediately)";
const frame = (header = hint, composer = "› Ask Codex to do anything") => `› earlier input\n• Working (2s • esc to interrupt)\n• ${header}\n  ↳ send this now\n${composer}\n  gpt-6.1 default · /workspace\n`;

describe("Codex's live steering buffer", () => {
  it("recognizes the native pending-steering panel beside an empty composer", () => {
    expect(codexSteeringPending(frame(), "send this now")).toBe(true);
    expect(codexSteeringPending(frame(hint, "›"), "send this now")).toBe(true);
  });

  it("recognizes a narrow pane's wrapped native hint", () => {
    expect(codexSteeringPending(frame("Messages to be submitted after next tool\ncall (press esc to interrupt and send\nimmediately)"), "send this now")).toBe(true);
  });

  for (const elapsed of ["1m 12s", "1h 2m 3s", "2m"]) it(`recognizes a working turn lasting ${elapsed}`, () => {
    expect(codexSteeringPending(frame().replace("2s • esc", `${elapsed} • esc`), "send this now")).toBe(true);
  });

  for (const [name, screen] of [
    ["quoted hint", `› explain this\n${hint}\n• Working (2s • esc to interrupt)\n› Ask Codex to do anything\n`],
    ["old panel above a newer turn", `${frame()}\n• Working (3s • esc to interrupt)\n› Ask Codex to do anything\n`],
    ["native next-turn queue", frame("Queued follow-up inputs")],
    ["nonempty composer", frame(hint, "› unsent user draft")],
    ["missing pending message", frame().replace("  ↳ send this now\n", "")],
    ["no native working status", frame().replace("• Working (2s • esc to interrupt)\n", "")],
    ["another open UI after the composer", `${frame()}Select Model and Effort\nenter select · esc back\n`],
  ]) it(`does not authorize Escape from ${name}`, () => {
    expect(codexSteeringPending(screen!, "send this now")).toBe(false);
  });
  // Codex 0.162.1, read from a live pane: the shortcuts hint under the composer, a wrapped entry,
  // a multi-line one, and a long one cut with a "…" row
  const live = (entries: string) => `› first task\n• Working (13s • esc to interrupt)\n• ${hint}\n${entries}› Ask Codex to do anything\n  gpt-5.1 default · /tmp/work · ⠇\n  ← for agents · ? for shortcuts                                    ⚠ 1 warning · f2 to view\n`;
  const long = `LLLL ${Array.from({ length: 120 }, (_, i) => `w${i}`).join(" ")}`;

  it("recognizes Codex 0.162's panel above its shortcuts hint", () => {
    expect(codexSteeringPending(live("  ↳ send this now\n"), "send this now")).toBe(true);
  });

  it("recognizes the panel above Codex 0.164's Fast-mode footer", () => {
    const fast = live("  ↳ send this now\n").replace("  gpt-5.1 default · /tmp/work · ⠇", "  gpt-6.1 high fast · ~/work · Fix the flaky test · Main [default]");
    expect(codexSteeringPending(fast, "send this now")).toBe(true);
    expect(codexSteeringPending(fast.replace("high fast ·", "high faster ·"), "send this now")).toBe(false);
  });

  it("matches the submitted message however Codex wrapped or cut it", () => {
    expect(codexSteeringPending(live("  ↳ older entry\n  ↳ second message that wraps around\n    the narrow pane\n"), "second message that wraps around the narrow pane")).toBe(true);
    expect(codexSteeringPending(live("  ↳ line one\n    line two\n"), "line one\nline two")).toBe(true);
    expect(codexSteeringPending(live(`  ↳ LLLL w0 w1 w2\n    w3 w4 w5\n    …\n`), long)).toBe(true);
  });

  it("reads a message whose own second line starts with the arrow", () => {
    // Codex indents continuation rows two deeper than the entry's arrow; an arrow there is text
    expect(codexSteeringPending(live("  ↳ explain\n    ↳ send this now\n"), "explain\n↳ send this now")).toBe(true);
    expect(codexSteeringPending(live("  ↳ explain\n    ↳ send this now\n"), "send this now")).toBe(false);
  });

  it("compares only the steering section's last entry, not a later section's", () => {
    const sections = "  ↳ older steer\n• Messages to be submitted at end of turn\n  ↳ send this now\n";
    expect(codexSteeringPending(live(sections), "send this now")).toBe(false);
    expect(codexSteeringPending(live("  ↳ send this now\n• Messages to be submitted at end of turn\n  ↳ queued for later\n"), "send this now")).toBe(true);
  });

  it("takes a trailing ellipsis for a cut only on its own row", () => {
    expect(codexSteeringPending(live("  ↳ wait…\n"), "wait for tests")).toBe(false);
    expect(codexSteeringPending(live("  ↳ wait…\n"), "wait…")).toBe(true);
    expect(codexSteeringPending(live("  ↳ …\n"), "anything")).toBe(false);
  });

  for (const [name, entries, text] of [
    ["an entry that was already waiting", "  ↳ older entry\n", "send this now"],
    ["an older entry above the newest one", "  ↳ send this now\n  ↳ typed in the terminal\n", "send this now"],
    ["a cut entry of another message", "  ↳ LLLL w0 w1 w9\n    …\n", long],
    ["an empty message", "  ↳ older entry\n", " "],
  ]) it(`does not take ${name} for the submitted message`, () => {
    expect(codexSteeringPending(live(entries!), text!)).toBe(false);
    // and without the shortcuts hint, as Codex 0.161 drew it
    expect(codexSteeringPending(live(entries!).replace(/\n.*for shortcuts.*\n$/, "\n"), text!)).toBe(false);
  });
});
