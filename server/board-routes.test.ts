import { describe, expect, it } from "bun:test";
import { handleBoardRequest, type BoardRun } from "./board-routes.ts";

const post = (body: unknown) => new Request("http://ovis.test/api/board/action", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const ok = (stdout: string): BoardRun => ({ code: 0, stdout, stderr: "" });

/** a fake board: records each argument list; `list` and `details` answer from `tasks`, anything else with `reply` */
function board(tasks: Record<string, unknown>[], reply: BoardRun | null = ok("done")) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (reply === null) return null;
    if (args[0] === "list") return ok(JSON.stringify(tasks.map(({ worktree: _, ...row }) => row)));
    if (args[0] === "details") {
      const task = tasks.find((candidate) => candidate["id"] === args[1]);
      return task ? ok(JSON.stringify({ task: { id: task["id"] }, worktree: task["worktree"] ?? null })) : { code: 1, stdout: "", stderr: `No task ${args[1]}` };
    }
    return reply;
  };
  return { calls, run };
}

describe("board routes", () => {
  it("lists the board's tasks with their checkouts and what they ask", async () => {
    const fake = board([
      { id: "ovis/5", state: "done", stage: "done", title: "A task", msg: "x", worktree: "/w/ovis-5" },
      { id: "ovis/6", state: "blocked", stage: "asks", kind: "permission", title: "Asks" },
      { junk: true },
    ]);
    const response = (await handleBoardRequest(new Request("http://ovis.test/api/board/tasks"), "/api/board/tasks", fake.run))!;
    expect(fake.calls).toEqual([["list", "--json"], ["details", "ovis/5", "--json"], ["details", "ovis/6", "--json"]]);
    expect(await response.json()).toEqual({ tasks: [
      { id: "ovis/5", state: "done", stage: "done", kind: "", title: "A task", worktree: "/w/ovis-5" },
      { id: "ovis/6", state: "blocked", stage: "asks", kind: "permission", title: "Asks", worktree: null },
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

  it("approves only where the task still stands as it was shown", async () => {
    // shown at its plan, but another client moved it on to a merge: no approve is run
    const moved = board([{ id: "ovis/5", state: "done", stage: "approval", title: "T" }]);
    const stale = (await handleBoardRequest(post({ action: "approve", id: "ovis/5", expect: { stage: "plan", kind: "" } }), "/api/board/action", moved.run))!;
    expect(stale.status).toBe(409);
    expect(moved.calls.some((args) => args[0] === "approve")).toBe(false);
    // a permission it still asks for is approved
    const asks = board([{ id: "ovis/6", state: "blocked", stage: "asks", kind: "permission", title: "T" }]);
    const allowed = (await handleBoardRequest(post({ action: "approve", id: "ovis/6", expect: { stage: "asks", kind: "permission" } }), "/api/board/action", asks.run))!;
    expect(allowed.status).toBe(200);
    expect(asks.calls.at(-1)).toEqual(["approve", "ovis/6"]);
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
