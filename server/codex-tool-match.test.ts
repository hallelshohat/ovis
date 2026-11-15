import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { codexToolActivityConflict, matchCodexToolActivity } from "./codex-tool-match.ts";
import { resetCodexHistoryScans } from "./codex-history-scan.ts";

describe("Codex native command screen ownership", () => {
  const commands = ["bun run verify --project /work/integration", "git diff --stat -- src/verification"];
  const outputs = [
    "Verification receipts: integration suite completed successfully with thirty seven isolated workers and zero leaked processes.",
    "src/verification/pool.ts | 128 lines changed; scheduler cleanup and worker ownership assertions all passed independently.",
  ];
  const events = commands.map((command, index) => ({ type: "event_msg", payload: { type: "item_completed", item: {
    type: "CommandExecution", id: `command-${index}`, command: ["/bin/zsh", "-lc", command], cwd: "/work", parsed_cmd: [],
    status: "completed", aggregated_output: outputs[index], exit_code: 0,
  } } }));
  const candidate = { path: "own", text: events.map((event) => JSON.stringify(event)).join("\n") + "\n" };
  const body = commands.map((command, index) => `• Ran ${command}\n  └ ${outputs[index]}`).join("\n\n");
  const screen = `${body}\n\n• Working (8m 29s • esc to interrupt)\n› \nGPT-6-Astra high · /work\n? for shortcuts`;
  const resolve = (shown = screen, candidates = [candidate]) => matchCodexToolActivity({ screen: shown, candidates });

  it("requires two distinct substantial completed command/output pairs", () => {
    expect(resolve()).toBe("own");
    expect(resolve(screen.replace(outputs[0]!, "(no output)"))).toBeNull();
    expect(resolve(screen.replace(commands[1]!, commands[0]!).replace(outputs[1]!, outputs[0]!))).toBeNull();
    expect(resolve(screen, [{ ...candidate, text: JSON.stringify(events[0]) + "\n" }])).toBeNull();
  });

  it("uses full native output, including a preview beyond chat truncation", () => {
    const text = events.map((event, index) => JSON.stringify({ ...event, payload: { ...event.payload, item: {
      ...event.payload.item, aggregated_output: "irrelevant earlier output\n".repeat(400) + outputs[index],
    } } })).join("\n") + "\n";
    expect(resolve(screen, [{ ...candidate, text }])).toBe("own");
  });

  it("allows explicitly clipped commands and wrapped output, preserving punctuation", () => {
    expect(resolve(screen.replace(commands[0]!, "bun run verify…").replace("suite completed", "suite\n    completed"))).toBe("own");
    expect(resolve(screen.replace(commands[0]!, "bun run verify"))).toBeNull();
    expect(resolve(screen.replace("| 128", "+ 128"))).toBeNull();
    expect(resolve(screen.replace("| 128", "| 182"))).toBeNull();
    expect(resolve(screen.replace(outputs[0]!, `${outputs[0]}\n    + 430 lines (⌃t to expand)`))).toBe("own");
    expect(resolve(screen.replace(outputs[0]!, `${outputs[0]!.slice(0, 100)}…\n    hidden middle rows`))).toBe("own");
  });

  it("does not count a single command twice or join reordered calls", () => {
    expect(resolve(screen, [{ ...candidate, text: [...events].reverse().map((event) => JSON.stringify(event)).join("\n") }])).toBeNull();
    const single = JSON.stringify({ ...events[0], payload: { ...events[0]!.payload, item: { ...events[0]!.payload.item, aggregated_output: outputs.join("\n") } } });
    expect(resolve(screen.replace(commands[1]!, commands[0]!), [{ ...candidate, text: single }])).toBeNull();
  });

  it("matches rerun commands after an older occurrence of a later visible command", () => {
    const earlier = { ...events[1], payload: { ...events[1]!.payload, item: { ...events[1]!.payload.item, id: "earlier-second-command" } } };
    const text = [earlier, ...events].map((event) => JSON.stringify(event)).join("\n");
    expect(resolve(screen, [{ ...candidate, text }])).toBe("own");
    expect(resolve(screen, [{ ...candidate, text: [earlier, events[0]].map((event) => JSON.stringify(event)).join("\n") }])).toBeNull();
  });

  it("does not treat snippets in another command's output as matching command/output pairs", () => {
    const elsewhere = { path: "elsewhere", text: JSON.stringify({ ...events[0], payload: { ...events[0]!.payload, item: {
      ...events[0]!.payload.item, command: ["/bin/zsh", "-lc", "cat unrelated-source.ts"], aggregated_output: outputs.join("\n"),
    } } }) };
    expect(resolve(screen, [candidate, elsewhere])).toBe("own");
  });

  it("uses the complete visible sequence when another thread shares only the earlier commands", () => {
    const command = "bun run audit --project /work/isolated-final-check";
    const output = "Final isolated audit verified every worker lease, removed the stale pending jobs, and reconciled the deployment inventory successfully.";
    const final = JSON.stringify({ ...events[0], payload: { ...events[0]!.payload, item: {
      ...events[0]!.payload.item, id: "final-command", command: ["/bin/zsh", "-lc", command], aggregated_output: output,
    } } });
    const shown = screen.replace("• Working", `• Ran ${command}\n  └ ${output}\n\n• Working`);
    expect(resolve(shown, [{ ...candidate, text: candidate.text + final }, { ...candidate, path: "shared-earlier" }])).toBe("own");
  });

  it("refuses copied output, mixed owners, incomplete records and pending calls", () => {
    expect(resolve(screen, [candidate, { ...candidate, path: "twin" }])).toBeNull();
    const quote = { path: "quote", text: JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: body } }) + "\n" };
    expect(resolve(screen, [quote])).toBeNull();
    expect(resolve(screen, [candidate, quote])).toBeNull();
    const formattedQuote = { ...quote, text: quote.text.replace("integration suite", "**integration suite**") };
    expect(resolve(screen, [candidate, formattedQuote])).toBeNull();
    const entityQuote = { ...quote, text: quote.text.replace("Verification", "Verific&#97;tion") };
    expect(resolve(screen, [candidate, entityQuote])).toBeNull();
    const unrelatedEntity = { ...quote, text: JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "The template says &amp; nothing about these checks." } }) };
    expect(resolve(screen, [candidate, unrelatedEntity])).toBe("own");
    const singleQuote = { ...quote, text: JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: outputs[0] } }) };
    expect(resolve(screen, [candidate, singleQuote])).toBe("own");
    expect(resolve(screen, events.map((event, index) => ({ path: String(index), text: JSON.stringify(event) + "\n" })))).toBeNull();
    expect(resolve(screen, [candidate, { path: "cut", text: '{"type":"event_msg"' }])).toBeNull();
    const unsupported = { path: "old-format", text: JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: commands[0] } } }) };
    expect(resolve(screen, [candidate, unsupported])).toBeNull();
    const pending = { path: "pending", text: JSON.stringify({ ...events[0], payload: { type: "item_started", item: {
      ...events[0]!.payload.item, status: "in_progress", aggregated_output: "",
    } } }) + "\n" };
    expect(resolve(screen, [candidate, pending])).toBeNull();
  });

  it("ignores tools quoted in prompts, output, drafts and unrecognized screens", () => {
    expect(resolve(screen.replaceAll("• Ran", "  • Ran"))).toBeNull();
    expect(resolve(screen.replace("GPT-6-Astra high · /work", "unknown footer"))).toBeNull();
    expect(resolve(screen.replace(body, `› ${body.replaceAll("\n", "\n  ")}`))).toBeNull();
  });

  it("invalidates a competing-history result after a write and refuses missing or incomplete records", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-tool-match-")), path = join(root, "rollout.jsonl");
    const conflict = () => codexToolActivityConflict({ screen, segments: [{ path, end: statSync(path).size }] });
    try {
      writeFileSync(path, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Unrelated conversation." } }) + "\n");
      expect(await conflict()).toBe(false);
      expect(await conflict()).toBe(false);
      writeFileSync(path, candidate.text);
      expect(await conflict()).toBe(true);
      writeFileSync(path, '{"type":"event_msg"');
      expect(await conflict()).toBe(true);
      rmSync(path);
      expect(await codexToolActivityConflict({ screen, segments: [{ path, end: 100 }] })).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const bytes of [8 * 1024 * 1024 + 1, 32 * 1024 * 1024]) {
    it(`checks a valid ${bytes}-byte tool output without permanently refusing its peer`, async () => {
      const root = mkdtempSync(join(tmpdir(), "ovis-tool-large-record-")), path = join(root, "rollout.jsonl");
      const record = (output: string) => JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "unrelated", output } }) + "\n";
      const conflict = () => codexToolActivityConflict({ screen, segments: [{ path, end: statSync(path).size }] });
      try {
        const padding = "x".repeat(bytes);
        writeFileSync(path, record(padding));
        const started = performance.now();
        let refused = await conflict();
        while (refused && performance.now() - started < 2000) {
          await setImmediate();
          refused = await conflict();
        }
        expect(refused).toBe(false);
        expect(await conflict()).toBe(false);
        appendFileSync(path, record("Another unrelated completed call."));
        expect(await conflict()).toBe(false);

        // Evidence after the old size boundary must still prevent binding the wrong peer.
        writeFileSync(path, record(padding + body));
        expect(await conflict()).toBe(true);
        expect(await conflict()).toBe(true);
        writeFileSync(path, record("Unrelated replacement."));
        expect(await conflict()).toBe(false);
      } finally {
        await resetCodexHistoryScans();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  for (const [screenCount, total] of [[2, 21], [2, 32], [3, 21], [3, 32], [4, 21], [4, 32], [8, 32], [16, 32]] as const) for (const warmed of [false, true]) {
    it(`clears ${screenCount} overlapping tool screens across ${total} histories from a ${warmed ? "warm" : "cold"} cache`, async () => {
      const root = mkdtempSync(join(tmpdir(), "ovis-tool-overlap-"));
      const alternate = ({ text, index }: { text: string; index: number }) => index === 0 ? text
        : text.replaceAll("/work/integration", `/work/parallel-${index}`).replaceAll("src/verification", `src/secondary-${index}`);
      const candidates = Array.from({ length: total }, (_, index) => ({
        path: join(root, `${index}.jsonl`),
        text: index < screenCount ? alternate({ text: candidate.text, index })
          : JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Unrelated completed work." } }) + "\n",
      }));
      const screens = Array.from({ length: screenCount }, (_, index) => alternate({ text: screen, index }));
      const peers = async (shown: string) => {
        const owner = matchCodexToolActivity({ screen: shown, candidates });
        expect(owner).toBe(candidates[screens.indexOf(shown)]!.path);
        const conflicts = await Promise.all(candidates.filter(({ path }) => path !== owner)
          .map(({ path }) => codexToolActivityConflict({ screen: shown, segments: [{ path, end: statSync(path).size }] })));
        return conflicts.filter((conflict) => !conflict).length;
      };
      try {
        await resetCodexHistoryScans();
        for (const entry of candidates) writeFileSync(entry.path, entry.text);
        if (warmed) for (const shown of screens) expect(await peers(shown)).toBe(total - 1);
        const rounds: number[][] = [];
        for (let round = 0; round < (screenCount > 4 ? 20 : 5); round++) rounds.push(await Promise.all(screens.map(peers)));
        const firstComplete = screens.map((_, index) => rounds.findIndex((round) => round[index] === total - 1) + 1);
        console.log(JSON.stringify({ case: "overlapping tool lookups", screenCount, total, warmed, firstComplete, cleared: screenCount <= 4 ? rounds : undefined }));
        const complete = Array.from({ length: screenCount }, () => total - 1);
        expect(firstComplete.every((round) => round > 0)).toBe(true);
        if (screenCount <= 4) {
          expect(rounds.at(-1)).toEqual(complete);
          if (warmed) expect(rounds).toEqual(Array.from({ length: 5 }, () => complete));
          const growing = candidates.at(-1)!.path;
          appendFileSync(growing, JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }) + "\n");
          expect(await Promise.all(screens.map(peers))).toEqual(complete);
          appendFileSync(growing, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: screens[1] } }) + "\n");
          expect(await Promise.all(screens.map(peers))).toEqual(complete.map((count, index) => index === 1 ? count - 1 : count));
        }
      } finally {
        await resetCodexHistoryScans();
        rmSync(root, { recursive: true, force: true });
      }
    }, 10_000);
  }
});
