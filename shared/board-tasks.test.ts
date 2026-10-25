import { describe, expect, it } from "bun:test";
import { boardApproveKind, boardCommand, boardTaskOf, isBoardTaskId, type BoardTask } from "./board-tasks.ts";

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
    expect(boardCommand({ action: "approve", id: "ovis/5", expect: { stage: "plan", kind: "" } })).toEqual(["approve", "ovis/5"]);
    expect(boardCommand({ action: "archive-done" })).toEqual(["archive", "--done"]);
    expect(boardCommand({ action: "archive-done", repo: "ovis" })).toEqual(["archive", "--done", "--repo", "ovis"]);
  });
  it("refuses an unknown action, a bad id or repo, and a non-object", () => {
    expect(boardCommand({ action: "delegate", id: "ovis/5" })).toBeNull();
    expect(boardCommand({ action: "archive", id: "--all" })).toBeNull();
    expect(boardCommand({ action: "archive" })).toBeNull();
    expect(boardCommand({ action: "approve", id: 5, expect: { stage: "plan", kind: "" } })).toBeNull();
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
  const task = (id: string, title: string, worktree: string | null): BoardTask => ({ id, title, worktree, state: "done", stage: "done", kind: "" });
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
