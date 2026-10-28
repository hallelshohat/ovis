import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatSources, SOURCE_SCAN_BYTES } from "./sources.ts";

const dir = mkdtempSync(join(tmpdir(), "pr-sources-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, lines: string[]): string => {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
};

describe("a chat's pull request sources", () => {
  it("follows Claude's branch on every message, collapsing repeats", async () => {
    const path = file("claude.jsonl", [
      JSON.stringify({ type: "user", timestamp: "2026-10-28T13:00:00Z", gitBranch: "feat/a" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-28T13:01:00Z", gitBranch: "feat/a" }),
      JSON.stringify({ type: "user", timestamp: "2026-10-28T13:50:00Z", gitBranch: "feat/b" }),
    ]);
    const sources = await chatSources(path, "claude-transcript");
    expect(sources.branches).toEqual([{ branch: "feat/a", at: "2026-10-28T13:00:00Z" }, { branch: "feat/b", at: "2026-10-28T13:50:00Z" }]);
    expect(sources.started_at).toBe("2026-10-28T13:00:00Z");
  });

  it("takes Codex's branch from its session meta", async () => {
    const path = file("codex.jsonl", [JSON.stringify({ timestamp: "2026-10-28T09:00:00Z", type: "session_meta", payload: { git: { branch: "rd-1", commit_hash: "abc" } } })]);
    expect((await chatSources(path, "codex-transcript")).branches).toEqual([{ branch: "rd-1", at: "2026-10-28T09:00:00Z" }]);
  });

  it("collects each GitHub pull request link once, at its first sighting, normalized", async () => {
    const path = file("links.jsonl", [
      JSON.stringify({ timestamp: "2026-10-28T13:20:00Z", message: { content: [{ type: "tool_result", content: "https://github.com/acme/api/pull/1931\n" }] } }),
      JSON.stringify({ timestamp: "2026-10-28T13:30:00Z", message: { content: "see https://github.com/acme/api/pull/1931 and https://github.com/acme/client-sdk/pull/88/files" } }),
      "not json, but https://github.com/acme/api/pull/7 is still a link",
    ]);
    const sources = await chatSources(path, "claude-transcript");
    expect(sources.urls).toEqual([
      { url: "https://github.com/acme/api/pull/1931", at: "2026-10-28T13:20:00Z" },
      { url: "https://github.com/acme/client-sdk/pull/88", at: "2026-10-28T13:30:00Z" },
      { url: "https://github.com/acme/api/pull/7", at: null },
    ]);
  });

  it("reads only the end of a huge transcript, skipping the cut first line", async () => {
    const path = join(dir, "huge.jsonl");
    const head = JSON.stringify({ timestamp: "2026-10-28T08:00:00Z", text: "https://github.com/acme/api/pull/1" }) + "\n";
    const filler = (JSON.stringify({ text: "x".repeat(1000) }) + "\n").repeat(Math.ceil((SOURCE_SCAN_BYTES + 8 * 1024 * 1024) / 1012));
    const tail = JSON.stringify({ timestamp: "2026-10-28T20:00:00Z", text: "https://github.com/acme/api/pull/2" }) + "\n";
    writeFileSync(path, head + filler + tail);
    const sources = await chatSources(path, "claude-transcript");
    expect(sources.urls.map((u) => u.url)).toEqual(["https://github.com/acme/api/pull/2"]);
  });

  it("reads nothing from a database store, which holds other chats too", async () => {
    const path = file("store.db", ["https://github.com/acme/api/pull/3"]);
    expect(await chatSources(path, "opencode-transcript")).toEqual({ urls: [], branches: [], started_at: null });
  });
});
