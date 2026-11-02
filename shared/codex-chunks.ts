/**
 * Codex exec sessions as its rollout records them, read by the chat's live output
 * (src/lib/workBlocks.ts) and the background-task list (server/codex-background.ts). Codex runs a
 * command that outlives its first wait in an exec session: the call's answer names the session
 * (`"session_id":N`, or `Process running with session ID N` from a native call), each later poll
 * (`write_stdin`) answers with what the command printed since, and the answer that names an
 * `exit_code` (`Process exited with code K`) is its last.
 */

/** Every Codex exec session a call's input names (a poll's `session_id`), in order. */
export const codexInputSessions = (input: string): string[] => [...input.matchAll(/session_id\W{1,3}(\d+)/g)].map((match) => match[1]!);

/** A JSON string's body from its first character on, read as far as it goes: a page may carry it cut (`… trimmed`). */
function jsonStringAt(text: string, at: number): { value: string; end: number } {
  const body = /^(?:[^"\\]|\\.)*/.exec(text.slice(at))![0];
  // a cut string may stop inside an escape: what is left of it is dropped
  const whole = body.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, "");
  try { return { value: JSON.parse(`"${whole}"`) as string, end: at + body.length + 1 }; } catch { return { value: "", end: at + body.length + 1 }; }
}

export interface CodexChunk {
  /** the session it came from, null when the chunk does not say */
  session: string | null;
  text: string;
  /** what the command exited with, when this chunk is its last */
  exitCode: number | null;
}

/**
 * The chunks of command output one Codex exec call read. A native call's text starts with its own
 * envelope (`Process running with session ID N` or `Process exited with code K`, then `Output:`):
 * the first `Output:` line is the envelope's, whatever the command printed after it. An exec
 * cell's answer holds one JSON object per tool it ran, several sessions side by side when it ran
 * several commands.
 */
export function codexChunks(output: string): CodexChunk[] {
  const text = output.replace(/\n… trimmed$/, "");
  const envelope = text.indexOf("Output:\n");
  if (envelope !== -1) {
    const head = text.slice(0, envelope);
    const native = /session ID (\d+)/.exec(head);
    const exited = /Process exited with code (\d+)/.exec(head);
    if (native !== null || exited !== null) return [{ session: native?.[1] ?? null, text: text.slice(envelope + "Output:\n".length), exitCode: exited === null ? null : Number(exited[1]) }];
  }
  const chunks: CodexChunk[] = [];
  for (const match of text.matchAll(/"output":"/g)) {
    const at = match.index + match[0].length;
    const { value, end } = jsonStringAt(text, at);
    // the session is a key of the same object: before the output, back to its brace, or after it, up to its close
    const before = text.slice(text.lastIndexOf("{", match.index) + 1, match.index);
    const after = text.slice(end, text.indexOf("}", end) === -1 ? undefined : text.indexOf("}", end));
    const session = /"session_id":\s*(\d+)/.exec(before)?.[1] ?? /"session_id":\s*(\d+)/.exec(after)?.[1] ?? null;
    const exit = /"exit_code":\s*(\d+)/.exec(before)?.[1] ?? /"exit_code":\s*(\d+)/.exec(after)?.[1];
    chunks.push({ session, text: value, exitCode: exit === undefined ? null : Number(exit) });
  }
  return chunks;
}
