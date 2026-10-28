import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { formatWorkDuration, splitTurn, todoGroups, turnSegments, commandExitCode, elapsedSince, claudeLiveOutput, codexLiveOutput, screenToolOutput, visibleWorkParts, workFailed, workSummary, type ToolPart } from "./workBlocks.ts";
import type { ConversationPart } from "../../shared/protocol.ts";

const tool = (name: string, summary = name): Extract<ConversationPart, { kind: "tool" }> => ({ kind: "tool", name, summary, input: "{}", output: "" });
const text = (value: string): Extract<ConversationPart, { kind: "text" }> => ({ kind: "text", text: value });
const thinking = (value: string): Extract<ConversationPart, { kind: "thinking" }> => ({ kind: "thinking", text: value });

describe("splitTurn", () => {
  it("folds actions and explicit narration into work while every assistant response stays in the answer", () => {
    const narration = { ...text("looking…"), phase: "commentary" as const };
    const split = splitTurn([thinking("hm"), tool("read"), narration, tool("edit"), text("done"), text("really")]);
    expect(split.work).toEqual([thinking("hm"), tool("read"), narration, tool("edit")]);
    expect(split.answer).toEqual([text("done"), text("really")]);
  });

  it("is all answer when the agent only spoke, and drops whitespace-only prose", () => {
    expect(splitTurn([text("  \n"), text("hi")])).toEqual({ work: [], answer: [text("hi")] });
  });

  it("keeps an unphased response visible when a tool follows it", () => {
    expect(splitTurn([text("The substantive answer"), tool("bash")])).toEqual({ work: [tool("bash")], answer: [text("The substantive answer")] });
  });

  it("keeps Codex commentary inside work even after the last tool or with no tools", () => {
    const narration = { ...text("Still investigating"), phase: "commentary" as const };
    expect(splitTurn([tool("exec_command"), narration]).answer).toEqual([]);
    expect(splitTurn([narration])).toEqual({ work: [narration], answer: [] });
  });

  it("honors an explicit final answer even if a later record contains an action", () => {
    const final = { ...text("Done"), phase: "final_answer" as const };
    expect(splitTurn([tool("exec_command"), final, tool("cleanup")])).toEqual({ work: [tool("exec_command"), tool("cleanup")], answer: [final] });
  });

  it("keeps a multi-step answer and later closing sentence outside the work block", () => {
    const answer = text("The report contains three sections.\n\n1. Summary.\n2. Details.\n3. Next steps.");
    const check = { ...tool("bash"), summary: "bun test report" };
    const closing = text("The report is ready.");
    const parts = [answer, check, closing];
    expect(splitTurn(parts)).toEqual({ work: [check], answer: [answer, closing] });
    // drawn in order: the answer, its run of work, the closing sentence
    expect(turnSegments(parts)).toEqual([{ kind: "text", part: answer }, { kind: "actions", parts: [check] }, { kind: "text", part: closing }]);
  });
});

describe("turnSegments", () => {
  it("keeps a later run's first part when an earlier run splits around arriving prose", () => {
    const parts: ConversationPart[] = [tool("A"), text(""), tool("B"), text("between"), tool("C")];
    const before = turnSegments(parts);
    const after = turnSegments(parts.map((part, index) => index === 1 ? text("arrived") : part));
    const firstParts = (segments: typeof before) => segments.flatMap((segment) => segment.kind === "actions" ? [parts.indexOf(segment.parts[0]!)] : []);
    expect(firstParts(before)).toEqual([0, 4]);
    expect(firstParts(after)).toEqual([0, 2, 4]);
  });

  it("keeps the turn in the order it was written: words between runs of actions, as the terminal draws it", () => {
    expect(turnSegments([thinking("hm"), text("a"), tool("bash"), tool("read"), text("b"), tool("bash"), text("done")])).toEqual([
      { kind: "actions", parts: [thinking("hm")] },
      { kind: "text", part: text("a") },
      { kind: "actions", parts: [tool("bash"), tool("read")] },
      { kind: "text", part: text("b") },
      { kind: "actions", parts: [tool("bash")] },
      { kind: "text", part: text("done") },
    ]);
  });

  it("keeps an answer before a later action where it was written", () => {
    const final = { ...text("Done"), phase: "final_answer" as const };
    expect(turnSegments([final, tool("cleanup")])).toEqual([{ kind: "text", part: final }, { kind: "actions", parts: [tool("cleanup")] }]);
  });

  it("drops blank words, and a blank line does not split a run of actions", () => {
    expect(turnSegments([])).toEqual([]);
    expect(turnSegments([text("  ")])).toEqual([]);
    expect(turnSegments([tool("a"), text(" \n"), tool("b")])).toEqual([{ kind: "actions", parts: [tool("a"), tool("b")] }]);
  });
});

describe("commandExitCode", () => {
  const run = (over: Partial<ToolPart>): ToolPart => ({ ...tool("Bash"), ...over });
  it("reads the code each agent records for a finished command", () => {
    // Claude flags a failed Bash call and starts its result with the code
    expect(commandExitCode(run({ state: "error", error: true, output: "Exit code 128\nfatal: not a git repository" }))).toBe(128);
    expect(commandExitCode(run({ state: "ok", output: "clean" }))).toBe(0);
    // Codex writes it into the output, flag or no flag
    expect(commandExitCode({ ...tool("exec_command"), output: "Process exited with code 2\nboom" })).toBe(2);
    expect(commandExitCode({ ...tool("exec_command"), output: "Chunk ID: 1\nExit code: 0\nOutput:\nok" })).toBe(0);
  });

  it("says nothing it does not know", () => {
    // a failure with no code (a hook refused it, a timeout) is a failure, not an exit status
    expect(commandExitCode(run({ state: "error", error: true, output: "Hook PreToolUse denied this call" }))).toBeNull();
    expect(commandExitCode(run({ state: "pending" }))).toBeNull();
    expect(commandExitCode({ ...tool("Read"), state: "ok", output: "Exit code 1" })).toBeNull();
    expect(commandExitCode({ ...tool("exec_command"), output: "" })).toBeNull();
  });
});

describe("elapsedSince", () => {
  it("counts from the turn's start, and says nothing for a time it cannot read", () => {
    expect(elapsedSince("2026-10-26T17:00:00Z", Date.parse("2026-10-26T17:00:12Z"))).toBe("12s");
    expect(elapsedSince(null, Date.now())).toBeNull();
    expect(elapsedSince("garbage", Date.now())).toBeNull();
  });
});

describe("screenToolOutput", () => {
  const fixture = (name: string) => readFileSync(new URL(`./fixtures-live-output/${name}`, import.meta.url), "utf8");
  const slowJob = 'cd /tmp && for i in 1 2 3 4 5 6; do echo "progress line $i of a slow job that prints steadily"; sleep 2; done; sleep 90; echo finished';

  it("finds nothing of the agent's own screen when the command has printed nothing there", () => {
    // the OVS-13 screenshot: thinking counters, narration, the echo, key hints, the spinner and a tip
    expect(screenToolOutput(fixture("claude-thinking-two-commands-120.txt"), "cd /Users/hallel/.herdr/worktrees/main/hallelshohat-rd-11022-separate-external-ent-19; until [ -s .peer/plan/round-1-peer.md ]; do sleep 5; done; cat .peer/plan/round-1-peer.md")).toBe("");
    // Claude 2.1.312 folds the output into "(21s · 7 lines)" on the echo's last row
    expect(screenToolOutput(fixture("claude-2.1.312-running-120.txt"), slowJob)).toBe("");
    // Codex 0.165 waits on a background terminal and shows only the command
    expect(screenToolOutput(fixture("codex-0.165.0-running-120.txt"), slowJob)).toBe("");
  });

  it("keeps only the lines under the running command's own echo", () => {
    const screen = [
      "  Thinking for 6s, running 1 shell command · 10s…",
      "  ⎿  $ cd /work && for i in 1 2 3; do echo \"step $i\"; sleep 2;",
      "     done",
      "     step 1",
      "       step 2 indented",
      "     (10s)",
      "     (ctrl+b to run in background)",
      "",
      "· SirMixALotting… (3m 52s · ↓ 20.4k tokens)",
    ].join("\n");
    expect(screenToolOutput(screen, 'cd /work && for i in 1 2 3; do echo "step $i"; sleep 2; done')).toBe("step 1\n  step 2 indented");
  });

  it("reads an older Claude Code's Bash block and a Codex Running block", () => {
    const claude = ["⏺ Re-running the PR update.", "", "⏺ Bash(bun test --watch)", "  ⎿  3 pass", "     1 fail", "     Running…", "", "✻ Cogitating… (12s · ↓ 1.2k tokens)", "", "─".repeat(120), "❯ ", "─".repeat(120)].join("\n");
    expect(screenToolOutput(claude, "bun test --watch")).toBe("3 pass\n1 fail");
    const codex = "  >_ OpenAI Codex (v0.164.0)\n\n• Running python3 emit-log.py\n  └ line 1\n    line 2\n    … +4 lines\n\n• Working (2s • esc to interrupt)\n\n› ";
    expect(screenToolOutput(codex, "python3 emit-log.py")).toBe("line 1\nline 2");
  });

  it("never takes another command's echo that only starts the same", () => {
    const screen = "• Running cd /work/long-project && echo SECOND\n  └ SECOND output\n\n› ";
    expect(screenToolOutput(screen, "cd /work/long-project && echo FIRST")).toBe("");
    expect(screenToolOutput(screen, "cd /work/long-project && echo SECOND")).toBe("SECOND output");
    // an echo the agent cut with "…" may be any command that starts the same: it is never taken
    for (const cut of ["• Running cd /work/long-project && echo …\n  └ SECOND output\n\n› ", "• Running cd /work/long-project && echo SEC…\n  └ SECOND output\n\n› ", "⏺ Bash(cd /work/long-project && echo …)\n  ⎿  SECOND output\n\n"]) {
      expect(screenToolOutput(cut, "cd /work/long-project && echo FIRST")).toBe("");
      expect(screenToolOutput(cut, "cd /work/long-project && echo SECOND")).toBe("");
    }
  });

  it("is empty when the running command is not on the screen", () => {
    expect(screenToolOutput(fixture("claude-thinking-two-commands-120.txt"), "bun run build")).toBe("");
    expect(screenToolOutput("⏺ Bash(bun test)\n  ⎿  3 pass", "")).toBe("");
  });
});

describe("codexLiveOutput", () => {
  const parts = JSON.parse(readFileSync(new URL("./fixtures-live-output/codex-0.165.0-running-parts.json", import.meta.url), "utf8")) as ToolPart[];

  it("joins the chunks every earlier poll of the running command's session answered", () => {
    // the last poll still waits: no output record yet
    const running: ToolPart = { ...parts.at(-1)!, output: "", state: "pending" };
    const lines = [1, 2, 3, 4, 5].map((n) => `progress line ${n} of a slow job that prints steadily`).join("\n");
    expect(codexLiveOutput([...parts.slice(0, -1), running], running)).toBe(lines);
  });

  it("keeps the chunks when the agent's words sit between the command and its next poll", () => {
    const running: ToolPart = { ...parts.at(-1)!, output: "", state: "pending" };
    const words: ConversationPart = { kind: "text", text: "Still waiting on the slow job.", phase: "commentary" };
    const turn = [...parts.slice(0, -1), words, running];
    expect(codexLiveOutput(turn, running)).toContain("progress line 5 of a slow job");
  });

  it("reads a chunk cut to the page's length as far as it goes, and whole once loaded", () => {
    const long = Array.from({ length: 100 }, (_, n) => `line ${n} ${"x".repeat(45)}`).join("\n");
    const raw = `Script completed\nWall time 5.0 seconds\nOutput:\n\n${JSON.stringify({ chunk_id: "c", session_id: 28799, output: `${long}\n` })}`;
    // as the server's trimOutput leaves it: the head, then the mark
    const first: ToolPart = { ...parts[1]!, output: `${raw.slice(0, 4000)}\n… trimmed`, output_ref: "call_cut", output_size: raw.length };
    const running: ToolPart = { ...parts.at(-1)!, output: "", state: "pending" };
    const preview = codexLiveOutput([first, running], running)!;
    expect(preview.startsWith("line 0 ")).toBe(true);
    expect(long.startsWith(preview)).toBe(true);
    expect(codexLiveOutput([first, running], running, new Map([["call_cut", raw]]))).toBe(long);
  });

  it("is null for a call that names no session, and empty before any chunk", () => {
    const first: ToolPart = { ...parts[0]!, output: "", state: "pending" };
    expect(codexLiveOutput([first], first)).toBeNull();
    const poll: ToolPart = { ...parts[1]!, output: "", state: "pending" };
    expect(codexLiveOutput([poll], poll)).toBe("");
  });
});

describe("claudeLiveOutput", () => {
  const bash = (id: string, rest: Partial<ToolPart>): ToolPart => ({ kind: "tool", name: "Bash", summary: id, input: "{}", output: "", call_id: id, ...rest });

  it("never shows a background task's file as a running command's", () => {
    const foreground = bash("fg", { state: "pending" });
    // the later parallel call went to the background: its result names its file
    const background = bash("bg", { state: "ok", output: "Command running in background with ID: b2. Output is being written to: /tmp/claude-501/p/s/tasks/b2.output" });
    const files = [{ id: "b1", text: "FOREGROUND output" }, { id: "b2", text: "BACKGROUND output" }];
    expect(claudeLiveOutput(files, [foreground, background], foreground)).toBe("FOREGROUND output");
    expect(claudeLiveOutput([...files].reverse(), [foreground, background], foreground)).toBe("FOREGROUND output");
  });

  it("gives parallel running commands their files in the order they started, and nothing before a file exists", () => {
    const first = bash("one", { state: "pending" });
    const second = bash("two", { state: "pending" });
    const files = [{ id: "a", text: "A" }, { id: "b", text: "B" }];
    expect(claudeLiveOutput(files, [first, second], first)).toBe("A");
    expect(claudeLiveOutput(files, [first, second], second)).toBe("B");
    expect(claudeLiveOutput([{ id: "a", text: "A" }], [first, second], second)).toBe("");
    expect(claudeLiveOutput(files, [first], bash("done", { state: "ok" }))).toBe("");
  });
});

describe("workSummary", () => {
  it("counts by what the reader cares about, singular and plural", () => {
    expect(workSummary([tool("Edit"), tool("Write"), tool("read"), tool("Bash"), tool("WebFetch")])).toBe("2 edits · 1 file read · 1 command · 1 other tool");
  });

  it("is empty for reasoning and prose alone", () => {
    expect(workSummary([thinking("x"), text("y")])).toBe("");
  });

  it("leaves todo updates out of the counts", () => {
    expect(workSummary([tool("TodoWrite"), tool("Edit"), tool("update_plan"), tool("todo_write"), tool("Read")])).toBe("1 edit · 1 file read");
  });
});

describe("formatWorkDuration", () => {
  it("formats seconds, minutes and rejects unknown or negative spans", () => {
    expect(formatWorkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:07.4Z")).toBe("7s");
    expect(formatWorkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:01:12Z")).toBe("1m 12s");
    expect(formatWorkDuration("2026-01-01T00:00:10Z", "2026-01-01T00:00:00Z")).toBeNull();
    expect(formatWorkDuration(null, "2026-01-01T00:00:00Z")).toBeNull();
  });
});

describe("workFailed", () => {
  const failed: ConversationPart = { kind: "tool", name: "Bash", summary: "", input: "", output: "", error: true };

  it("counts the calls that failed, apart from the summary a narrow header cuts short", () => {
    const parts = [tool("Edit"), failed, failed];
    expect(workSummary(parts)).toBe("1 edit · 2 commands");
    expect(workFailed(parts)).toBe(2);
    expect(workFailed([tool("Edit"), thinking("x"), text("y")])).toBe(0);
  });

  it("counts a failed call the summary does not count", () => {
    const parts: ConversationPart[] = [{ ...failed, name: "TodoWrite" }];
    expect(workSummary(parts)).toBe("");
    expect(workFailed(parts)).toBe(1);
  });
});


it("keeps an approval-blocked assistant turn live, including with a last-activity timestamp", async () => {
  const { isLiveWorkTurn } = await import("./workBlocks.ts");
  const turn = { role: "assistant" as const, ts: null, parts: [], end_ts: "2026-09-28T00:00:00Z" };
  expect(isLiveWorkTurn(turn, true, "blocked")).toBe(true);
  expect(isLiveWorkTurn({ ...turn, end_ts: undefined }, true, "blocked")).toBe(true);
  expect(isLiveWorkTurn(turn, true, "working")).toBe(true);
  expect(isLiveWorkTurn(turn, false, "blocked")).toBe(false);
  expect(isLiveWorkTurn(turn, true, "idle")).toBe(false);
  expect(isLiveWorkTurn({ ...turn, role: "user" }, true, "blocked")).toBe(false);
});

it("does not title a finished turn as running after a message was sent over it", async () => {
  const { isLiveWorkTurn } = await import("./workBlocks.ts");
  const finished = { role: "assistant" as const, ts: "2026-09-29T00:00:00Z", parts: [], end_ts: "2026-09-29T00:00:06Z" };
  // sent over it, status already `working`, transcript not yet holding the new message
  expect(isLiveWorkTurn(finished, true, "working", finished)).toBe(false);
  expect(isLiveWorkTurn(finished, true, "blocked", finished)).toBe(false);
  // a turn without a recorded time is still the one sent over
  const untimed = { ...finished, ts: null };
  expect(isLiveWorkTurn(untimed, true, "working", untimed)).toBe(false);
  // the turn that answers the message is a different one and is live again, even with the same time
  const next = { ...finished, end_ts: undefined };
  expect(isLiveWorkTurn(next, true, "working", finished)).toBe(true);
  expect(isLiveWorkTurn({ ...untimed }, true, "working", untimed)).toBe(true);
  // nothing sent over keeps following the status
  expect(isLiveWorkTurn(finished, true, "working", null)).toBe(true);
  expect(isLiveWorkTurn(finished, true, "working")).toBe(true);
});

it("says the open block waits for the user while the agent is blocked, and only then", async () => {
  const { isWaitingWorkTurn } = await import("./workBlocks.ts");
  expect(isWaitingWorkTurn(true, "blocked")).toBe(true);
  // a question in Codex's queue: Codex keeps working
  expect(isWaitingWorkTurn(true, "working")).toBe(false);
  // a settled turn keeps "Worked for …" whatever the pane's status
  expect(isWaitingWorkTurn(false, "blocked")).toBe(false);
  expect(isWaitingWorkTurn(true, undefined)).toBe(false);
});

describe("visibleWorkParts", () => {
  it("draws no rows for skills, nor for thinking unless it is shown", () => {
    const skill: ConversationPart = { kind: "skill", skill: { name: "review", evidence: "invocation", status: "loaded" } };
    expect(visibleWorkParts([skill, thinking("hm")], false)).toEqual([]);
    expect(visibleWorkParts([skill, thinking("hm")], true)).toEqual([thinking("hm")]);
    expect(visibleWorkParts([tool("read")], false)).toEqual([tool("read")]);
  });
});

describe("todoGroups", () => {
  type State = ToolPart["state"];
  // a Claude TodoWrite: its list is its input; the native id and state as the server sends them
  const write = (id: string | undefined, state: State, todos: unknown = [{ content: "Read", status: "completed" }, { content: "Fix", status: "in_progress" }], output = ""): ToolPart =>
    ({ kind: "tool", name: "TodoWrite", summary: "TodoWrite", input: typeof todos === "string" ? todos : JSON.stringify({ todos }), output,
      ...(id === undefined ? {} : { call_id: id }), ...(state === undefined ? {} : { state }), ...(state === "error" ? { error: true } : {}) });
  const plan = (id: string | undefined, state: State, steps: string[]): ToolPart =>
    ({ kind: "tool", name: "update_plan", summary: "update_plan", input: JSON.stringify({ plan: steps.map((step) => ({ step, status: "completed" })) }), output: "Plan updated",
      ...(id === undefined ? {} : { call_id: id }), ...(state === undefined ? {} : { state }) });
  const only = (parts: ConversationPart[], row = "row") => {
    const groups = [...todoGroups(parts, row).values()];
    expect(groups).toHaveLength(1);
    return groups[0]!;
  };

  it("folds only contiguous todo snapshots; one item stays a normal row", () => {
    const a = write("a", "ok"), b = write("b", "ok"), c = write("c", "ok"), d = write("d", "ok");
    const groups = todoGroups([a, b, tool("Bash"), c, text("next"), d], "row");
    expect([...groups.keys()]).toEqual([a]);
    expect(groups.get(a)!.attempts.map((attempt) => attempt.part)).toEqual([a, b]);
    expect(todoGroups([write("solo", "ok")], "row").size).toBe(0);
  });

  it("ends a run at narration and at hidden thinking or skill parts", () => {
    const skill: ConversationPart = { kind: "skill", skill: { name: "x", evidence: "invocation", status: "loaded" } };
    for (const between of [text("Now the second half."), thinking("private"), skill]) {
      expect(todoGroups([write("a", "ok"), between, write("b", "ok")], "row").size).toBe(0);
    }
  });

  it("keeps the first call's identity through append and replacement", () => {
    const first = only([write("a", "pending"), write("b", "pending")]).id;
    // the next poll: a new object for every part, results recorded, a third call appended
    expect(only([write("a", "ok"), write("b", "error"), write("c", "pending")]).id).toBe(first);
    expect(only([write("a", "ok"), write("b", "ok")]).id).toBe(first);
    // the same call id in another turn's row is another run
    expect(only([write("a", "ok"), write("b", "ok")], "other row").id).not.toBe(first);
  });

  it("names a run without ids by its turn row and its first part's original index", () => {
    const parts = [text("intro"), write(undefined, undefined), write(undefined, undefined)];
    const id = only(parts).id;
    expect(id).toBe(JSON.stringify(["row", "#1"]));
    expect(only([text("intro"), write(undefined, undefined), write(undefined, undefined), write(undefined, undefined)]).id).toBe(id);
  });

  it("takes the latest ok list, counting a later pending and failed call apart", () => {
    const ok = write("a", "ok", [{ content: "Read", status: "completed" }]);
    const group = only([ok, write("b", "pending"), write("c", "error")]);
    expect(group.current?.part).toBe(ok);
    expect(group.current?.state).toBe("ok");
    expect(group.current?.items).toEqual([{ label: "Read", phase: null, status: "completed" }]);
    expect([group.pending, group.failed]).toEqual([1, 1]);
    expect(group.attempts.map((attempt) => attempt.state)).toEqual(["ok", "pending", "error"]);
  });

  it("says the latest ok list cannot be read instead of using an earlier one", () => {
    const group = only([write("a", "ok"), write("b", "ok", "{not json")]);
    expect(group.current?.part.call_id).toBe("b");
    expect(group.current?.items).toBeNull();
  });

  it("shows a completed Codex snapshot with omitted state without a success claim, even after an older ok", () => {
    const codex = plan("call_2", undefined, ["Ship"]);
    const group = only([write("toolu_1", "ok"), codex]);
    expect(group.current?.part).toBe(codex);
    expect(group.current?.state).toBe("unknown");
    expect(group.current?.items).toEqual([{ label: "Ship", phase: null, status: "completed" }]);
  });

  it("uses the latest snapshot of an all-undefined run without a success claim", () => {
    const group = only([write(undefined, undefined, [{ content: "Old", status: "pending" }]), write(undefined, undefined, [{ content: "New", status: "pending" }])]);
    expect(group.current?.state).toBe("unknown");
    expect(group.current?.items?.map((item) => item.label)).toEqual(["New"]);
    expect(group.attempts.some((attempt) => attempt.state === "ok")).toBe(false);
  });

  it("never takes a failed call without a recorded state for the list", () => {
    const earlier = write(undefined, undefined, [{ content: "Kept", status: "pending" }]);
    const group = only([earlier, { ...write(undefined, undefined, "{not json"), error: true }]);
    expect(group.current?.part).toBe(earlier);
    expect(group.failed).toBe(1);
  });

  it("invents no list from pending and failed calls alone", () => {
    const group = only([write("a", "pending"), write("b", "error")]);
    expect(group.current).toBeNull();
    expect([group.pending, group.failed]).toEqual([1, 1]);
  });

  it("infers no outcome from empty or nonempty output", () => {
    for (const output of ["", "Error: the update failed", "Todos have been modified successfully"]) {
      const group = only([write("a", "pending", undefined, output), write(undefined, undefined, undefined, output)]);
      expect(group.attempts.map((attempt) => attempt.state)).toEqual(["pending", "unknown"]);
      expect(group.failed).toBe(0);
    }
  });

  it("keeps repeated identical calls as distinct attempts", () => {
    const group = only([write("a", "ok"), write("b", "ok")]);
    expect(group.attempts.map((attempt) => attempt.part.call_id)).toEqual(["a", "b"]);
  });
});
