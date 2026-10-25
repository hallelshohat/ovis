import { describe, expect, it } from "bun:test";
import { handleBoardRequest, type BoardRun } from "./board-routes.ts";

const post = (body: unknown) => new Request("http://ovis.test/api/board/action", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

/** a fake board: records each argument list and answers with `reply` */
function board(reply: BoardRun | null) {
  const calls: string[][] = [];
  return { calls, run: async (args: string[]) => { calls.push(args); return reply; } };
}

describe("board routes", () => {
  it("lists the board's tasks with the fields the sidebar reads", async () => {
    const fake = board({ code: 0, stderr: "", stdout: JSON.stringify([{ id: "ovis/5", state: "done", stage: "done", title: "A task", msg: "x" }, { junk: true }]) });
    const response = (await handleBoardRequest(new Request("http://ovis.test/api/board/tasks"), "/api/board/tasks", fake.run))!;
    expect(fake.calls).toEqual([["list", "--json"]]);
    expect(await response.json()).toEqual({ tasks: [{ id: "ovis/5", state: "done", stage: "done", title: "A task" }] });
  });

  it("runs a checked action as an argument list and says the board's message", async () => {
    const fake = board({ code: 0, stdout: "OVS-5: archived. ? has undo, and the archive.", stderr: "" });
    const response = (await handleBoardRequest(post({ action: "archive", id: "OVS-5" }), "/api/board/action", fake.run))!;
    expect(fake.calls).toEqual([["archive", "OVS-5"]]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "OVS-5: archived. ? has undo, and the archive." });
    await handleBoardRequest(post({ action: "archive-done", repo: "ovis" }), "/api/board/action", fake.run);
    expect(fake.calls[1]).toEqual(["archive", "--done", "--repo", "ovis"]);
  });

  it("never runs the board for a bad id or action", async () => {
    const fake = board({ code: 0, stdout: "", stderr: "" });
    for (const body of [{ action: "archive", id: "--done" }, { action: "archive", id: "ovis/5; rm -rf ~" }, { action: "tell", id: "ovis/5" }, { action: "archive-done", repo: "--on" }]) {
      const response = (await handleBoardRequest(post(body), "/api/board/action", fake.run))!;
      expect(response.status).toBe(400);
    }
    expect((await handleBoardRequest(new Request("http://ovis.test/api/board/action"), "/api/board/action", fake.run))!.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("passes the board's refusal on in its own words", async () => {
    const response = (await handleBoardRequest(post({ action: "stop", id: "ovis/99" }), "/api/board/action", board({ code: 1, stdout: "", stderr: "No task ovis/99" }).run))!;
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: "board_refused", message: "No task ovis/99" } });
  });

  it("answers 404 where the board is not installed, and leaves other paths alone", async () => {
    expect((await handleBoardRequest(new Request("http://ovis.test/api/board/tasks"), "/api/board/tasks", board(null).run))!.status).toBe(404);
    expect(await handleBoardRequest(new Request("http://ovis.test/api/other"), "/api/other", board(null).run)).toBeNull();
  });
});
