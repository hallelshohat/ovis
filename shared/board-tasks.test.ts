import { describe, expect, it } from "bun:test";
import { boardApproveKind, boardCommand, boardTaskOf, isBoardTaskId, NOT_A_MERGE, type BoardTask } from "./board-tasks.ts";

/** the request inside `remote do <base64>` */
const sent = (args: string[] | null) => { expect(args?.slice(0, 2)).toEqual(["remote", "do"]); return JSON.parse(atob(args![2]!)) as unknown; };

describe("isBoardTaskId", () => {
  it("takes a key and number, or a repo and number", () => {
    for (const id of ["OVS-5", "hp-179", "A1-2", "ovis/5", "herdr-web-ui/12", "my.repo_x/3"]) expect(isBoardTaskId(id)).toBe(true);
  });
  it("refuses flags, paths, shell and anything else", () => {
    for (const id of ["", "5", "O-5", "TOOLONG-5", "OVS-", "OVS-5 ", "-x/5", "--done", "ovis/", "/5", "ovis/5a", "a/b/5", "../5", "ovis/5;rm -rf ~", "OVS-5\n", "$(id)/5"]) expect(isBoardTaskId(id)).toBe(false);
  });
});

describe("boardCommand", () => {
  it("maps each action to the board's arguments", () => {
    expect(boardCommand({ action: "archive", id: "ovis/5" })).toEqual(["archive", "ovis/5"]);
    expect(boardCommand({ action: "restore", id: "OVS-5" })).toEqual(["restore", "OVS-5"]);
    expect(boardCommand({ action: "clear", id: "ovis/5" })).toEqual(["clear", "ovis/5"]);
    expect(boardCommand({ action: "stop", id: "ovis/5" })).toEqual(["stop", "ovis/5"]);
    // a merge's yes carries the pull request and reviewed commit it was shown: the board merges nothing else
    expect(sent(boardCommand({ action: "approve", id: "ovis/5", expect: { stage: "approval", kind: "", seen: ["https://github.com/o/r/pull/3", "abc123"] } })))
      .toEqual({ action: "approve", id: "ovis/5", seen: ["https://github.com/o/r/pull/3", "abc123"] });
    // a plan's or a permission's yes carries a pair the board never holds, so it can never become a merge
    for (const expectation of [{ stage: "plan", kind: "" }, { stage: "asks", kind: "permission" }]) {
      expect(sent(boardCommand({ action: "approve", id: "ovis/5", expect: { ...expectation, seen: ["https://github.com/o/r/pull/3", "abc123"] } })))
        .toEqual({ action: "approve", id: "ovis/5", seen: [NOT_A_MERGE, NOT_A_MERGE] });
    }
    expect(boardCommand({ action: "archive-done" })).toEqual(["archive", "--done"]);
    expect(boardCommand({ action: "archive-done", repo: "ovis" })).toEqual(["archive", "--done", "--repo", "ovis"]);
  });
  it("refuses an unknown action, a bad id or repo, and a non-object", () => {
    expect(boardCommand({ action: "delegate", id: "ovis/5" })).toBeNull();
    expect(boardCommand({ action: "archive", id: "--all" })).toBeNull();
    expect(boardCommand({ action: "archive" })).toBeNull();
    expect(boardCommand({ action: "approve", id: 5, expect: { stage: "plan", kind: "", seen: [null, null] } })).toBeNull();
    expect(boardCommand({ action: "approve", id: "ovis/5", expect: { stage: "approval", kind: "", seen: [null] } })).toBeNull();
    expect(boardCommand({ action: "approve", id: "ovis/5", expect: { stage: "approval", kind: "", seen: [1, 2] } })).toBeNull();
    // an approve that does not say what it was offered for could merge where a plan was shown
    expect(boardCommand({ action: "approve", id: "ovis/5" })).toBeNull();
    expect(boardCommand({ action: "approve", id: "ovis/5", expect: { stage: "plan" } })).toBeNull();
    expect(boardCommand({ action: "archive-done", repo: "--on" })).toBeNull();
    expect(boardCommand({ action: "archive-done", repo: "" })).toBeNull();
    expect(boardCommand(null)).toBeNull();
    expect(boardCommand("archive ovis/5")).toBeNull();
  });
});

describe("boardApproveKind", () => {
  it("says what approve does at each step, and nothing elsewhere", () => {
    expect(boardApproveKind({ stage: "approval", kind: "" })).toBe("merge");
    expect(boardApproveKind({ stage: "plan", kind: "" })).toBe("plan");
    expect(boardApproveKind({ stage: "asks", kind: "permission" })).toBe("permission");
    expect(boardApproveKind({ stage: "asks", kind: "question" })).toBeNull();
    expect(boardApproveKind({ stage: "working", kind: "" })).toBeNull();
  });
});

describe("boardTaskOf", () => {
  const task = (id: string, title: string, worktree: string | null): BoardTask => ({ id, title, worktree, state: "done", stage: "done", kind: "", pr: null, reviewedHead: null });
  // two tasks may share a title: only the checkout tells them apart
  const tasks = [task("api/1", "export-guard", "/w/api/feat-export-guard"), task("api/2", "export-guard", "/w/api/fix-flaky"), task("api/3", "research", null)];
  const on = (checkout_path: string, is_linked_worktree = true) => ({ worktree: { checkout_path, is_linked_worktree } });
  it("finds a task by its own checkout, whatever the names say", () => {
    expect(boardTaskOf(on("/w/api/fix-flaky"), tasks)?.id).toBe("api/2");
    expect(boardTaskOf(on("/w/api/feat-export-guard/"), tasks)?.id).toBe("api/1");
  });
  it("finds none for another checkout, a main checkout, no worktree, or two owners", () => {
    expect(boardTaskOf(on("/w/api/other"), tasks)).toBeNull();
    expect(boardTaskOf(on("/w/api/fix-flaky", false), tasks)).toBeNull();
    expect(boardTaskOf({}, tasks)).toBeNull();
    expect(boardTaskOf(on("/w/api/fix-flaky"), [...tasks, task("api/4", "again", "/w/api/fix-flaky")])).toBeNull();
  });
});
