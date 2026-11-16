import { constants, type Stats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { checkBoundFile, readBound } from "./conversation-shared.ts";
import type { HistorySegment } from "./codex.ts";

export interface CodexHistoryScan<T> {
  files: HistoryFile[];
  value: T;
}

export interface CodexHistorySpan { path: string; start: number; end: number }
type ScanSegment = HistorySegment & { start?: number };
type Each<T> = (value: T, line: string, span: CodexHistorySpan) => boolean;

/** A caller waits briefly; identical requests share the checked background scan. */
export async function scanCodexHistory<T>({ key, segments, cache, initial, each }: {
  key: string; segments: readonly ScanSegment[]; cache: Map<string, CodexHistoryScan<T>>;
  initial: () => T; each: Each<T>;
}): Promise<CodexHistoryScan<T> | null> {
  const cacheKey = JSON.stringify([key, segments.map(({ path, start }) => [path, start ?? 0])]);
  let pending = pendingByCache.get(cache);
  if (!pending) {
    pending = new Map();
    pendingByCache.set(cache, pending);
    for (const tracked of caches) if (!tracked.deref()) caches.delete(tracked);
    caches.add(new WeakRef(cache));
  }
  const load = async (): Promise<boolean> => {
    const epoch = resetEpoch, until = performance.now() + WAIT_MS;
    const known = cache.get(cacheKey);
    if (known && matchesRequest({ files: known.files, segments })) {
      const current = await unchangedFiles(known.files);
      if (cache.get(cacheKey) !== known) return false;
      // Checked cache hits must not compete with cold scans for queue admission.
      if (current) { cache.delete(cacheKey); cache.set(cacheKey, known); return true; }
    }
    return enqueue({ epoch, until, run: async (signal) => {
      const result = await scanHistory({ segments, known: cache.get(cacheKey), initial, each, signal,
        invalidate: () => cache.delete(cacheKey) });
      if (signal.aborted) return false;
      if (result !== null) { cache.delete(cacheKey); cache.set(cacheKey, result); }
      if (cache.size > KEPT) cache.delete(cache.keys().next().value!);
      return result !== null;
    } });
  };
  const shared = pending.get(cacheKey) ?? load();
  pending.set(cacheKey, shared);
  void shared.then(() => { if (pending.get(cacheKey) === shared) pending.delete(cacheKey); });
  const complete = await waitForScan(shared);
  const result = complete ? cache.get(cacheKey) : undefined;
  // A caller asking for an append may have joined the earlier prefix's in-flight scan.
  if (!result || !matchesRequest({ files: result.files, segments })) return null;
  try {
    for (const [at, file] of result.files.entries()) {
      readBound([[file.path, segments[at]!.identity ?? file.stat]], () => checkBoundFile(file.path, file.stat));
    }
    return { files: structuredClone(result.files), value: structuredClone(result.value) };
  } catch { return null; }
}

/** Omitted records must still be valid; callers separately weigh appends beyond this indexed prefix. */
export const isCodexHistoryCurrent = (scan: CodexHistoryScan<unknown>): Promise<boolean> => waitForScan(indexedPrefixCurrent(scan.files));

/** Reset invalidates queued and running work before clearing the owning caches. */
export async function resetCodexHistoryScans(): Promise<void> {
  resetEpoch++;
  const stopped = [...jobs];
  for (const job of stopped) job.abort.abort();
  for (const job of queue.splice(0)) { jobs.delete(job); job.done(false); }
  for (const cache of caches) cache.deref()?.clear();
  caches.clear();
  pendingByCache = new WeakMap();
  notifyCapacity();
  await Promise.all(stopped.map((job) => job.promise));
}

const WAIT_MS = 100;
const SLICE_MS = 8;
const CHUNK_BYTES = 64 * 1024;
const HEADER_BYTES = 4096;
const ACTIVE = 2;
const WAITING = 32;
const KEPT = 64;

interface HistoryFile extends CodexHistorySpan { stat: Stats; header: string; delimited: boolean }
interface Job { abort: AbortController; run: (signal: AbortSignal) => Promise<boolean>; promise: Promise<boolean>; done: (success: boolean) => void }
let pendingByCache = new WeakMap<object, Map<string, Promise<boolean>>>();
// Reset reaches live caches without retaining projections evicted by their owner.
const caches = new Set<WeakRef<{ clear(): void }>>();
const jobs = new Set<Job>();
const queue: Job[] = [];
let active = 0;
let resetEpoch = 0;
let capacity = Promise.withResolvers<void>();

async function waitForScan(pending: Promise<boolean>): Promise<boolean> {
  const epoch = resetEpoch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const complete = await Promise.race([pending, new Promise<boolean>((done) => { timer = setTimeout(() => done(false), WAIT_MS); })]);
    return complete && epoch === resetEpoch;
  } finally { clearTimeout(timer); }
}

function matchesRequest({ files, segments }: { files: readonly HistoryFile[]; segments: readonly ScanSegment[] }): boolean {
  return files.length === segments.length && files.every((file, at) => file.path === segments[at]!.path
    && file.start === (segments[at]!.start ?? 0) && file.end === segments[at]!.end);
}

async function unchangedFiles(files: readonly HistoryFile[]): Promise<boolean> {
  try {
    for await (const { file, now } of currentFiles(files)) {
      if (!now.isFile() || !sameIdentity({ left: now, right: file.stat }) || !unchanged({ left: now, right: file.stat })) return false;
    }
    return true;
  } catch { return false; }
}

async function indexedPrefixCurrent(files: readonly HistoryFile[]): Promise<boolean> {
  try {
    for await (const { file, now } of currentFiles(files)) {
      if (!now.isFile() || !sameIdentity({ left: now, right: file.stat })
        || !unchanged({ left: now, right: file.stat }) && !(now.size > file.stat.size && file.delimited)) return false;
    }
    return true;
  } catch { return false; }
}

async function enqueue({ run, epoch, until }: { run: Job["run"]; epoch: number; until: number }): Promise<boolean> {
  while (active >= ACTIVE && queue.length >= WAITING) {
    if (epoch !== resetEpoch || performance.now() >= until) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([capacity.promise, new Promise<void>((done) => { timer = setTimeout(done, Math.max(0, until - performance.now())); })]);
    } finally { clearTimeout(timer); }
  }
  if (epoch !== resetEpoch || performance.now() >= until) return false;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const job = { run, promise, done: resolve, abort: new AbortController() };
  jobs.add(job);
  if (active < ACTIVE) start(job);
  else queue.push(job);
  return promise;
}

function notifyCapacity(): void {
  const waiting = capacity;
  capacity = Promise.withResolvers<void>();
  waiting.resolve();
}

function start(job: Job): void {
  active++;
  const finish = (success: boolean) => {
    active--;
    jobs.delete(job);
    job.done(success);
    const next = queue.shift();
    if (next) start(next);
    notifyCapacity();
  };
  void job.run(job.abort.signal).then(finish, () => finish(false));
}

async function scanHistory<T>({ segments, known, initial, each, signal, invalidate }: {
  segments: readonly ScanSegment[]; known: CodexHistoryScan<T> | undefined;
  initial: () => T; each: Each<T>; signal: AbortSignal; invalidate: () => void;
}): Promise<CodexHistoryScan<T> | null> {
  try {
    const files: HistoryFile[] = [];
    for (const group of fileGroups(segments)) for (const file of await snapshot({ segments: group, signal })) files.push(file);
    const continued = known !== undefined && files.length === known.files.length && files.every((file, at) => {
      const before = known.files[at]!;
      return sameIdentity({ left: file.stat, right: before.stat }) && file.header === before.header && file.start === before.start && file.end >= before.end
        && (at === files.length - 1 || file.end === before.end)
        && (unchanged({ left: file.stat, right: before.stat }) || file.stat.size > before.stat.size && before.delimited);
    });
    if (!continued) invalidate();
    const value = continued ? structuredClone(known.value) : initial();
    const unread = files.map((file, at) => ({ ...file, from: continued ? known.files[at]!.end : file.start }));
    for (const group of fileGroups(unread)) {
      if (!await scanLines({ files: group, each: (line, span) => each(value, line, span), signal })) return null;
    }
    for await (const { file, now } of currentFiles(files)) {
      signal.throwIfAborted();
      if (!sameIdentity({ left: now, right: file.stat }) || now.size < file.stat.size
        || now.size === file.stat.size && !unchanged({ left: now, right: file.stat })) { invalidate(); return null; }
    }
    return { files, value };
  } catch { if (!signal.aborted) invalidate(); return null; }
}

function fileGroups<T extends { path: string }>(files: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (const file of files) {
    const previous = groups.at(-1);
    if (previous?.[0]?.path === file.path) previous.push(file);
    else groups.push([file]);
  }
  return groups;
}

async function* currentFiles(files: readonly HistoryFile[]) {
  const stats = new Map<string, Stats>();
  for (const file of files) {
    let now = stats.get(file.path);
    if (now === undefined) { now = await stat(file.path); stats.set(file.path, now); }
    yield { file, now };
  }
}

async function snapshot({ segments, signal }: { segments: readonly ScanSegment[]; signal: AbortSignal }): Promise<HistoryFile[]> {
  signal.throwIfAborted();
  const first = segments[0]!;
  const opened = await open(first.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    signal.throwIfAborted();
    const info = await opened.stat();
    signal.throwIfAborted();
    readBound([[first.path, first.identity ?? info]], () => checkBoundFile(first.path, info));
    if (!info.isFile()) throw new Error("Incomplete Codex history");
    const read = historyReader({ opened, info, signal });
    const head = Buffer.from(await read({ start: 0, end: Math.min(info.size, HEADER_BYTES) }));
    if (head.length !== Math.min(info.size, HEADER_BYTES)) throw new Error("Incomplete Codex header");
    const files: HistoryFile[] = [];
    let slice = performance.now();
    for (const segment of segments) {
      readBound([[segment.path, segment.identity ?? info]], () => checkBoundFile(segment.path, info));
      const start = segment.start ?? 0;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(segment.end)
        || start < 0 || segment.end > info.size || segment.end < start) throw new Error("Incomplete Codex history");
      const last = segment.end === 0 ? null : await read({ start: segment.end - 1, end: segment.end });
      if (last !== null && last.length !== 1) throw new Error("Incomplete Codex history");
      files.push({ path: segment.path, start, end: segment.end, stat: info,
        header: head.subarray(0, Math.min(segment.end, HEADER_BYTES)).toString("utf8").split("\n")[0]!, delimited: last === null || last[0] === 10 });
      if (performance.now() - slice >= SLICE_MS) {
        await setImmediate();
        signal.throwIfAborted();
        slice = performance.now();
      }
    }
    return files;
  } finally { await opened.close(); }
}

async function scanLines({ files, each, signal }: {
  files: readonly (HistoryFile & { from: number })[]; each: (line: string, span: CodexHistorySpan) => boolean; signal: AbortSignal;
}): Promise<boolean> {
  signal.throwIfAborted();
  const opened = await open(files[0]!.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await opened.stat();
    signal.throwIfAborted();
    if (!info.isFile()) return false;
    const read = historyReader({ opened, info, signal });
    let slice = performance.now();
    for (const file of files) {
      readBound([[file.path, file.stat]], () => checkBoundFile(file.path, info));
      if (info.size < file.end) return false;
      let pieces: Buffer[] = [], length = 0, lineStart = file.from;
      const weigh = ({ piece, end }: { piece: Buffer; end: number }): boolean => {
        const line = pieces.length === 0 ? piece.toString("utf8") : Buffer.concat([...pieces, piece], length + piece.length).toString("utf8");
        pieces = []; length = 0;
        const span = { path: file.path, start: lineStart, end };
        lineStart = end;
        return line.trim() === "" || each(line, span);
      };
      for (let offset = file.from; offset < file.end;) {
        const buffer = await read({ start: offset, end: file.end });
        if (buffer.length === 0) return false;
        let start = 0;
        for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10, start)) {
          if (!weigh({ piece: buffer.subarray(start, end), end: offset + end + 1 })) return false;
          start = end + 1;
          if (performance.now() - slice >= SLICE_MS) {
            await setImmediate();
            signal.throwIfAborted();
            slice = performance.now();
          }
        }
        if (start < buffer.length) {
          pieces.push(Buffer.from(buffer.subarray(start)));
          length += buffer.length - start;
        }
        offset += buffer.length;
      }
      if (length > 0 && !weigh({ piece: Buffer.alloc(0), end: file.end })) return false;
      if (performance.now() - slice >= SLICE_MS) {
        await setImmediate();
        signal.throwIfAborted();
        slice = performance.now();
      }
    }
    return true;
  } finally { await opened.close(); }
}

/** Returned views last until the next read; gaps are never passed to a range's projection. */
function historyReader({ opened, info, signal }: { opened: FileHandle; info: Stats; signal: AbortSignal }) {
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let from = 0, until = 0;
  return async ({ start, end }: { start: number; end: number }): Promise<Buffer> => {
    signal.throwIfAborted();
    if (start === end) return Buffer.alloc(0);
    if (start < from || start >= until) {
      const { bytesRead } = await opened.read(buffer, 0, Math.min(buffer.length, info.size - start), start);
      signal.throwIfAborted();
      from = start; until = start + bytesRead;
    }
    return buffer.subarray(start - from, Math.min(end, until) - from);
  };
}

const sameIdentity = ({ left, right }: { left: Stats; right: Stats }): boolean => left.dev === right.dev && left.ino === right.ino;
const unchanged = ({ left, right }: { left: Stats; right: Stats }): boolean => left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
