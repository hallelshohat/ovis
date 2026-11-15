import { constants, type Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { checkBoundFile, readBound } from "./conversation-shared.ts";
import type { HistorySegment } from "./codex.ts";

export interface CodexHistoryScan<T> {
  files: HistoryFile[];
  value: T;
}

/** A caller waits briefly; identical requests share the checked background scan. */
export async function scanCodexHistory<T>({ key, segments, cache, initial, each }: {
  key: string; segments: readonly HistorySegment[]; cache: Map<string, CodexHistoryScan<T>>;
  initial: () => T; each: (value: T, line: string) => boolean;
}): Promise<CodexHistoryScan<T> | null> {
  const cacheKey = JSON.stringify([key, segments.map(({ path }) => path)]);
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const complete = await Promise.race([
      shared,
      new Promise<boolean>((done) => { timer = setTimeout(() => done(false), WAIT_MS); }),
    ]);
    const result = complete ? cache.get(cacheKey) : undefined;
    // A caller asking for an append may have joined the earlier prefix's in-flight scan.
    if (!result || !matchesRequest({ files: result.files, segments })) return null;
    try {
      for (const [at, file] of result.files.entries()) {
        readBound([[file.path, segments[at]!.identity ?? file.stat]], () => checkBoundFile(file.path, file.stat));
      }
      return { files: structuredClone(result.files), value: structuredClone(result.value) };
    } catch { return null; }
  } finally { clearTimeout(timer); }
}

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

interface HistoryFile { path: string; end: number; stat: Stats; header: string; delimited: boolean }
interface Job { abort: AbortController; run: (signal: AbortSignal) => Promise<boolean>; promise: Promise<boolean>; done: (success: boolean) => void }
let pendingByCache = new WeakMap<object, Map<string, Promise<boolean>>>();
// Reset reaches live caches without retaining projections evicted by their owner.
const caches = new Set<WeakRef<{ clear(): void }>>();
const jobs = new Set<Job>();
const queue: Job[] = [];
let active = 0;
let resetEpoch = 0;
let capacity = Promise.withResolvers<void>();

function matchesRequest({ files, segments }: { files: readonly HistoryFile[]; segments: readonly HistorySegment[] }): boolean {
  return files.length === segments.length && files.every((file, at) => file.path === segments[at]!.path && file.end === segments[at]!.end);
}

async function unchangedFiles(files: readonly HistoryFile[]): Promise<boolean> {
  try {
    for (const file of files) {
      const now = await stat(file.path);
      if (!now.isFile() || !sameIdentity({ left: now, right: file.stat }) || !unchanged({ left: now, right: file.stat })) return false;
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
  segments: readonly HistorySegment[]; known: CodexHistoryScan<T> | undefined;
  initial: () => T; each: (value: T, line: string) => boolean; signal: AbortSignal; invalidate: () => void;
}): Promise<CodexHistoryScan<T> | null> {
  try {
    const files: HistoryFile[] = [];
    for (const segment of segments) files.push(await snapshot({ segment, signal }));
    const continued = known !== undefined && files.length === known.files.length && files.every((file, at) => {
      const before = known.files[at]!;
      return sameIdentity({ left: file.stat, right: before.stat }) && file.header === before.header && file.end >= before.end
        && (at === files.length - 1 || file.end === before.end)
        && (unchanged({ left: file.stat, right: before.stat }) || file.stat.size > before.stat.size && before.delimited);
    });
    if (!continued) invalidate();
    const value = continued ? structuredClone(known.value) : initial();
    for (const [at, file] of files.entries()) {
      const from = continued ? known.files[at]!.end : 0;
      if (!await scanLines({ file, from, each: (line) => each(value, line), signal })) return null;
    }
    for (const file of files) {
      const now = await stat(file.path);
      signal.throwIfAborted();
      if (!sameIdentity({ left: now, right: file.stat }) || now.size < file.stat.size
        || now.size === file.stat.size && !unchanged({ left: now, right: file.stat })) { invalidate(); return null; }
    }
    return { files, value };
  } catch { if (!signal.aborted) invalidate(); return null; }
}

async function snapshot({ segment, signal }: { segment: HistorySegment; signal: AbortSignal }): Promise<HistoryFile> {
  signal.throwIfAborted();
  const file = await open(segment.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    signal.throwIfAborted();
    const info = await file.stat();
    signal.throwIfAborted();
    readBound([[segment.path, segment.identity ?? info]], () => checkBoundFile(segment.path, info));
    if (!info.isFile() || segment.end > info.size || segment.end < 0) throw new Error("Incomplete Codex history");
    const head = Buffer.alloc(Math.min(segment.end, HEADER_BYTES));
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    signal.throwIfAborted();
    if (bytesRead !== head.length) throw new Error("Incomplete Codex header");
    const last = Buffer.alloc(1);
    const tail = segment.end === 0 ? null : await file.read(last, 0, 1, segment.end - 1);
    signal.throwIfAborted();
    if (tail !== null && tail.bytesRead !== 1) throw new Error("Incomplete Codex history");
    return { path: segment.path, end: segment.end, stat: info, header: head.toString("utf8").split("\n")[0]!, delimited: tail === null || last[0] === 10 };
  } finally { await file.close(); }
}

async function scanLines({ file, from, each, signal }: {
  file: HistoryFile; from: number; each: (line: string) => boolean; signal: AbortSignal;
}): Promise<boolean> {
  if (from === file.end) return true;
  signal.throwIfAborted();
  const opened = await open(file.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await opened.stat();
    signal.throwIfAborted();
    readBound([[file.path, file.stat]], () => checkBoundFile(file.path, info));
    if (!info.isFile() || info.size < file.end) return false;
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let pieces: Buffer[] = [], length = 0, slice = performance.now();
    const weigh = (piece: Buffer): boolean => {
      const line = pieces.length === 0 ? piece.toString("utf8") : Buffer.concat([...pieces, piece], length + piece.length).toString("utf8");
      pieces = []; length = 0;
      return line.trim() === "" || each(line);
    };
    for (let offset = from; offset < file.end;) {
      const { bytesRead } = await opened.read(buffer, 0, Math.min(buffer.length, file.end - offset), offset);
      signal.throwIfAborted();
      if (bytesRead === 0) return false;
      offset += bytesRead;
      let start = 0;
      for (let end = buffer.indexOf(10); end >= 0 && end < bytesRead; end = buffer.indexOf(10, start)) {
        if (!weigh(buffer.subarray(start, end))) return false;
        start = end + 1;
        if (performance.now() - slice >= SLICE_MS) {
          await setImmediate();
          signal.throwIfAborted();
          slice = performance.now();
        }
      }
      if (start < bytesRead) {
        pieces.push(Buffer.from(buffer.subarray(start, bytesRead)));
        length += bytesRead - start;
      }
    }
    return length === 0 || weigh(Buffer.alloc(0));
  } finally { await opened.close(); }
}

const sameIdentity = ({ left, right }: { left: Stats; right: Stats }): boolean => left.dev === right.dev && left.ino === right.ino;
const unchanged = ({ left, right }: { left: Stats; right: Stats }): boolean => left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
