import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import * as files from "node:fs/promises";
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { isCodexHistoryCurrent, resetCodexHistoryScans, scanCodexHistory, type CodexHistoryScan, type CodexHistorySpan } from "./codex-history-scan.ts";

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

it("indexes byte spans across UTF-8 chunks and reads only the selected record", async () => {
  const first = JSON.stringify({ n: 1, text: "é🙂".repeat(20_000) }) + "\n";
  const second = '{"n":2}\n';
  writeFileSync(path, first + second);
  const spans = new Map<string, CodexHistoryScan<CodexHistorySpan[]>>();
  const indexed = await eventually(() => scanCodexHistory({ key: "spans", segments: [{ path, end: statSync(path).size }], cache: spans,
    initial: () => [], each: (value, _line, span) => { value.push(span); return true; } }));
  expect(indexed.value).toEqual([{ path, start: 0, end: Buffer.byteLength(first) },
    { path, start: Buffer.byteLength(first), end: Buffer.byteLength(first + second) }]);
  const selected = (start: number) => scanCodexHistory({ key: "selected", segments: [{ path, start, end: statSync(path).size }], cache, initial: () => [], each });
  expect((await selected(Buffer.byteLength(first)))?.value).toEqual([2]);
  expect(lines).toBe(1);
  expect((await selected(0))?.value).toEqual([1, 2]);
  appendFileSync(path, '{"n":3}\n');
  expect((await selected(Buffer.byteLength(first)))?.value).toEqual([2, 3]);
  expect(await selected(-1)).toBeNull();
  expect(await selected(statSync(path).size + 1)).toBeNull();
  await resetCodexHistoryScans();
  expect(spans.size).toBe(0);
  expect((await selected(Buffer.byteLength(first)))?.value).toEqual([2, 3]);
});

it("batches separated ranges by file and reuses one stat for their cached validation", async () => {
  const segments: CodexHistorySpan[] = [], parts: string[] = [];
  let end = 0;
  for (let n = 0; n < 1200; n++) {
    const line = JSON.stringify({ n }) + "\n", gap = '{"n":-1,"type":"token_count"}\n';
    segments.push({ path, start: end, end: end + Buffer.byteLength(line) });
    parts.push(line, gap);
    end += Buffer.byteLength(line + gap);
  }
  writeFileSync(path, parts.join(""));
  const opened = spyOn(files, "open"), stated = spyOn(files, "stat");
  const read = (key: string) => scanCodexHistory({ key, segments, cache, initial: () => [], each });
  try {
    expect((await eventually(() => read("warm"))).value).toEqual(Array.from({ length: 1200 }, (_, n) => n));
    for (let query = 0; query < 3; query++) {
      opened.mockClear(); stated.mockClear();
      expect((await read(String(query)))?.value).toEqual(Array.from({ length: 1200 }, (_, n) => n));
      expect(opened).toHaveBeenCalledTimes(2);
      expect(stated).toHaveBeenCalledTimes(1);
    }
    opened.mockClear(); stated.mockClear();
    expect((await read("2"))?.value.length).toBe(1200);
    expect(opened).not.toHaveBeenCalled();
    expect(stated).toHaveBeenCalledTimes(1);
  } finally { await resetCodexHistoryScans(); opened.mockRestore(); stated.mockRestore(); }
});

it("keeps UTF-8 ranges separate across large gaps and preserves caller path order", async () => {
  const first = JSON.stringify({ n: 1, text: "é🙂".repeat(20_000) }) + "\n";
  const gap = JSON.stringify({ n: 99, text: "x".repeat(2 * 1024 * 1024) }) + "\n";
  const last = '{"n":2}';
  writeFileSync(path, first + gap + last);
  const other = join(root, "other.jsonl");
  writeFileSync(other, '{"n":3}\n');
  const segments = [{ path, start: 0, end: Buffer.byteLength(first) },
    { path, start: Buffer.byteLength(first + gap), end: statSync(path).size }];
  const read = () => scanCodexHistory({ key: "gaps", segments, cache, initial: () => [], each });
  expect((await eventually(read)).value).toEqual([1, 2]);
  appendFileSync(path, '\n{"n":4}\n');
  segments[1]!.end = statSync(path).size;
  expect((await read())?.value).toEqual([1, 2, 4]);
  const ordered = [segments[0]!, { path: other, start: 0, end: statSync(other).size, identity: statSync(other) }, segments[1]!];
  expect((await scanCodexHistory({ key: "order", segments: ordered, cache, initial: () => [], each }))?.value).toEqual([1, 3, 2, 4]);
  expect((await scanCodexHistory({ key: "empty", segments: [{ path, start: segments[1]!.end, end: segments[1]!.end }], cache, initial: () => [], each }))?.value).toEqual([]);
  renameSync(other, join(root, "old"));
  writeFileSync(other, '{"n":8}\n');
  expect(await scanCodexHistory({ key: "order", segments: ordered, cache, initial: () => [], each })).toBeNull();
});

it("never continues an indexed range after its file is replaced or its final record is partial", async () => {
  writeFileSync(path, '{"n":0}\n{"n":1}\n');
  const read = () => scanCodexHistory({ key: "selected", segments: [{ path, start: 8, end: statSync(path).size }], cache, initial: () => [], each });
  expect((await read())?.value).toEqual([1]);
  appendFileSync(path, '{"n":');
  expect(await read()).toBeNull();
  appendFileSync(path, '2}\n');
  expect((await read())?.value).toEqual([1, 2]);
  writeFileSync(join(root, "replacement"), '{"n":9}\n{"n":3}\n');
  renameSync(join(root, "replacement"), path);
  expect((await read())?.value).toEqual([3]);
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
  // Make the rewrite observable on filesystems that coalesce immediate write timestamps.
  utimesSync(path, new Date(), new Date(Date.now() + 1000));
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
    for (let index = 34; index < 40; index++) expect(cache.has(JSON.stringify([String(index), [[path, 0]]]))).toBe(false);
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
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    return each(value, line);
  } });
  expect(result).toBeNull();
  expect(cache.size).toBe(0);
});

it("bounds validation after an indexed read when a file's stat stalls", async () => {
  const indexed = await scan();
  expect(indexed).not.toBeNull();
  const gate = Promise.withResolvers<void>();
  const stat = spyOn(files, "stat").mockImplementation(async () => { await gate.promise; throw new Error("stat unavailable"); });
  try {
    const started = performance.now();
    expect(await isCodexHistoryCurrent(indexed!)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
    const checking = isCodexHistoryCurrent(indexed!);
    await resetCodexHistoryScans();
    gate.resolve();
    expect(await checking).toBe(false);
  } finally { gate.resolve(); stat.mockRestore(); }
});

it("keeps indexed complete records valid during an append, but not a rewrite or a joined final line", async () => {
  const indexed = await scan();
  appendFileSync(path, '{"n":2}\n');
  expect(await isCodexHistoryCurrent(indexed!)).toBe(true);
  writeFileSync(path, '{"n":3}\n{"n":2}\n');
  const rewritten = await scan();
  writeFileSync(path, '{"n":4}\n{"n":2}\n');
  utimesSync(path, new Date(), new Date(Date.now() + 1000));
  expect(await isCodexHistoryCurrent(rewritten!)).toBe(false);
  writeFileSync(path, '{"n":1}');
  const undelimited = await scan();
  appendFileSync(path, '0');
  expect(await isCodexHistoryCurrent(undelimited!)).toBe(false);
});

it("does not retain a cache after its owner releases it", () => {
  // Isolate collection from assertion frames retained by the test runner.
  const child = Bun.spawnSync({ cmd: [process.execPath, "-e", `
    import {scanCodexHistory} from ${JSON.stringify(new URL("./codex-history-scan.ts", import.meta.url).href)};
    import {setImmediate} from "node:timers/promises";
    async function warm() {
      const cache = new Map();
      const result = await scanCodexHistory({key:"temporary", segments:[{path:${JSON.stringify(path)},end:8}], cache, initial:()=>[], each:()=>true});
      if (result === null) throw new Error("cache did not warm");
      return new WeakRef(cache);
    }
    const reference = await warm();
    await setImmediate();
    Bun.gc(true);
    if (reference.deref()) throw new Error("scanner retained an unowned cache");
  `], stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
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
