import { describe, expect, it } from "bun:test";
import { handleBoardRequest, type BoardRun } from "./board-routes.ts";

const post = (body: unknown) => new Request("http://ovis.test/api/board/action", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const ok = (stdout: string): BoardRun => ({ code: 0, stdout, stderr: "" });
type Row = Record<string, unknown>;

/**
 * A fake board: records each argument list. `remote list` answers from `tasks`; `remote do approve`
 * follows the board's own rule (finish_line::approve): at a merge it merges only what `seen` names.
 * `between` runs after Ovis's own look and before the board acts, as another client can.
 */
function board(tasks: Row[], reply: BoardRun | null = ok("done"), between?: () => void) {
  const calls: string[][] = [];
  const merged: string[] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (reply === null) return null;
    if (args[0] === "remote" && args[1] === "list") return ok(JSON.stringify({ host: "h", tasks }));
    if (args[0] === "remote" && args[1] === "do") {
      between?.();
      const req = JSON.parse(atob(args[2]!)) as { action: string; id: string; seen: [unknown, unknown] };
      const task = tasks.find((candidate) => candidate["id"] === req.id)!;
      if (task["stage"] === "approval" && (req.seen[0] !== (task["pr"] ?? null) || req.seen[1] !== (task["reviewedHead"] ?? null))) {
        return ok(JSON.stringify({ ok: false, msg: `${req.id} changed while you were asked. Nothing was merged: look at it again, then approve.` }));
      }
      if (task["stage"] === "approval") merged.push(req.id);
      return ok(JSON.stringify({ ok: true, msg: `${req.id}: ${task["stage"] === "approval" ? "merging" : "approved"}` }));
    }
    return reply;
  };
  return { calls, merged, run };
}

const approve = (id: string, stage: string, kind: string, seen: [string | null, string | null]) => post({ action: "approve", id, expect: { stage, kind, seen } });

describe("board routes", () => {
  it("lists the board's tasks with their checkouts, what they ask and what a merge is checked against", async () => {
    const fake = board([
      { id: "ovis/5", state: "done", stage: "approval", title: "A task", msg: "x", worktree: "/w/ovis-5", pr: "https://github.com/o/r/pull/5", reviewedHead: "abc" },
      { id: "ovis/6", state: "blocked", stage: "asks", kind: "permission", title: "Asks" },
      { id: "ovis/7", state: "done", stage: "done", title: "Archived", archivedAt: 5 },
      { junk: true },
    ]);
    const response = (await handleBoardRequest(new Request("http://ovis.test/api/board/tasks"), "/api/board/tasks", fake.run))!;
    expect(fake.calls).toEqual([["remote", "list"]]);
    expect(await response.json()).toEqual({ tasks: [
      { id: "ovis/5", state: "done", stage: "approval", kind: "", title: "A task", worktree: "/w/ovis-5", pr: "https://github.com/o/r/pull/5", reviewedHead: "abc" },
      { id: "ovis/6", state: "blocked", stage: "asks", kind: "permission", title: "Asks", worktree: null, pr: null, reviewedHead: null },
    ] });
  });

  it("runs a checked action as an argument list and says the board's message", async () => {
    const fake = board([], ok("OVS-5: archived. ? has undo, and the archive."));
    const response = (await handleBoardRequest(post({ action: "archive", id: "OVS-5" }), "/api/board/action", fake.run))!;
    expect(fake.calls).toEqual([["archive", "OVS-5"]]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "OVS-5: archived. ? has undo, and the archive." });
    await handleBoardRequest(post({ action: "archive-done", repo: "ovis" }), "/api/board/action", fake.run);
    expect(fake.calls[1]).toEqual(["archive", "--done", "--repo", "ovis"]);
  });

  it("never merges from a plan's or a permission's yes, even when the task moves on after Ovis looked", async () => {
    for (const [stage, kind] of [["plan", ""], ["asks", "permission"]] as const) {
      const task: Row = { id: "ovis/5", state: "idle", stage, kind, title: "T", pr: "https://github.com/o/r/pull/5", reviewedHead: "abc" };
      // another client approves the plan between Ovis's look and the board acting: the task now waits for its merge
      const fake = board([task], undefined, () => { task["stage"] = "approval"; task["kind"] = ""; });
      const response = (await handleBoardRequest(approve("ovis/5", stage, kind, ["https://github.com/o/r/pull/5", "abc"]), "/api/board/action", fake.run))!;
      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/Nothing was merged/);
      expect(fake.merged).toEqual([]);
    }
  });

  it("approves a plan, a permission, and a merge it was shown", async () => {
    const plan = board([{ id: "ovis/5", state: "idle", stage: "plan", title: "T" }]);
    expect((await handleBoardRequest(approve("ovis/5", "plan", "", [null, null]), "/api/board/action", plan.run))!.status).toBe(200);
    const asks = board([{ id: "ovis/6", state: "blocked", stage: "asks", kind: "permission", title: "T" }]);
    expect(await (await handleBoardRequest(approve("ovis/6", "asks", "permission", [null, null]), "/api/board/action", asks.run))!.json()).toEqual({ message: "ovis/6: approved" });
    const merge = board([{ id: "ovis/7", state: "done", stage: "approval", title: "T", pr: "p", reviewedHead: "h" }]);
    expect((await handleBoardRequest(approve("ovis/7", "approval", "", ["p", "h"]), "/api/board/action", merge.run))!.status).toBe(200);
    expect(merge.merged).toEqual(["ovis/7"]);
    // a merge whose pull request or reviewed commit changed since it was shown is the board's to refuse
    const changed = board([{ id: "ovis/8", state: "done", stage: "approval", title: "T", pr: "p", reviewedHead: "new" }]);
    expect((await handleBoardRequest(approve("ovis/8", "approval", "", ["p", "old"]), "/api/board/action", changed.run))!.status).toBe(422);
    expect(changed.merged).toEqual([]);
  });

  it("says early, without asking the board to act, when the task already moved on", async () => {
    const moved = board([{ id: "ovis/5", state: "done", stage: "approval", title: "T" }]);
    const stale = (await handleBoardRequest(approve("ovis/5", "plan", "", [null, null]), "/api/board/action", moved.run))!;
    expect(stale.status).toBe(409);
    expect(moved.calls).toEqual([["remote", "list"]]);
    // an approve that names no step is refused before the board is asked anything
    const bare = board([]);
    expect((await handleBoardRequest(post({ action: "approve", id: "ovis/6" }), "/api/board/action", bare.run))!.status).toBe(400);
    expect(bare.calls).toEqual([]);
  });

  it("never runs the board for a bad id or action", async () => {
    const fake = board([]);
    for (const body of [{ action: "archive", id: "--done" }, { action: "archive", id: "ovis/5; rm -rf ~" }, { action: "tell", id: "ovis/5" }, { action: "archive-done", repo: "--on" }]) {
      const response = (await handleBoardRequest(post(body), "/api/board/action", fake.run))!;
      expect(response.status).toBe(400);
    }
    expect((await handleBoardRequest(new Request("http://ovis.test/api/board/action"), "/api/board/action", fake.run))!.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("passes the board's refusal on in its own words", async () => {
    const response = (await handleBoardRequest(post({ action: "stop", id: "ovis/99" }), "/api/board/action", board([], { code: 1, stdout: "", stderr: "No task ovis/99" }).run))!;
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: "board_refused", message: "No task ovis/99" } });
  });

  it("answers 404 where the board is not installed, and leaves other paths alone", async () => {
    expect((await handleBoardRequest(new Request("http://ovis.test/api/board/tasks"), "/api/board/tasks", board([], null).run))!.status).toBe(404);
    expect(await handleBoardRequest(new Request("http://ovis.test/api/other"), "/api/other", board([], null).run)).toBeNull();
  });
});
