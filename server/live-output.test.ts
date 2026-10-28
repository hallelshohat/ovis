import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRunningOutputs } from "./live-output.ts";

describe("claudeRunningOutputs", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ovis-live-output-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const task = (name: string, text: string) => {
    mkdirSync(join(dir, "tasks"), { recursive: true });
    writeFileSync(join(dir, "tasks", `${name}.output`), text);
  };

  it("reads each running command's file, oldest first, as its last lines", async () => {
    task("a", "progress line 1\nprogress line 2\n\n");
    task("b", Array.from({ length: 100 }, (_, index) => `b ${index}`).join("\n"));
    writeFileSync(join(dir, "tasks", "notes.txt"), "not a task");
    const outputs = await claudeRunningOutputs(dir, Date.now() - 1000);
    expect(outputs).toEqual(["progress line 1\nprogress line 2", Array.from({ length: 40 }, (_, index) => `b ${index + 60}`).join("\n")]);
  });

  it("leaves out a file born before the call, and answers none without a tasks folder", async () => {
    expect(await claudeRunningOutputs(dir, 0)).toEqual([]);
    task("old", "a background task's output");
    expect(await claudeRunningOutputs(dir, Date.now() + 5000)).toEqual([]);
  });
});
