/**
 * A running Claude Code command's output while it runs. Its transcript records the output only once
 * the call ends, but Claude streams a foreground Bash call's stdout and stderr to
 * `<session temp folder>/tasks/<id>.output` and deletes the file when the call ends (2.1.3xx), so
 * the files there are the commands still running, and background tasks', which outlive their call.
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** How much of a file's end is read: a live view shows its last lines only. */
const TAIL_BYTES = 16 * 1024;
/** a file born this much before the call is still its own: the clocks are one, the stamps are not */
const BIRTH_SLACK_MS = 2000;

/**
 * The output files in a Claude session's temp folder born from `sinceMs` on, oldest first, each as
 * its task id and its last `maxLines` lines. None when there is no `tasks/` folder.
 */
export async function claudeRunningOutputs(sessionDir: string, sinceMs: number, maxLines = 40): Promise<{ id: string; text: string }[]> {
  const dir = join(sessionDir, "tasks");
  let names: string[];
  try { names = (await readdir(dir)).filter((name) => name.endsWith(".output")); } catch { return []; }
  const files = (await Promise.all(names.map(async (name) => {
    try {
      const info = await stat(join(dir, name));
      return info.isFile() ? { name, born: info.birthtimeMs || info.ctimeMs, size: info.size } : null;
    } catch { return null; /* the call ended between the listing and now */ }
  }))).filter((file) => file !== null && file.born >= sinceMs - BIRTH_SLACK_MS) as { name: string; born: number; size: number }[];
  files.sort((a, b) => a.born - b.born || a.name.localeCompare(b.name));
  return (await Promise.all(files.map(async ({ name, size }) => {
    try {
      const handle = await open(join(dir, name), "r");
      try {
        const length = Math.min(size, TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        const text = buffer.toString("utf8");
        // a read that starts inside the file starts inside a line
        return length < size ? text.slice(text.indexOf("\n") + 1) : text;
      } finally { await handle.close(); }
    } catch { return ""; }
  }))).map((text, index) => {
    const lines = text.split("\n");
    while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
    return { id: files[index]!.name.slice(0, -".output".length), text: lines.slice(-maxLines).join("\n") };
  });
}
