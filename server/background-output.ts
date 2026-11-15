/**
 * GET /api/pane/background-output?pane_id=&task_id=&offset=: a background task's output while it
 * runs and after it ends, for the task sheet's live view. A Claude Code task (a `run_in_background`
 * Bash call, a Monitor, a Workflow) streams to `<session temp folder>/tasks/<id>.output`, which
 * outlives the call until the session's folder goes; a Codex exec session's output is only the
 * chunks its polls recorded in the rollout (codex-background.ts). The caller names a pane and the
 * id the task list gave it: the folder and the file are the server's to resolve, and the id is a
 * plain word before it names a file.
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { PaneBackgroundOutput } from "../shared/protocol.ts";
import { validDetailId } from "./claude-subagents.ts";
import { badRequest, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";

export const BACKGROUND_OUTPUT_PATH = "/api/pane/background-output";
/** at most this much of the output per answer: a live view polls for the rest */
export const OUTPUT_READ_BYTES = 64 * 1024;

export type OutputSlice = Omit<PaneBackgroundOutput, "task_id" | "server_time">;

/** The longest prefix of `bytes` that ends on a whole UTF-8 character. */
function wholeChars(bytes: Buffer): Buffer {
  let end = bytes.length;
  // a lead byte among the last three whose sequence runs past the end is left for the next read
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (length > back) end = bytes.length - back;
    break;
  }
  return bytes.subarray(0, end);
}

/**
 * The part of an output of `size` bytes from `from` on, read through `read(position, length)`.
 * No `from`, or one past the end (the output was rewritten), reads the last `max` bytes from a
 * line's start, with `reset`. Shared by the file and the Codex chunks.
 */
export function sliceOutput(size: number, from: number | null, read: (position: number, length: number) => Buffer, max = OUTPUT_READ_BYTES): OutputSlice {
  const reset = from === null || from > size;
  let start = reset ? Math.max(0, size - max) : from;
  let bytes = read(start, Math.min(max, size - start));
  if (reset && start > 0) {
    // a tail that starts inside a line starts at the next one
    const line = bytes.indexOf(0x0a);
    if (line !== -1) { bytes = bytes.subarray(line + 1); start += line + 1; }
  }
  const whole = wholeChars(bytes);
  return { text: whole.toString("utf8"), start, offset: start + whole.length, size, reset, gone: false };
}

const GONE = (from: number | null): OutputSlice => ({ text: "", start: from ?? 0, offset: from ?? 0, size: 0, reset: false, gone: true });

/** A Claude Code task's output file in its session's temp folder; `gone` when there is none (or it is no plain file). */
export function readTaskOutput(sessionDir: string, taskId: string, from: number | null, max = OUTPUT_READ_BYTES): OutputSlice {
  if (!validDetailId(taskId)) return GONE(from);
  const path = join(sessionDir, "tasks", `${taskId}.output`);
  let fd: number;
  try {
    if (!lstatSync(path).isFile()) return GONE(from);
    fd = openSync(path, "r");
  } catch { return GONE(from); }
  try {
    const size = fstatSync(fd).size;
    return sliceOutput(size, from, (position, length) => {
      const buffer = Buffer.alloc(Math.max(0, length));
      const got = length > 0 ? readSync(fd, buffer, 0, length, position) : 0;
      return buffer.subarray(0, got);
    }, max);
  } catch { return GONE(from); } finally { closeSync(fd); }
}

export interface BackgroundOutputDeps {
  /** the pane's Claude Code session temp folder (file-routes.ts paneClaudeTempFolder), null when it runs none */
  claudeFolder: (paneId: string) => Promise<string | null>;
  /** a Codex pane's exec session output (codex-background.ts), null when the pane runs no Codex session */
  codexOutput?: (paneId: string, taskId: string, from: number | null) => Promise<OutputSlice | null>;
  now?: () => number;
}

export async function handleBackgroundOutputRequest(request: Request, url: URL, deps: BackgroundOutputDeps): Promise<Response> {
  setRequestRoute(BACKGROUND_OUTPUT_PATH);
  if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
  const paneId = url.searchParams.get("pane_id");
  const taskId = url.searchParams.get("task_id");
  const rawOffset = url.searchParams.get("offset");
  if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
  if (!taskId) return badRequest("missing_task_id", "task_id query parameter is required");
  if (!validDetailId(taskId)) return badRequest("invalid_task_id", "task_id must be a word of letters, digits, - and _, at most 128 characters");
  if (rawOffset !== null && (!/^[0-9]{1,15}$/.test(rawOffset))) return badRequest("invalid_offset", "offset must be a byte count in decimal digits");
  const from = rawOffset === null ? null : Number(rawOffset);
  try {
    const answer = (slice: OutputSlice): Response => jsonResponse({ task_id: taskId, ...slice, server_time: new Date((deps.now ?? Date.now)()).toISOString() } satisfies PaneBackgroundOutput);
    if (taskId.startsWith("exec-") && deps.codexOutput) {
      const codex = await deps.codexOutput(paneId, taskId, from);
      if (codex !== null) return answer(codex);
    }
    const folder = await deps.claudeFolder(paneId);
    if (folder === null) return jsonResponse({ error: { code: "background_store_unavailable", message: "the pane's session keeps no task output that can be read" } }, 503);
    return answer(readTaskOutput(folder, taskId, from));
  } catch (error) {
    return errorResponse(error);
  }
}
