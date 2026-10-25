import { describe, expect, it } from "bun:test";
import { boardCommand, boardTaskOf, isBoardTaskId, type BoardTask } from "./board-tasks.ts";

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
    expect(boardCommand({ action: "approve", id: "ovis/5" })).toEqual(["approve", "ovis/5"]);
    expect(boardCommand({ action: "archive-done" })).toEqual(["archive", "--done"]);
    expect(boardCommand({ action: "archive-done", repo: "ovis" })).toEqual(["archive", "--done", "--repo", "ovis"]);
  });
  it("refuses an unknown action, a bad id or repo, and a non-object", () => {
    expect(boardCommand({ action: "delegate", id: "ovis/5" })).toBeNull();
    expect(boardCommand({ action: "archive", id: "--all" })).toBeNull();
    expect(boardCommand({ action: "archive" })).toBeNull();
    expect(boardCommand({ action: "approve", id: 5 })).toBeNull();
    expect(boardCommand({ action: "archive-done", repo: "--on" })).toBeNull();
    expect(boardCommand({ action: "archive-done", repo: "" })).toBeNull();
    expect(boardCommand(null)).toBeNull();
    expect(boardCommand("archive ovis/5")).toBeNull();
  });
});

describe("boardTaskOf", () => {
  const tasks: BoardTask[] = [
    { id: "ovis/5", state: "working", stage: "working", title: "Close and archive board tasks from Ovis" },
    { id: "main/7", state: "done", stage: "done", title: "Monday: which GCP projects" },
  ];
  const worktree = (repo_name: string, is_linked_worktree = true) => ({ repo_name, is_linked_worktree });
  it("finds a task's space by its title, with or without its key", () => {
    expect(boardTaskOf({ label: "OVS-5 Close and archive board tasks from Ovis", worktree: worktree("ovis") }, tasks)?.id).toBe("ovis/5");
    expect(boardTaskOf({ label: "Monday: which GCP projects", worktree: worktree("main") }, tasks)?.id).toBe("main/7");
  });
  it("needs the task's repo, number and a linked worktree", () => {
    expect(boardTaskOf({ label: "Monday: which GCP projects", worktree: worktree("ovis") }, tasks)).toBeNull();
    expect(boardTaskOf({ label: "OVS-6 Close and archive board tasks from Ovis", worktree: worktree("ovis") }, tasks)).toBeNull();
    expect(boardTaskOf({ label: "Monday: which GCP projects", worktree: worktree("main", false) }, tasks)).toBeNull();
    expect(boardTaskOf({ label: "Monday: which GCP projects" }, tasks)).toBeNull();
  });
});
