import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PaneBackgroundOutput } from "../shared/protocol.ts";
import { handleBackgroundOutputRequest, readTaskOutput } from "./background-output.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function folder(): { dir: string; file: (id: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "ovis-bg-output-"));
  roots.push(dir);
  mkdirSync(join(dir, "tasks"));
  return { dir, file: (id) => join(dir, "tasks", `${id}.output`) };
}

describe("readTaskOutput", () => {
  it("reads the whole of a short output first, then only what was appended", () => {
    const { dir, file } = folder();
    writeFileSync(file("b1"), "one\ntwo\n");
    const first = readTaskOutput(dir, "b1", null);
    expect(first).toEqual({ text: "one\ntwo\n", start: 0, offset: 8, size: 8, reset: true, gone: false });
    appendFileSync(file("b1"), "\x1b[31mthree\x1b[0m\n");
    const next = readTaskOutput(dir, "b1", first.offset);
    expect(next).toMatchObject({ text: "\x1b[31mthree\x1b[0m\n", start: 8, reset: false });
    expect(readTaskOutput(dir, "b1", next.offset)).toMatchObject({ text: "", offset: next.offset });
  });

  it("reads the last part of a long output from a line's start", () => {
    const { dir, file } = folder();
    writeFileSync(file("b1"), "aaaa\nbbbb\ncccc\n");
    expect(readTaskOutput(dir, "b1", null, 8)).toMatchObject({ text: "cccc\n", start: 10, offset: 15, reset: true });
  });

  it("starts again at the tail when the output was rewritten shorter than the offset", () => {
    const { dir, file } = folder();
    writeFileSync(file("b1"), "short\n");
    expect(readTaskOutput(dir, "b1", 500)).toMatchObject({ text: "short\n", reset: true, offset: 6 });
  });

  it("says gone for an output Claude Code no longer keeps", () => {
    const { dir } = folder();
    expect(readTaskOutput(dir, "b1", 10)).toMatchObject({ gone: true, text: "" });
  });

  it("never names a file outside the tasks folder", () => {
    const { dir } = folder();
    writeFileSync(join(dir, "secret.output"), "x");
    expect(readTaskOutput(dir, "../secret", null).gone).toBe(true);
  });

  it("does not split a character across two reads", () => {
    const { dir, file } = folder();
    writeFileSync(file("b1"), "é✓");
    const first = readTaskOutput(dir, "b1", 0, 4);
    expect(first).toMatchObject({ text: "é", offset: 2 });
    expect(readTaskOutput(dir, "b1", first.offset, 4).text).toBe("✓");
  });
});

describe("GET /api/pane/background-output", () => {
  const get = (query: string, claudeFolder: () => Promise<string | null>) => {
    const url = new URL(`http://x/api/pane/background-output?${query}`);
    return handleBackgroundOutputRequest(new Request(url), url, { claudeFolder, now: () => 0 });
  };

  it("answers the task's output by pane and id", async () => {
    const { dir, file } = folder();
    writeFileSync(file("b1"), "hi\n");
    const response = await get("pane_id=p1&task_id=b1", async () => dir);
    expect(response.status).toBe(200);
    const body = await response.json() as PaneBackgroundOutput;
    expect(body).toMatchObject({ task_id: "b1", text: "hi\n", offset: 3 });
    expect(JSON.stringify(body)).not.toContain(dir);
  });

  it("refuses an id that is not a plain word and a bad offset", async () => {
    expect((await get("pane_id=p1&task_id=..%2Fx", async () => "/")).status).toBe(400);
    expect((await get("pane_id=p1&task_id=b1&offset=-1", async () => "/")).status).toBe(400);
  });

  it("is 503 for a pane with no Claude session folder", async () => {
    expect((await get("pane_id=p1&task_id=b1", async () => null)).status).toBe(503);
  });
});
