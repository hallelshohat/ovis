import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import * as files from "node:fs/promises";
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { resetCodexHistoryScans, scanCodexHistory, type CodexHistoryScan } from "./codex-history-scan.ts";

let root: string;
let path: string;
let cache: Map<string, CodexHistoryScan<number[]>>;
const record = z.object({ n: z.number() });
let lines: number;
const each = (values: number[], line: string): boolean => {
  lines++;
  try {
    const parsed = record.safeParse(JSON.parse(line));
    if (!parsed.success) return false;
    values.push(parsed.data.n);
    return true;
  } catch { return false; }
};
const scan = () => scanCodexHistory({ key: "numbers", segments: [{ path, end: statSync(path).size }], cache, initial: () => [], each });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-history-scan-"));
  path = join(root, "history.jsonl");
  writeFileSync(path, '{"n":1}\n');
  cache = new Map();
  lines = 0;
});
afterEach(async () => {
  await resetCodexHistoryScans();
  rmSync(root, { recursive: true, force: true });
});

it("reuses a delimited prefix after append and gives each caller independent evidence", async () => {
  const first = await scan();
  expect(first?.value).toEqual([1]);
  first!.value.push(99);
  expect((await scan())?.value).toEqual([1]);
  expect(lines).toBe(1);
  appendFileSync(path, '{"n":2}\n');
  expect((await scan())?.value).toEqual([1, 2]);
  expect(lines).toBe(2);
});

it("accepts a complete final record without a newline but rereads it on growth", async () => {
  writeFileSync(path, '{"n":1}');
  expect((await scan())?.value).toEqual([1]);
  appendFileSync(path, '\n{"n":2}');
  expect((await scan())?.value).toEqual([1, 2]);
  expect(lines).toBe(3);
  writeFileSync(path, '{"n":');
  expect(await scan()).toBeNull();
  appendFileSync(path, '3}');
  expect((await scan())?.value).toEqual([3]);
});

it("keeps its verified prefix across an incomplete appended record", async () => {
  expect((await scan())?.value).toEqual([1]);
  appendFileSync(path, '{"n":');
  expect(await scan()).toBeNull();
  expect(cache.size).toBe(1);
  appendFileSync(path, '2}\n');
  expect((await scan())?.value).toEqual([1, 2]);
  expect(lines).toBe(3);
});

it("checks large records in full and preserves their prefix across an incomplete append", async () => {
  const padding = "x".repeat(9 * 1024 * 1024);
  writeFileSync(path, JSON.stringify({ padding, n: 1 }) + "\n");
  expect((await eventually(scan)).value).toEqual([1]);
  expect((await scan())?.value).toEqual([1]);
  expect(lines).toBe(1);
  appendFileSync(path, `{"padding":"${padding}","n":`);
  expect(await scan()).toBeNull();
  expect(cache.size).toBe(1);
  appendFileSync(path, '2}');
  expect((await eventually(scan)).value).toEqual([1, 2]);
  expect(lines).toBe(3);
}, 10_000);

it("invalidates same-size rewrites, truncations, replacements and missing files", async () => {
  expect((await scan())?.value).toEqual([1]);
  writeFileSync(path, '{"n":2}\n');
  expect((await scan())?.value).toEqual([2]);
  truncateSync(path, 0);
  expect((await scan())?.value).toEqual([]);
  writeFileSync(join(root, "replacement"), '{"n":3}\n');
  renameSync(join(root, "replacement"), path);
  expect((await scan())?.value).toEqual([3]);
  const identity = statSync(path);
  renameSync(path, join(root, "old"));
  writeFileSync(path, '{"n":4}\n');
  expect(await scanCodexHistory({ key: "numbers", segments: [{ path, end: identity.size, identity }], cache, initial: () => [], each })).toBeNull();
  rmSync(path);
  expect(await scanCodexHistory({ key: "numbers", segments: [{ path, end: 8 }], cache, initial: () => [], each })).toBeNull();
});

it("bounds waiting on stalled I/O, shares pending work and warms the cache afterwards", async () => {
  const gate = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  const original = files.open;
  const open = spyOn(files, "open").mockImplementation(async (...args) => {
    opened.resolve();
    await gate.promise;
    return original(...args);
  });
  try {
    const start = performance.now();
    const first = scan(), second = scan();
    await opened.promise;
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
    expect(open).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
    gate.resolve();
    expect((await eventually(scan))?.value).toEqual([1]);
    expect(lines).toBe(1);
  } finally { gate.resolve(); open.mockRestore(); }
});

it("bounds active and queued scans, and reset prevents late work from publishing", async () => {
  const gate = Promise.withResolvers<void>();
  const original = files.open;
  const open = spyOn(files, "open").mockImplementation(async (...args) => { await gate.promise; return original(...args); });
  try {
    const started = performance.now();
    const reads = Array.from({ length: 40 }, (_, index) => scanCodexHistory({ key: String(index), segments: [{ path, end: 8 }], cache, initial: () => [], each }));
    expect((await Promise.all(reads)).every((result) => result === null)).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
    expect(open).toHaveBeenCalledTimes(2);
    const stopped = resetCodexHistoryScans();
    gate.resolve();
    await stopped;
    expect(cache.size).toBe(0);
    expect(lines).toBe(0);
  } finally { gate.resolve(); open.mockRestore(); }
});

it("does not admit expired foreground checks when queue capacity returns", async () => {
  const gate = Promise.withResolvers<void>();
  const original = files.open;
  const open = spyOn(files, "open").mockImplementation(async (...args) => { await gate.promise; return original(...args); });
  try {
    const reads = Array.from({ length: 40 }, (_, index) => scanCodexHistory({ key: String(index), segments: [{ path, end: 8 }], cache, initial: () => [], each }));
    expect((await Promise.all(reads)).every((result) => result === null)).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
    gate.resolve();
    await eventually(async () => cache.size === 34 ? true : null);
    expect(lines).toBe(34);
    for (let index = 34; index < 40; index++) expect(cache.has(JSON.stringify([String(index), [path]]))).toBe(false);
  } finally { gate.resolve(); open.mockRestore(); }
});

it("reset cancels foreground admission before its deadline", async () => {
  const gate = Promise.withResolvers<void>();
  const original = files.open;
  const open = spyOn(files, "open").mockImplementation(async (...args) => { await gate.promise; return original(...args); });
  try {
    const reads = Array.from({ length: 40 }, (_, index) => scanCodexHistory({ key: String(index), segments: [{ path, end: 8 }], cache, initial: () => [], each }));
    const stopped = resetCodexHistoryScans();
    gate.resolve();
    await stopped;
    expect((await Promise.all(reads)).every((result) => result === null)).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
    expect(lines).toBe(0);
    expect(cache.size).toBe(0);
  } finally { gate.resolve(); open.mockRestore(); }
});

it("reuses only unchanged cached snapshots while the scan queue is full", async () => {
  expect((await scan())?.value).toEqual([1]);
  const gate = Promise.withResolvers<void>();
  const original = files.open;
  const open = spyOn(files, "open").mockImplementation(async (...args) => { await gate.promise; return original(...args); });
  try {
    const blocked = Array.from({ length: 40 }, (_, index) => scanCodexHistory({ key: String(index), segments: [{ path, end: 8 }], cache, initial: () => [], each }));
    expect((await scan())?.value).toEqual([1]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(lines).toBe(1);
    const elsewhere = join(root, "elsewhere.jsonl");
    writeFileSync(elsewhere, '{"n":9}\n');
    expect(await scanCodexHistory({ key: "numbers", segments: [{ path, end: 8, identity: statSync(elsewhere) }], cache, initial: () => [], each })).toBeNull();
    appendFileSync(path, '{"n":2}\n');
    expect(await scan()).toBeNull();
    expect(await scanCodexHistory({ key: "numbers", segments: [{ path, end: 8 }], cache, initial: () => [], each })).toBeNull();
    expect((await Promise.all(blocked)).every((result) => result === null)).toBe(true);
  } finally {
    const stopped = resetCodexHistoryScans();
    gate.resolve();
    await stopped;
    open.mockRestore();
  }
});

it("bounds cached validation and reset prevents it from starting later work", async () => {
  expect((await scan())?.value).toEqual([1]);
  const open = spyOn(files, "open");
  const gate = Promise.withResolvers<void>(), checked = Promise.withResolvers<void>();
  const original = files.stat;
  const stat = spyOn(files, "stat").mockReturnValueOnce(gate.promise.then(() => original(path)).finally(() => checked.resolve()));
  try {
    const start = performance.now();
    expect(await scan()).toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
    appendFileSync(path, '{"n":2}\n');
    const stopped = resetCodexHistoryScans();
    expect(cache.size).toBe(0);
    gate.resolve();
    await checked.promise;
    await stopped;
    await setImmediate();
    expect(cache.size).toBe(0);
    expect(open).not.toHaveBeenCalled();
  } finally { gate.resolve(); stat.mockRestore(); open.mockRestore(); }
});

it("does not return a completed earlier snapshot for a request for a longer history", async () => {
  const gate = Promise.withResolvers<void>();
  const original = files.open;
  const open = spyOn(files, "open").mockImplementation(async (...args) => { await gate.promise; return original(...args); });
  try {
    const earlier = scan();
    appendFileSync(path, '{"n":2}\n');
    const later = scan();
    gate.resolve();
    expect((await earlier)?.value).toEqual([1]);
    expect(await later).toBeNull();
    expect((await scan())?.value).toEqual([1, 2]);
  } finally { gate.resolve(); open.mockRestore(); }
});

it("checks inherited segment cuts and keeps the retained cache bounded", async () => {
  const parent = join(root, "parent.jsonl");
  writeFileSync(parent, '{"n":0}\n{"n":99}\n');
  const read = () => scanCodexHistory({ key: "chain", segments: [{ path: parent, end: 8 }, { path, end: statSync(path).size }], cache, initial: () => [], each });
  expect((await read())?.value).toEqual([0, 1]);
  appendFileSync(path, '{"n":2}\n');
  expect((await read())?.value).toEqual([0, 1, 2]);
  expect(lines).toBe(3);
  for (let index = 0; index < 70; index++) {
    await scanCodexHistory({ key: String(index), segments: [{ path, end: statSync(path).size }], cache, initial: () => [], each });
  }
  expect(cache.size).toBe(64);
});

it("refuses a rewrite during projection without contaminating cached evidence", async () => {
  const result = await scanCodexHistory({ key: "changing", segments: [{ path, end: 8 }], cache, initial: () => [], each: (value, line) => {
    writeFileSync(path, '{"n":2}\n');
    return each(value, line);
  } });
  expect(result).toBeNull();
  expect(cache.size).toBe(0);
});

async function eventually<T>(read: () => Promise<T | null>): Promise<T> {
  const until = performance.now() + 5000;
  while (performance.now() < until) {
    const value = await read();
    if (value !== null) return value;
    await setImmediate();
  }
  throw new Error("history scan did not finish");
}
