import { describe, expect, it, spyOn } from "bun:test";
import * as files from "node:fs/promises";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { codexToolActivityConflict, matchCodexToolActivity, matchCodexToolHistories } from "./codex-tool-match.ts";
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
      const slow = screenCount === 4 && total === 32 && !warmed;
      const originalOpen = files.open;
      const opened = spyOn(files, "open");
      if (slow) opened.mockImplementation(async (...args) => {
        await Bun.sleep(10); // fixed wait: model the reviewer's asynchronous filesystem latency.
        return originalOpen(...args);
      });
      try {
        await resetCodexHistoryScans();
        for (const entry of candidates) writeFileSync(entry.path, entry.text);
        if (warmed) for (const shown of screens) expect(await peers(shown)).toBe(total - 1);
        opened.mockClear();
        const rounds: number[][] = [];
        for (let round = 0; round < (slow || screenCount > 4 ? 20 : 5); round++) {
          rounds.push(await Promise.all(screens.map(peers)));
          if (slow) {
            if (rounds.at(-1)!.every((count) => count === total - 1)) break;
            await Bun.sleep(2000); // fixed wait: preserve the client's two-second retry cadence from the review probe.
          }
        }
        const firstComplete = screens.map((_, index) => rounds.findIndex((round) => round[index] === total - 1) + 1);
        console.log(JSON.stringify({ case: "overlapping tool lookups", screenCount, total, warmed, firstComplete, cleared: screenCount <= 4 ? rounds : undefined }));
        const complete = Array.from({ length: screenCount }, () => total - 1);
        expect(firstComplete.every((round) => round > 0)).toBe(true);
        if (warmed) expect(opened).not.toHaveBeenCalled();
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
        opened.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    }, screenCount === 4 && total === 32 && !warmed ? 50_000 : 10_000);
  }

  it("reuses peer evidence as tool screens change, and resets its history index", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-tool-screen-cache-")), path = join(root, "peer.jsonl");
    const shown = (index: number) => screen.replaceAll("/work/integration", `/work/cache-owner-${index}`);
    const conflict = (index: number) => codexToolActivityConflict({ screen: shown(index), segments: [{ path, end: statSync(path).size }] });
    const opened = spyOn(files, "open");
    try {
      writeFileSync(path, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Ran 1 test across 1 file. Check && true; A & B; &#97 and &unfinished." } }) + "\n");
      for (let index = 0; index < 70; index++) expect(await conflict(index)).toBe(false);
      opened.mockClear();
      expect(await conflict(69)).toBe(false);
      expect(opened).not.toHaveBeenCalled();
      expect(await conflict(0)).toBe(false);
      expect(opened).not.toHaveBeenCalled();
      await resetCodexHistoryScans();
      opened.mockClear();
      expect(await conflict(69)).toBe(false);
      expect(await conflict(0)).toBe(false);
      expect(opened).toHaveBeenCalledTimes(2);
    } finally {
      await resetCodexHistoryScans();
      opened.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finishes a large peer index even when no request repeats a tool screen", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-tool-moving-screen-")), path = join(root, "peer.jsonl");
    const filler = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Ran 1 test across 1 file. Unrelated archive && true. ".repeat(60_000) } }) + "\n";
    const changing = (sequence: number) => screen.replaceAll("/work/integration", `/work/running-${sequence}`);
    try {
      writeFileSync(path, filler.repeat(64));
      await resetCodexHistoryScans();
      let sequence = 0, refused = true;
      const started = performance.now();
      while (refused && performance.now() - started < 10_000) {
        appendFileSync(path, JSON.stringify({ type: "event_msg", payload: { type: "token_count", sequence } }) + "\n");
        refused = await codexToolActivityConflict({ screen: changing(sequence++), segments: [{ path, end: statSync(path).size }] });
        await setImmediate();
      }
      expect(sequence).toBeGreaterThan(1);
      expect(refused).toBe(false);
      expect(await codexToolActivityConflict({ screen: changing(sequence++), segments: [{ path, end: statSync(path).size }] })).toBe(false);
      appendFileSync(path, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: changing(sequence) } }) + "\n");
      expect(await codexToolActivityConflict({ screen: changing(sequence), segments: [{ path, end: statSync(path).size }] })).toBe(true);
    } finally { await resetCodexHistoryScans(); rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it("recovers repeated native commands separated by metadata while the screen advances", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-tool-repeated-")), path = join(root, "own.jsonl");
    const output = (sequence: number) => outputs[0]! + ` Iteration ${sequence} complete.`;
    const completed = (sequence: number) => JSON.stringify({ ...events[0], payload: { ...events[0]!.payload, item: {
      ...events[0]!.payload.item, id: `repeat-${sequence}`, aggregated_output: output(sequence),
    } } }) + "\n" + JSON.stringify({ type: "event_msg", payload: { type: "token_count", sequence } }) + "\n";
    const shown = (sequence: number) => screen.replace(commands[1]!, commands[0]!)
      .replace(outputs[0]!, output(sequence - 1)).replace(outputs[1]!, output(sequence));
    const read = (sequence: number) => matchCodexToolHistories({ screen: shown(sequence), candidates: [{ path, segments: [{ path, end: statSync(path).size }] }] });
    const opened = spyOn(files, "open");
    try {
      writeFileSync(path, Array.from({ length: 1201 }, (_, sequence) => completed(sequence)).join(""));
      const until = performance.now() + 10_000;
      while (await read(1200) !== path) {
        expect(performance.now()).toBeLessThan(until);
        await setImmediate();
      }
      for (let sequence = 1201; sequence <= 1212; sequence++) {
        appendFileSync(path, completed(sequence));
        opened.mockClear();
        const start = performance.now(), owner = await read(sequence);
        console.log(JSON.stringify({ case: "interleaved repeated commands", sequence, owner: owner === path,
          ms: Math.round(performance.now() - start), opens: opened.mock.calls.length }));
        expect(owner).toBe(path);
        expect(opened.mock.calls.length).toBeLessThanOrEqual(4);
        await setImmediate();
      }
      const peer = join(root, "peer.jsonl");
      writeFileSync(peer, completed(1211) + completed(1212));
      expect(await matchCodexToolHistories({ screen: shown(1212), candidates: [path, peer].map((path) => ({ path, segments: [{ path, end: statSync(path).size }] })) })).toBeNull();
    } finally { await resetCodexHistoryScans(); opened.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it("batches contiguous quote candidates with shared long command prefixes as output changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-tool-quote-ranges-")), path = join(root, "peer.jsonl");
    const long = "bun run verify --project /work/" + "shared-command-prefix/".repeat(8);
    const quotation = body.replaceAll(commands[0]!, long + "one").replaceAll(commands[1]!, long + "two");
    const changing = (sequence: number) => screen.replaceAll(commands[0]!, long + "one").replaceAll(commands[1]!, long + "two")
      .replace(outputs[0]!, outputs[0]! + ` iteration ${sequence}`).replace(outputs[1]!, outputs[1]! + ` iteration ${sequence}`);
    const conflict = (sequence: number) => codexToolActivityConflict({ screen: changing(sequence), segments: [{ path, end: statSync(path).size }] });
    const opened = spyOn(files, "open");
    try {
      writeFileSync(path, (JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: quotation } }) + "\n").repeat(1200));
      const until = performance.now() + 10_000;
      while (await conflict(0)) {
        expect(performance.now()).toBeLessThan(until);
        await setImmediate();
      }
      for (let sequence = 1; sequence <= 4; sequence++) {
        opened.mockClear();
        expect(await conflict(sequence)).toBe(false);
        expect(opened.mock.calls.length).toBeLessThanOrEqual(2);
      }
      appendFileSync(path, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: changing(5) } }) + "\n");
      expect(await conflict(5)).toBe(true);
    } finally { await resetCodexHistoryScans(); opened.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it("checks indexed native outputs and encoded quotes with the same exact rules as complete histories", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-tool-index-"));
    const padding = JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "padding", output: "é🙂".repeat(30_000) } }) + "\n";
    const quoted = (message: string) => JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message } }) + "\n";
    const histories = [candidate.text, quoted(body), quoted(body.replaceAll("Ran", "R&#97;n")), quoted(body.replaceAll("Ran", "&#82;&#x61;&nopf;")),
      quoted(body.replaceAll("Ran", "Ｒａｎ")), quoted(body.replaceAll("bun", "ｂｕｎ")), quoted("Ran"), quoted("Ran 1 test across 1 file."), quoted(outputs.join("\n")),
      candidate.text.replaceAll("/work/integration", "/work/unrelated")];
    try {
      const own = join(root, "own.jsonl");
      writeFileSync(own, candidate.text);
      for (const [at, text] of histories.entries()) {
        const path = join(root, `${at}.jsonl`);
        writeFileSync(path, padding + text);
        for (const shown of [screen, screen.replace(commands[0]!, "bun run verify…").replace(commands[1]!, "git diff…")]) {
          const conflict = await codexToolActivityConflict({ screen: shown, segments: [{ path, end: statSync(path).size }] });
          expect(conflict).toBe(resolve(shown, [candidate, { path: "peer", text }]) === null);
          const owner = await matchCodexToolHistories({ screen: shown, candidates: [own, path].map((path) => ({ path, segments: [{ path, end: statSync(path).size }] })) });
          expect(owner).toBe(conflict ? null : own);
        }
      }
    } finally { await resetCodexHistoryScans(); rmSync(root, { recursive: true, force: true }); }
  });

  it("does not leave a quoted pending call unresolved when its unquoted completion was omitted", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-tool-index-pending-")), path = join(root, "peer.jsonl");
    const call = JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "legacy", name: "exec_command", arguments: JSON.stringify({ command: commands[0], note: "Ran unrelated command" }) } }) + "\n";
    const completed = JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "legacy", output: "Done." } }) + "\n";
    const read = () => codexToolActivityConflict({ screen, segments: [{ path, end: statSync(path).size }] });
    try {
      writeFileSync(path, call);
      expect(await read()).toBe(true);
      appendFileSync(path, completed);
      expect(await read()).toBe(false);
      const native = { ...events[0]!, payload: { type: "item_started", item: { ...events[0]!.payload.item, status: "in_progress", aggregated_output: "" } } };
      appendFileSync(path, JSON.stringify(native) + "\n");
      expect(await read()).toBe(true);
      appendFileSync(path, JSON.stringify(events[0]) + "\n");
      expect(await read()).toBe(false);
      appendFileSync(path, JSON.stringify(events[1]) + "\n");
      expect(await read()).toBe(true);
    } finally { await resetCodexHistoryScans(); rmSync(root, { recursive: true, force: true }); }
  });
});
