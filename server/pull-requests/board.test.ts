import { describe, expect, it } from "bun:test";
import type { BoardRunner } from "../board-routes.ts";
import { boardPrContext } from "./board.ts";

const task = { id: "api/1", worktree: "/w/task", branch: "work/one", pr: "https://github.com/acme/api/pull/1", created: Date.parse("2026-10-28T09:00:00Z"), archivedAt: null };
const answer = (tasks: unknown[]): BoardRunner => async () => ({ code: 0, stdout: JSON.stringify({ tasks }), stderr: "" });

describe("board PR ownership", () => {
  it("uses the exact checkout and the task's original creation time", async () => {
    const run = answer([task]);
    const read = (cwd: string) => boardPrContext({ cwd, run, fresh: false, now: 100 });
    expect(await read("/w/task/")).toEqual({ id: task.id, worktree: task.worktree, branch: task.branch, pr: task.pr, started_at: "2026-10-28T09:00:00.000Z" });
    expect(await read("/w/task-other")).toBeNull();
    expect(await read("/w/other")).toBeNull();
  });

  it("rejects duplicate owners and archived tasks", async () => {
    expect(await boardPrContext({ cwd: "/w/task", run: answer([task, { ...task, id: "api/2" }]), fresh: false, now: 0 })).toBeNull();
    expect(await boardPrContext({ cwd: "/w/task", run: answer([{ ...task, archivedAt: 1 }]), fresh: false, now: 0 })).toBeNull();
  });

  it("accepts tasks without a PR yet and ignores malformed unrelated tasks", async () => {
    const { pr: _pr, ...unfinished } = task;
    const run = answer([{ id: "api/new" }, { id: "api/bad", pr: 42 }, unfinished]);
    expect(await boardPrContext({ cwd: "/w/task", run, fresh: true, now: 0 })).toMatchObject({ id: task.id, pr: null, branch: task.branch });
    expect((await boardPrContext({ cwd: "/w/task", run: answer([{ id: "api/new" }, task]), fresh: true, now: 0 }))?.pr).toBe(task.pr);
  });

  it("shares one board read, refreshes after a minute, and separates runners", async () => {
    const calls: string[][] = [];
    let pr = task.pr;
    const run: BoardRunner = async (args) => { calls.push(args); return { code: 0, stdout: JSON.stringify({ tasks: [{ ...task, pr }] }), stderr: "" }; };
    const read = (now: number, fresh = false) => boardPrContext({ cwd: "/w/task", run, now, fresh });
    await Promise.all([read(0), read(0)]);
    expect(calls).toEqual([["remote", "list"]]);
    pr = "https://github.com/acme/api/pull/2";
    expect((await read(59_999))?.pr).toBe(task.pr);
    expect((await read(60_001))?.pr).toBe(pr);
    pr = task.pr;
    expect((await read(60_002, true))?.pr).toBe(pr);
    expect(await boardPrContext({ cwd: "/w/task", run: answer([]), now: 0, fresh: false })).toBeNull();
  });

  it("treats missing, refused, invalid and incomplete answers as no ownership", async () => {
    const runners: BoardRunner[] = [async () => null, async () => { throw new Error("unavailable"); }, async () => ({ code: 1, stdout: "", stderr: "no board" }),
      async () => ({ code: 0, stdout: "not JSON", stderr: "" }), answer([{ ...task, pr: "https://example.test/pull/1" }]), answer([{ ...task, created: "yesterday" }])];
    for (const run of runners) expect(await boardPrContext({ cwd: "/w/task", run, fresh: false, now: 0 })).toBeNull();
  });
});
