import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexBackgroundState, codexBackgroundTasks, codexSessionOutput, feedCodexLine, readCodexBackground } from "./codex-background.ts";

// Codex rollout records as rust-v0.16x writes them: a native `exec_command` function call, or an
// `exec` script cell (custom_tool_call) that calls tools.exec_command / tools.write_stdin.
const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const at = (seconds: number): string => new Date(NOW - 60_000 + seconds * 1000).toISOString();
const line = (seconds: number, payload: Record<string, unknown>): string => JSON.stringify({ timestamp: at(seconds), type: "response_item", payload });
const nativeCall = (s: number, id: string, cmd: string) => line(s, { type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({ cmd, yield_time_ms: 10000 }) });
const poll = (s: number, id: string, session: number) => line(s, { type: "function_call", name: "write_stdin", call_id: id, arguments: JSON.stringify({ session_id: session, chars: "" }) });
const answer = (s: number, id: string, output: string) => line(s, { type: "function_call_output", call_id: id, output });
const script = (s: number, id: string, input: string) => line(s, { type: "custom_tool_call", name: "exec", call_id: id, input });
const scriptAnswer = (s: number, id: string, ...objects: object[]) => line(s, { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text: "Script completed\nOutput:\n" }, ...objects.map((object) => ({ type: "input_text", text: JSON.stringify(object) }))] });

const feed = (lines: string[]) => {
  const state = codexBackgroundState();
  for (const each of lines) feedCodexLine(state, each);
  return state;
};

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Recorded with Codex 0.166.0 in an isolated session; local paths and model metadata removed.
const unpolled = readFileSync(join(import.meta.dir, "fixtures/codex-background/0.166.0-unpolled.jsonl"), "utf8").trimEnd().split("\n");
const recordedNow = Date.parse("2026-11-08T12:34:00.000Z");
const recordedSecond = (timestamp: string): number => (Date.parse(timestamp) - Date.parse(at(0))) / 1000;
// Adapted recording: reuse the foreground ID, move its completion earlier, and add the optional
// start event. The new command/exit 7 come from the recorded failure; no random collision is claimed.
const reused = readFileSync(join(import.meta.dir, "fixtures/codex-background/0.166.0-reused-process-id.jsonl"), "utf8").trimEnd().split("\n");
const reusedLater = reused.map((record) => record.replaceAll("12:31", "12:32").replaceAll("179414107", "179414113"));

describe("Codex background exec sessions", () => {
  it.each([true, false])("keeps a reused foreground ID running until its own exit 7 (start event: %s)", (withStart) => {
    const state = feed(reused.slice(0, 4).filter((_record, index) => withStart || index !== 2));
    expect(codexBackgroundTasks(state, true, recordedNow)).toMatchObject([
      { id: "exec-41401", status: "running", exit_code: null, ended_at: null },
    ]);
    feedCodexLine(state, reused[0]!);
    expect(codexBackgroundTasks(state, true, recordedNow)[0]?.status).toBe("running");
    feedCodexLine(state, reused[4]!);
    const task = codexBackgroundTasks(state, true, recordedNow)[0]!;
    expect(task).toMatchObject({ status: "failed", exit_code: 7, ended_at: "2026-11-08T12:31:17.470Z" });
    expect(Date.parse(task.ended_at!)).toBeGreaterThanOrEqual(Date.parse(task.started_at!));
    feedCodexLine(state, reused[0]!);
    expect(codexBackgroundTasks(state, true, recordedNow)[0]).toEqual(task);
  });

  it.each([true, false])("starts fresh when a completed background process ID is reused (start event: %s)", (withStart) => {
    const polledAt = recordedSecond("2026-11-08T12:31:20.000Z");
    const state = feed([...unpolled.slice(0, 3), poll(polledAt, "old-output", 41401), answer(polledAt + 1, "old-output", "Process exited with code 0\nOutput:\nOLD OUTPUT\n")]);
    expect(codexSessionOutput(state, "exec-41401", null)?.text).toBe("OLD OUTPUT\n");
    for (const record of reusedLater.slice(1, 4).filter((_record, index) => withStart || index !== 1)) feedCodexLine(state, record);
    expect(codexBackgroundTasks(state, true, recordedNow)).toMatchObject([{ status: "running", exit_code: null, ended_at: null }]);
    expect(codexSessionOutput(state, "exec-41401", null)?.text).toBe("");
    feedCodexLine(state, unpolled[2]!);
    expect(codexBackgroundTasks(state, true, recordedNow)[0]?.status).toBe("running");
    feedCodexLine(state, reusedLater[4]!);
    expect(codexBackgroundTasks(state, true, recordedNow)).toMatchObject([{ status: "failed", exit_code: 7 }]);
  });

  it("does not apply a late old poll response to a replacement command", () => {
    const polledAt = recordedSecond("2026-11-08T12:31:16.000Z");
    const state = feed([...unpolled.slice(0, 2), poll(polledAt, "old-poll", 41401), unpolled[2]!, ...reusedLater.slice(1, 4)]);
    feedCodexLine(state, answer(polledAt + 60, "old-poll", "Process exited with code 0\nOutput:\nOLD POLL\n"));
    expect(codexBackgroundTasks(state, true, recordedNow)).toMatchObject([{ status: "running", exit_code: null }]);
    expect(codexSessionOutput(state, "exec-41401", null)?.text).toBe("");
    feedCodexLine(state, reusedLater[4]!);
    expect(codexBackgroundTasks(state, true, recordedNow)[0]?.exit_code).toBe(7);
  });

  it("does not mistake a poll with a dynamic session argument for a new exec", () => {
    const state = feed(reused.slice(1, 4));
    const polledAt = recordedSecond("2026-11-08T12:31:16.000Z");
    const before = codexBackgroundTasks(state, true, recordedNow);
    feedCodexLine(state, script(polledAt, "dynamic-poll", 'text(await tools.write_stdin({session_id: activeSession, chars:""}));'));
    feedCodexLine(state, scriptAnswer(polledAt + 0.1, "dynamic-poll", { session_id: 41401, output: "" }));
    expect(codexBackgroundTasks(state, true, recordedNow)).toEqual(before);
    feedCodexLine(state, reused[4]!);
    expect(codexBackgroundTasks(state, true, recordedNow)[0]?.exit_code).toBe(7);
  });

  it("reads reused-ID discovery and failure incrementally from the rollout", () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-codex-reused-id-"));
    roots.push(root);
    const path = join(root, "rollout.jsonl");
    writeFileSync(path, `${reused.slice(0, 4).join("\n")}\n`);
    expect(codexBackgroundTasks(readCodexBackground(path)!, true, recordedNow)).toMatchObject([{ status: "running", exit_code: null }]);
    appendFileSync(path, `${reused[4]}\n`);
    expect(codexBackgroundTasks(readCodexBackground(path)!, true, recordedNow)).toMatchObject([{ status: "failed", exit_code: 7 }]);
  });

  it("keeps an identifiable completion that precedes a delayed script response", () => {
    const state = feed([reused[0]!, reused[1]!, reused[4]!, reused[3]!.replace("12:31:15.579", "12:31:20.579")]);
    const task = codexBackgroundTasks(state, true, recordedNow)[0]!;
    expect(task).toMatchObject({ status: "failed", exit_code: 7, ended_at: "2026-11-08T12:31:17.470Z" });
    expect(Date.parse(task.started_at!)).toBeLessThanOrEqual(Date.parse(task.ended_at!));
  });

  it("does not guess that a mixed script's foreground completion belongs to its background command", () => {
    const old = reused[0]!.replace("12:30:00.000", "12:32:58.339").replaceAll("1794141000000", "1794141178339");
    const state = feed([unpolled[3]!, old, unpolled[5]!.replace("46402", "41401")]);
    expect(codexBackgroundTasks(state, true, recordedNow)).toMatchObject([{ status: "running", exit_code: null, ended_at: null }]);
    feedCodexLine(state, unpolled[6]!.replace('"process_id":"46402"', '"process_id":"41401"'));
    expect(codexBackgroundTasks(state, true, recordedNow)).toMatchObject([{ status: "failed", exit_code: 7 }]);
  });

  it("does not reuse an early completion for a second background command in the same script", () => {
    const started = recordedSecond("2026-11-08T12:31:14.000Z");
    const state = feed([
      script(started, "twice", 'text(await tools.exec_command({cmd:"first"})); text(await tools.exec_command({cmd:"second"}));'),
      unpolled[2]!,
      scriptAnswer(started + 6, "twice", { session_id: 41401, output: "OLD OUTPUT\n" }, { session_id: 41401, output: "NEW OUTPUT\n" }),
    ]);
    expect(codexBackgroundTasks(state, true, recordedNow)).toMatchObject([{ title: "second", status: "running", exit_code: null }]);
    expect(codexSessionOutput(state, "exec-41401", null)?.text).toBe("NEW OUTPUT\n");
    const completion = reused[4]!.replace("12:31:17.470", "12:31:21.470")
      .replace("1794141074576", "1794141078576").replace("1794141077470", "1794141081470");
    feedCodexLine(state, completion);
    expect(codexBackgroundTasks(state, true, recordedNow)).toMatchObject([{ status: "failed", exit_code: 7 }]);
  });

  it.each([
    ['"started_at_ms":1794141074576', '"started_at_ms":"1794141074576"'],
    ['"started_at_ms":1794141074576,', ""],
    ['"completed_at_ms":1794141077470', '"completed_at_ms":1794141000000'],
  ])("ignores invalid completion timing %s", (from, to) => {
    const state = feed([reused[1]!, reused[3]!, reused[4]!.replace(from, to)]);
    expect(codexBackgroundTasks(state, true, recordedNow)[0]?.status).toBe("running");
    feedCodexLine(state, reused[4]!);
    expect(codexBackgroundTasks(state, true, recordedNow)[0]?.exit_code).toBe(7);
  });

  it("finishes recorded unpolled commands from native completion events without listing foreground commands", () => {
    const tasks = codexBackgroundTasks(feed(unpolled), true, recordedNow);
    expect(tasks).toMatchObject([
      { id: "exec-46402", status: "failed", exit_code: 7, ended_at: "2026-11-08T12:33:01.387Z" },
      { id: "exec-41401", status: "completed", exit_code: 0, ended_at: "2026-11-08T12:31:17.470Z" },
    ]);
    expect(tasks).toHaveLength(2);
  });

  it("reads native completion appended after the background session was discovered", () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-codex-native-bg-"));
    roots.push(root);
    const path = join(root, "rollout.jsonl");
    writeFileSync(path, `${unpolled.slice(0, 2).join("\n")}\n`);
    expect(codexBackgroundTasks(readCodexBackground(path)!, true, recordedNow)).toMatchObject([{ id: "exec-41401", status: "running" }]);
    appendFileSync(path, `${unpolled[2]}\n`);
    expect(codexBackgroundTasks(readCodexBackground(path)!, true, recordedNow)).toMatchObject([{ id: "exec-41401", status: "completed", exit_code: 0 }]);
  });

  it("remembers a native completion before the script response without inventing a background task", () => {
    const state = feed([unpolled[0]!, unpolled[2]!]);
    expect(codexBackgroundTasks(state, true, recordedNow)).toEqual([]);
    feedCodexLine(state, unpolled[1]!);
    expect(codexBackgroundTasks(state, true, recordedNow)).toMatchObject([{ id: "exec-41401", status: "completed", exit_code: 0 }]);
  });

  it("ends only the named background process while another keeps running", () => {
    const state = feed([unpolled[0]!, unpolled[1]!, ...unpolled.slice(3, 6)]);
    expect(codexBackgroundTasks(state, true, recordedNow).map((task) => task.status)).toEqual(["running", "running"]);
    feedCodexLine(state, unpolled[2]!);
    expect(codexBackgroundTasks(state, true, recordedNow)).toMatchObject([
      { id: "exec-46402", status: "running" }, { id: "exec-41401", status: "completed" },
    ]);
  });

  it("keeps completion and polled output when native events and later polls describe the same process", () => {
    const state = feed(unpolled);
    const before = codexBackgroundTasks(state, true, recordedNow);
    const late = (recordedNow - Date.parse(at(0))) / 1000;
    const calls = [poll(late, "late", 46402), answer(late, "late", "Process exited with code 7\nOutput:\nOVS26_FAILED\n")];
    for (const each of calls) feedCodexLine(state, each);
    feedCodexLine(state, unpolled[6]!);
    expect(codexBackgroundTasks(state, true, recordedNow)).toEqual(before);
    expect(codexSessionOutput(state, "exec-46402", null)?.text).toBe("OVS26_FAILED\n");
    const polled = feed([...unpolled.slice(0, 6), ...calls, unpolled[6]!]);
    expect(codexBackgroundTasks(polled, true, recordedNow)).toMatchObject([
      { id: "exec-46402", status: "failed", exit_code: 7 }, { id: "exec-41401", status: "completed", exit_code: 0 },
    ]);
    expect(codexSessionOutput(polled, "exec-46402", null)?.text).toBe("OVS26_FAILED\n");
  });

  it.each([
    ["in-progress command", unpolled[2]!.replace('"status":"completed"', '"status":"in_progress"')],
    ["missing exit code", unpolled[2]!.replace('"exit_code":0', '"exit_code":null')],
    ["invalid exit code", unpolled[2]!.replace('"exit_code":0', '"exit_code":"0"')],
    ["missing process ID", unpolled[2]!.replace('"process_id":"41401",', "")],
    ["unrelated process", unpolled[2]!.replace('"process_id":"41401"', '"process_id":"other"')],
    ["unrelated item", unpolled[2]!.replace('"type":"CommandExecution"', '"type":"FileChange"')],
    ["non-event record", unpolled[2]!.replace('"type":"event_msg"', '"type":"response_item"')],
    ["partial record", unpolled[2]!.slice(0, -1)],
  ])("does not infer completion from %s", (_name, completion) => {
    const state = feed([...unpolled.slice(0, 2), completion]);
    expect(codexBackgroundTasks(state, true, recordedNow)).toMatchObject([{ id: "exec-41401", status: "running", exit_code: null }]);
  });

  it("lists a native exec session as running, then completed with its exit code and output", () => {
    const lines = [
      nativeCall(1, "c1", "bun run build"),
      answer(11, "c1", "Chunk ID: a\nWall time: 10.0 seconds\nProcess running with session ID 4242\nOutput:\nbuilding…\n"),
    ];
    expect(codexBackgroundTasks(feed(lines), true, NOW)).toMatchObject([{ id: "exec-4242", kind: "exec", title: "bun run build", command: "bun run build", status: "running", started_at: at(11), detail_kind: "output", exit_code: null }]);
    lines.push(poll(20, "c2", 4242), answer(21, "c2", "Chunk ID: b\nProcess exited with code 0\nOutput:\ndone\n"));
    const state = feed(lines);
    expect(codexBackgroundTasks(state, true, NOW)).toMatchObject([{ status: "completed", exit_code: 0, ended_at: at(21) }]);
    expect(codexSessionOutput(state, "exec-4242", null)?.text).toBe("building…\ndone\n");
  });

  it("fails a session that exited non-zero", () => {
    const state = feed([
      script(1, "s1", 'const r = await tools.exec_command({cmd:"pytest -x","yield_time_ms":1000}); text(r);'),
      scriptAnswer(2, "s1", { chunk_id: "a", session_id: 77, output: "collecting\n" }),
      script(5, "s2", "text(await tools.write_stdin({session_id:77,chars:\"\"}));"),
      scriptAnswer(6, "s2", { chunk_id: "b", exit_code: 1, output: "1 failed\n" }),
    ]);
    expect(codexBackgroundTasks(state, true, NOW)).toMatchObject([{ id: "exec-77", command: "pytest -x", status: "failed", exit_code: 1 }]);
  });

  it("lists each session of a script that started several, each by its own command", () => {
    const state = feed([
      script(1, "s1", 'await Promise.all([tools.exec_command({cmd:"sleep 100"}), tools.exec_command({cmd:"tail -f log"})]);'),
      scriptAnswer(2, "s1", { session_id: 1, output: "" }, { session_id: 2, output: "x\n" }),
    ]);
    expect(codexBackgroundTasks(state, true, NOW).map((task) => [task.id, task.title])).toEqual([["exec-1", "sleep 100"], ["exec-2", "tail -f log"]]);
  });

  it("does not end a session on the exit code of a command the same script started", () => {
    const state = feed([
      nativeCall(1, "c1", "sleep 100"),
      answer(2, "c1", "Process running with session ID 9\nOutput:\n"),
      script(3, "s1", 'text(await tools.write_stdin({session_id:9,chars:""})); text(await tools.exec_command({cmd:"ls"}));'),
      scriptAnswer(4, "s1", { output: "" }, { exit_code: 0, output: "a b\n" }),
    ]);
    expect(codexBackgroundTasks(state, true, NOW)).toMatchObject([{ id: "exec-9", status: "running" }]);
  });

  it("leaves a session never seen to end lost once the pane no longer runs the session", () => {
    const state = feed([nativeCall(1, "c1", "serve"), answer(2, "c1", "Process running with session ID 5\nOutput:\n")]);
    expect(codexBackgroundTasks(state, false, NOW)[0]?.status).toBe("lost");
  });

  it("names a session generically when the answers can't be paired with the calls", () => {
    const state = feed([
      script(1, "s1", 'await Promise.all([tools.exec_command({cmd:"a"}), tools.exec_command({cmd:"b"})]);'),
      scriptAnswer(2, "s1", { session_id: 1, output: "" }),
    ]);
    expect(codexBackgroundTasks(state, true, NOW).map((task) => task.title)).toEqual(["Background command"]);
  });

  it("ignores a command that ended within its first wait", () => {
    expect(codexBackgroundTasks(feed([nativeCall(1, "c1", "ls"), answer(1, "c1", "Process exited with code 0\nOutput:\nx\n")]), true, NOW)).toEqual([]);
  });

  it("reads a rollout on from where it stopped", () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-codex-bg-"));
    roots.push(root);
    const path = join(root, "rollout.jsonl");
    writeFileSync(path, `${nativeCall(1, "c1", "make")}\n${answer(2, "c1", "Process running with session ID 3\nOutput:\none\n")}\n`);
    expect(codexBackgroundTasks(readCodexBackground(path)!, true, NOW)).toMatchObject([{ id: "exec-3", status: "running" }]);
    appendFileSync(path, `${poll(5, "c2", 3)}\n${answer(6, "c2", "Process exited with code 2\nOutput:\ntwo\n")}\n`);
    const state = readCodexBackground(path)!;
    expect(codexBackgroundTasks(state, true, NOW)).toMatchObject([{ status: "failed", exit_code: 2 }]);
    expect(codexSessionOutput(state, "exec-3", 4)?.text).toBe("two\n");
  });
});
