import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationTurn } from "../../shared/protocol.ts";
import * as sources from "./sources.ts";
import { conversationSources, fileSources, resetSourceCache } from "./sources.ts";

const dir = mkdtempSync(join(tmpdir(), "pr-sources-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetSourceCache());
const file = (name: string, lines: string[]): string => {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
};

const native = ({ url, timestamp = "2026-10-28T10:00:00Z", command = "gh pr create --fill" }: { url: string; timestamp?: string; command?: string }) => JSON.stringify({
  type: "event_msg", timestamp, payload: { type: "item_completed", item: {
    type: "CommandExecution", id: "exec-one", command: ["/bin/zsh", "-lc", command], cwd: "/w", parsed_cmd: [], status: "completed", exit_code: 0, aggregated_output: url,
  } },
});

describe("a chat's pull request sources", () => {
  it("follows Claude's branch on every message, collapsing repeats", async () => {
    const path = file("claude.jsonl", [
      JSON.stringify({ type: "user", timestamp: "2026-10-28T13:00:00Z", gitBranch: "feat/a" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-28T13:01:00Z", gitBranch: "feat/a" }),
      JSON.stringify({ type: "user", timestamp: "2026-10-28T13:50:00Z", gitBranch: "feat/b" }),
    ]);
    const found = await fileSources(path);
    expect(found.branches).toEqual([{ branch: "feat/a", at: "2026-10-28T13:00:00Z" }, { branch: "feat/b", at: "2026-10-28T13:50:00Z" }]);
    expect(found.started_at).toBe("2026-10-28T13:00:00Z");
  });

  it("takes Codex's branch from its session meta", async () => {
    const path = file("codex.jsonl", [JSON.stringify({ timestamp: "2026-10-28T09:00:00Z", type: "session_meta", payload: { git: { branch: "rd-1", commit_hash: "abc" } } })]);
    expect((await fileSources(path)).branches).toEqual([{ branch: "rd-1", at: "2026-10-28T09:00:00Z" }]);
  });

  it("ignores mentions, skill examples, release notes and other panes' output", async () => {
    const path = file("mentions.jsonl", [
      JSON.stringify({ type: "api-request-blob", message: { role: "user", content: "Example https://github.com/acme/api/pull/999#discussion_r1" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "See https://github.com/acme/api/pull/1" } }),
      native({ url: "https://github.com/acme/api/pull/2", command: "gh pr list --state open" }),
      native({ url: "https://github.com/acme/api/pull/3", command: "gh api repos/actions/runner/releases/latest" }),
      native({ url: "https://github.com/acme/api/pull/4", command: "herdr pane read --target other" }),
      "not JSON https://github.com/acme/api/pull/5",
    ]);
    expect((await fileSources(path)).urls).toEqual([]);
  });

  it("collects a successful native creation once and keeps its original timestamp", async () => {
    const first = native({ url: "https://github.com/acme/api/pull/1931", timestamp: "2026-10-28T13:20:00Z" });
    const path = file("links.jsonl", [first, first, native({ url: "https://github.com/acme/api/pull/1931", timestamp: "2026-10-28T13:30:00Z" })]);
    expect((await fileSources(path)).urls).toEqual([{ url: "https://github.com/acme/api/pull/1931", at: "2026-10-28T13:20:00Z" }]);
  });

  it("pairs Grok's partial updates by session and call ID, using its agent timestamp", async () => {
    const url = "https://github.com/acme/api/pull/41";
    const event = ({ update, session = "one" }: { update: object; session?: string }) => JSON.stringify({ timestamp: 1700000000, method: "session/update", params: {
      sessionId: session, _meta: { agentTimestampMs: Date.parse("2026-10-28T13:00:00Z") }, update,
    } });
    const path = file("grok-partials.jsonl", [
      event({ update: { sessionUpdate: "tool_call", toolCallId: "create", _meta: { "x.ai/tool": { name: "run_terminal_command" } } } }),
      event({ update: { sessionUpdate: "tool_call_update", toolCallId: "create", rawInput: { command: "gh pr create --fill" } } }),
      event({ update: { sessionUpdate: "tool_call", toolCallId: "read", name: "run_terminal_command", rawInput: { command: "gh pr list" } } }),
      event({ update: { sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: url } }] } }),
      event({ session: "other", update: { sessionUpdate: "tool_call_update", toolCallId: "create", status: "completed", content: [{ type: "content", content: { type: "text", text: url } }] } }),
      event({ update: { sessionUpdate: "tool_call_update", toolCallId: "create", content: [{ type: "content", content: { type: "text", text: url } }], rawOutput: { exit_code: 0 } } }),
    ]);
    expect(await fileSources(path)).toEqual({ started_at: "2026-10-28T13:00:00.000Z", branches: [], urls: [] });
    const completed = event({ update: { sessionUpdate: "tool_call_update", toolCallId: "create", rawInput: null, name: null, status: "completed" } });
    appendFileSync(path, completed.slice(0, 40));
    expect((await fileSources(path)).urls).toEqual([]);
    appendFileSync(path, completed.slice(40));
    expect((await fileSources(path)).urls).toEqual([{ url, at: "2026-10-28T13:00:00.000Z" }]);
    appendFileSync(path, "\n");
    expect((await fileSources(path)).urls).toHaveLength(1);
    resetSourceCache();
    expect((await fileSources(path)).urls).toHaveLength(1);
    rmSync(path);
    file("grok-partials.jsonl", [completed]);
    expect((await fileSources(path)).urls).toEqual([]);
  });

  it("ignores failed, timed-out and unseeded Grok creations and copied URLs", async () => {
    const url = "https://github.com/acme/api/pull/41";
    const event = (update: object) => JSON.stringify({ timestamp: 1700000000, method: "session/update", params: { sessionId: "one", update } });
    for (const failure of [{ status: "failed", rawOutput: { exit_code: 0 } }, { status: "completed", rawOutput: { exit_code: 1 } }, { status: "completed", rawOutput: { exit_code: 0, timed_out: true } }]) {
      const path = file("grok-failed.jsonl", [
        event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: url } }),
        event({ sessionUpdate: "tool_call", toolCallId: "create", name: "run_terminal_command", rawInput: { command: "gh pr create --fill" } }),
        event({ sessionUpdate: "tool_call_update", toolCallId: "create", ...failure, content: [{ type: "content", content: { type: "text", text: url } }] }),
        event({ sessionUpdate: "tool_call_update", toolCallId: "missing", status: "completed", rawInput: { command: "gh pr create" }, rawOutput: { output_for_prompt: url, exit_code: 0 } }),
      ]);
      resetSourceCache();
      expect((await fileSources(path)).urls).toEqual([]);
    }
  });

  it("reads a transcript past 32 MiB from its start", async () => {
    const path = join(dir, "huge.jsonl");
    const head = JSON.stringify({ timestamp: "2026-10-28T10:00:00Z", type: "session_meta", payload: { git: { branch: "feature-a" } } }) + "\n"
      + native({ timestamp: "2026-10-28T10:01:00Z", url: "https://github.com/acme/sdk/pull/99" }) + "\n";
    const filler = (JSON.stringify({ timestamp: "2026-10-28T10:08:00Z", text: "x".repeat(1000) }) + "\n").repeat(34_000);
    writeFileSync(path, head + filler);
    const found = await fileSources(path);
    expect(found.urls.map((u) => u.url)).toEqual(["https://github.com/acme/sdk/pull/99"]);
    expect(found.branches.map((b) => b.branch)).toEqual(["feature-a"]);
    expect(found.started_at).toBe("2026-10-28T10:00:00Z");
  });

  it("reads only what was appended since, and a half-written last line once it ends", async () => {
    const path = file("grows.jsonl", [JSON.stringify({ timestamp: "2026-10-28T10:00:00Z", gitBranch: "a" })]);
    await fileSources(path);
    const before = sources.fileBytesRead;
    const added = native({ timestamp: "2026-10-28T10:05:00Z", url: "https://github.com/acme/api/pull/3" });
    appendFileSync(path, added.slice(0, 40));
    await fileSources(path);
    appendFileSync(path, added.slice(40) + "\n");
    const found = await fileSources(path);
    expect(sources.fileBytesRead - before).toBe(added.length + 1);
    expect(found.urls).toEqual([{ url: "https://github.com/acme/api/pull/3", at: "2026-10-28T10:05:00Z" }]);
  });

  it("reads a file again from its start when it was replaced", async () => {
    const path = file("replaced.jsonl", [native({ url: "https://github.com/acme/api/pull/1" })]);
    await fileSources(path);
    renameSync(file("replacement.jsonl", [native({ url: "https://github.com/acme/api/pull/2" })]), path);
    expect((await fileSources(path)).urls.map((u) => u.url)).toEqual(["https://github.com/acme/api/pull/2"]);
  });

  it("pairs a call across partial appends without reusing it after file replacement", async () => {
    const path = file("paired.jsonl", [JSON.stringify({ type: "response_item", payload: {
      type: "function_call", call_id: "create", name: "exec_command", arguments: JSON.stringify({ cmd: "gh pr create --fill" }),
    } })]);
    expect((await fileSources(path)).urls).toEqual([]);
    const answer = JSON.stringify({ type: "response_item", payload: {
      type: "function_call_output", call_id: "create", output: "Process exited with code 0\nFinal output:\nhttps://github.com/acme/api/pull/3",
    } });
    appendFileSync(path, answer.slice(0, 40));
    expect((await fileSources(path)).urls).toEqual([]);
    appendFileSync(path, answer.slice(40));
    expect((await fileSources(path)).urls).toEqual([{ url: "https://github.com/acme/api/pull/3", at: null }]);
    appendFileSync(path, "\n");
    expect((await fileSources(path)).urls).toHaveLength(1);
    resetSourceCache();
    expect((await fileSources(path)).urls).toHaveLength(1);
    rmSync(path);
    file("paired.jsonl", [answer]);
    expect((await fileSources(path)).urls).toEqual([]);
  });

  it("collects links from a shared store's pages: all of them once, the newest after that", async () => {
    const turn = (ts: string, text: string): ConversationTurn => ({ role: "assistant", ts, parts: [{ kind: "tool", name: "bash", input: JSON.stringify({ command: "gh pr create --fill" }), output: text, summary: "", state: "ok" }] });
    const book: Record<string, { turns: ConversationTurn[]; cursor: string | null }> = {
      newest: { turns: [turn("2026-10-28T12:00:00Z", "done")], cursor: "c2" },
      c2: { turns: [turn("2026-10-28T11:00:00Z", "https://github.com/acme/sdk/pull/99")], cursor: "c1" },
      c1: { turns: [turn("2026-10-28T10:00:00Z", "start")], cursor: null },
    };
    const asked: string[] = [];
    const read = async (page: { before?: string }) => { asked.push(page.before ?? "newest"); return book[page.before ?? "newest"]!; };
    const found = await conversationSources("opencode:db:s1", read);
    expect(found.urls).toEqual([{ url: "https://github.com/acme/sdk/pull/99", at: "2026-10-28T11:00:00Z" }]);
    expect(found.started_at).toBe("2026-10-28T10:00:00Z");
    expect(asked).toEqual(["newest", "c2", "c1"]);
    await conversationSources("opencode:db:s1", read);
    expect(asked).toEqual(["newest", "c2", "c1", "newest"]);
  });

  it("reads every page that arrived between two reads of a shared store's chat, and stops at what it read", async () => {
    const turn = (ts: string, text: string): ConversationTurn => ({ role: "assistant", ts, parts: [{ kind: "tool", name: "bash", input: JSON.stringify({ command: "gh pr create --fill" }), output: text, summary: "", state: "ok" }] });
    let book: Record<string, { turns: ConversationTurn[]; cursor: string | null }> = {
      newest: { turns: [turn("2026-10-28T10:00:00Z", "start")], cursor: null },
    };
    const asked: string[] = [];
    const read = async (page: { before?: string }) => { asked.push(page.before ?? "newest"); return book[page.before ?? "newest"]!; };
    await conversationSources("hermes:db:s2", read);
    // two pages arrive while nobody reads: the middle one opened PR #1
    book = {
      newest: { turns: [turn("2026-10-28T12:00:00Z", "later")], cursor: "p2" },
      p2: { turns: [turn("2026-10-28T11:00:00Z", "https://github.com/acme/api/pull/1")], cursor: "p1" },
      p1: { turns: [turn("2026-10-28T10:00:00Z", "start")], cursor: null },
    };
    asked.length = 0;
    const found = await conversationSources("hermes:db:s2", read);
    expect(found.urls.map((u) => u.url)).toEqual(["https://github.com/acme/api/pull/1"]);
    expect(asked).toEqual(["newest", "p2", "p1"]);
  });
});
