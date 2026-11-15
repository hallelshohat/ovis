import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { codexComposer, codexSteeringPending, interruptCodexSteering, type CodexSteeringContext } from "./codex-steering.ts";

const hint = "Messages to be submitted after next tool call (press esc to interrupt and send immediately)";
const frame = (header = hint, composer = "› Ask Codex to do anything") => `› earlier input\n• Working (2s • esc to interrupt)\n• ${header}\n  ↳ send this now\n${composer}\n  gpt-6.1 default · /workspace\n`;
const working: CodexSteeringContext = { agent: "codex", working: true, screen: frame() };
const recorded169 = readFileSync(new URL("./fixtures/codex-chat-parity/0.169.0-steering-wrapped-footer.txt", import.meta.url), "utf8");
const recordedMessage = "CONFIRM_BACKGROUND: acknowledge this marker and keep waiting.";

describe("Codex's live steering buffer", () => {
  it("recognizes the recorded empty composer when the model footer wraps its thread title", () => {
    expect(codexComposer(recorded169)?.empty).toBe(true);
    expect(codexSteeringPending(recorded169, recordedMessage)).toBe(true);
  });

  it("ignores background command and tip rows before the native steering header", () => {
    const screen = frame().replace(`• ${hint}`, `  └ sleep 180\n  └ Tip: Use /rename to rename your threads.\n\n• ${hint}`);
    expect(codexSteeringPending(screen, "send this now")).toBe(true);
    expect(codexSteeringPending(screen.replace(`\n• ${hint}`, `\n    • ${hint}`), "send this now")).toBe(false);
  });

  it("recognizes a recorded narrow pane's wrapped hint, truncated multiline input and four-row footer", () => {
    const screen = readFileSync(new URL("./fixtures/codex-chat-parity/0.169.0-steering-narrow.txt", import.meta.url), "utf8");
    const text = "CONFIRM_NARROW: acknowledge both lines and continue waiting for the original command.\nThis second line includes enough words to wrap across a narrow terminal, with exact punctuation: [a] (b) and c.";
    expect(codexComposer(screen)?.empty).toBe(true);
    expect(codexSteeringPending(screen, text)).toBe(true);
    expect(codexSteeringPending(screen, "a different message")).toBe(false);
  });

  it("never treats a draft or a new screen as a wrapped footer", () => {
    for (const draft of ["› unsent draft", "›\n  unsent second line", "›\n  gpt-6.1 high · a draft\n  still a draft"]) {
      expect(codexSteeringPending(recorded169.replace("› Ask Codex to do anything", draft), recordedMessage)).toBe(false);
    }
    expect(codexSteeringPending(`${recorded169}\n  Select Model and Effort\n  enter select · esc back\n`, recordedMessage)).toBe(false);
    expect(codexSteeringPending(recorded169.replace("\n  input test", "\n\n  Select Model and Effort"), recordedMessage)).toBe(false);
    expect(codexSteeringPending(recorded169.replace("› Ask Codex to do anything\n\n", "›\n  an unsent draft\n\n"), recordedMessage)).toBe(false);
    expect(codexSteeringPending(recorded169.replace("  input test", "  too many\n  footer\n  continuation\n  rows"), recordedMessage)).toBe(false);
  });
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

function fixture(contexts: CodexSteeringContext[] = [working]) {
  let now = 0; let reads = 0;
  const effects: string[] = [];
  const io = {
    read: async () => contexts[Math.min(reads++, contexts.length - 1)]!,
    escape: async (fresh: () => boolean) => { effects.push(fresh() ? "Escape" : "Escape withheld"); },
    restarting: () => { effects.push("restart gate"); },
    now: () => now,
    wait: async (ms: number) => { now += ms; },
  };
  return { io, effects, elapsed: () => now, reads: () => reads, advance: (ms: number) => { now += ms; } };
}

describe("explicit Codex Send now", () => {
  it("confirms an already consumed message while Codex is still working without another key", async () => {
    const f = fixture([{ ...working, screen: frame("Queued follow-up inputs") }]);
    const io = { ...f.io, accepted: async () => true };
    await interruptCodexSteering(true, "send this now", working, io);
    expect(f.effects).toEqual([]);
  });

  it("accepts a fresh receipt after a prompt guard refuses further input", async () => {
    const f = fixture();
    let accepted = false;
    const io = { ...f.io, accepted: async () => accepted, read: async () => {
      accepted = true;
      throw new Error("agent_blocked");
    } };
    await interruptCodexSteering(true, "send this now", working, io);
    expect(f.effects).toEqual([]);
  });

  it("checks the receipt once more when a slow screen read exhausts the Escape deadline", async () => {
    const f = fixture();
    const io = { ...f.io, accepted: async () => f.elapsed() > 1500, read: async () => {
      f.advance(1501);
      return working;
    } };
    await interruptCodexSteering(true, "send this now", working, io);
    expect(f.effects).toEqual([]);
  });

  it("confirms consumption when a stale Escape is withheld instead of sending another key", async () => {
    const f = fixture();
    let accepted = false;
    const io = { ...f.io, accepted: async () => accepted, escape: async () => {
      accepted = true;
      throw new Error("cancelled");
    } };
    await interruptCodexSteering(true, "send this now", working, io);
    expect(f.effects).toEqual(["restart gate"]);
  });

  it("confirms the recorded wrapped-footer panel with one guarded Escape", async () => {
    const context = { ...working, screen: recorded169 };
    const f = fixture([context]);
    await interruptCodexSteering(true, recordedMessage, context, f.io);
    expect(f.effects).toEqual(["restart gate", "Escape"]);
    expect(f.reads()).toBe(1);
  });
  it("arms the restart gate before one Escape on a freshly checked native panel", async () => {
    const f = fixture(); await interruptCodexSteering(true, "send this now", working, f.io);
    expect(f.effects).toEqual(["restart gate", "Escape"]);
    expect(f.reads()).toBe(1);
  });

  it("interrupts Ultra's pending panel with either empty composer form", async () => {
    for (const composer of ["»", "» Ask Codex to do anything"]) {
      const ultra = { ...working, screen: frame(hint, composer).replace("default ·", "ultra ·") };
      const f = fixture([ultra]);
      await interruptCodexSteering(true, "send this now", ultra, f.io);
      expect(f.effects).toEqual(["restart gate", "Escape"]);
      expect(f.reads()).toBe(1);
    }
  });

  for (const [name, explicit, context] of [
    ["ordinary Send racing with work", false, working],
    ["idle Codex", true, { ...working, working: false }],
    ["another working agent", true, { ...working, agent: "claude" }],
  ] as const) it(`never interrupts ${name}`, async () => {
    const f = fixture(); await interruptCodexSteering(explicit, "send this now", context, f.io);
    expect(f.effects).toEqual([]); expect(f.reads()).toBe(0);
  });

  it("waits for the native panel instead of appending Escape blindly", async () => {
    const f = fixture([{ ...working, screen: "• Working (2s • esc to interrupt)\n› send this now\n" }, working]);
    await interruptCodexSteering(true, "send this now", working, f.io);
    expect(f.reads()).toBe(2); expect(f.elapsed()).toBeGreaterThan(0);
    expect(f.effects).toEqual(["restart gate", "Escape"]);
  });

  it("does not interrupt a turn that already finished after Enter", async () => {
    const f = fixture([{ ...working, working: false }]);
    await interruptCodexSteering(true, "send this now", working, f.io); expect(f.effects).toEqual([]);
  });

  for (const cause of ["disconnected", "read_only", "agent_blocked", "pending_target_changed", "input_not_ready"]) it(`keeps additional input cancelled after ${cause}`, async () => {
    const f = fixture(); f.io.read = async () => { throw new Error(cause); };
    await expect(interruptCodexSteering(true, "send this now", working, f.io)).rejects.toThrow(cause);
    expect(f.effects).toEqual([]);
  });

  it("does not claim success for working Codex without a recognized pending panel", async () => {
    const f = fixture([{ ...working, screen: frame("Queued follow-up inputs") }]);
    await expect(interruptCodexSteering(true, "send this now", working, f.io)).rejects.toThrow("not confirmed");
    expect(f.effects).toEqual([]); expect(f.elapsed()).toBeLessThanOrEqual(1500);
  });

  it("hands the key write a freshness check that fails once the deadline has passed", async () => {
    const f = fixture(); f.io.escape = async (fresh) => { f.advance(1600); f.effects.push(fresh() ? "Escape" : "Escape withheld"); };
    await interruptCodexSteering(true, "send this now", working, f.io);
    expect(f.effects).toEqual(["restart gate", "Escape withheld"]);
  });

  it("checks the deadline again after a slow screen read before sending Escape", async () => {
    const f = fixture(); f.io.read = async () => { f.advance(1501); return working; };
    await expect(interruptCodexSteering(true, "send this now", working, f.io)).rejects.toThrow("not confirmed");
    expect(f.effects).toEqual([]);
  });
});
