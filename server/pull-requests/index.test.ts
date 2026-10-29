import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "./gh.ts";
import { OPEN_TTL_MS, panePullRequests, resetPullRequestCache, type PrDeps } from "./index.ts";
import { fileChat, type Chat } from "./sources.ts";

const dir = mkdtempSync(join(tmpdir(), "pr-index-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetPullRequestCache());

const raw = (number: number, repo: string, over: Record<string, unknown>) => ({
  number, url: `https://github.com/${repo}/pull/${number}`, title: `PR ${number}`, state: "OPEN", isDraft: false, reviewDecision: "",
  headRefName: "h", baseRefName: "main", additions: 1, deletions: 0, createdAt: "2026-10-28T13:00:00Z", mergedAt: null, closedAt: null,
  updatedAt: "2026-10-28T13:00:00Z", statusCheckRollup: [], ...over,
});
// the mock's chat: #1925 opened and merged on feat/idempotent, a switch to feat/replay-metric, #1931 there, client-sdk#88 failing
const VIEWS: Record<string, unknown> = {
  "https://github.com/acme/api/pull/1925": raw(1925, "acme/api", { state: "MERGED", headRefName: "feat/idempotent", createdAt: "2026-10-28T13:20:00Z", mergedAt: "2026-10-28T13:41:00Z", closedAt: "2026-10-28T13:41:00Z" }),
  "https://github.com/acme/client-sdk/pull/88": raw(88, "acme/client-sdk", { createdAt: "2026-10-28T14:15:00Z", statusCheckRollup: [{ __typename: "CheckRun", name: "Integration", status: "COMPLETED", conclusion: "FAILURE" }] }),
};
const LISTS: Record<string, unknown[]> = {
  "feat/idempotent": [VIEWS["https://github.com/acme/api/pull/1925"]],
  "feat/replay-metric": [raw(1931, "acme/api", { headRefName: "feat/replay-metric", createdAt: "2026-10-28T14:09:00Z", statusCheckRollup: [{ __typename: "CheckRun", name: "Fast", status: "IN_PROGRESS", conclusion: "" }] })],
  main: [raw(1500, "acme/api", { state: "MERGED", headRefName: "main", createdAt: "2026-09-01T00:00:00Z", mergedAt: "2026-09-02T00:00:00Z" })],
};

function fakeGh(options: { installed?: boolean } = {}): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = async (argv) => {
    calls.push(argv);
    if (options.installed === false && argv[0] === "gh") return null;
    if (argv[0] === "git") return { code: 0, stdout: "feat/replay-metric\n", stderr: "" };
    if (argv[1] === "repo") return { code: 0, stdout: '{"nameWithOwner":"acme/api"}', stderr: "" };
    if (argv[1] === "pr" && argv[2] === "list") return { code: 0, stdout: JSON.stringify(LISTS[argv[4]!] ?? []), stderr: "" };
    if (argv[1] === "pr" && argv[2] === "view") return VIEWS[argv[3]!] ? { code: 0, stdout: JSON.stringify(VIEWS[argv[3]!]), stderr: "" } : { code: 1, stdout: "", stderr: "not found" };
    return { code: 1, stdout: "", stderr: "" };
  };
  return { run, calls };
}

function transcript(name: string, lines: object[]): Chat {
  const path = join(dir, name);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return fileChat(path);
}
const chat = () => transcript("chat.jsonl", [
  { timestamp: "2026-10-28T13:00:00Z", gitBranch: "feat/idempotent", message: { content: "make retries idempotent" } },
  { timestamp: "2026-10-28T13:20:00Z", gitBranch: "feat/idempotent", message: { content: "https://github.com/acme/api/pull/1925" } },
  { timestamp: "2026-10-28T13:52:00Z", gitBranch: "feat/replay-metric", message: { content: "now the metric" } },
  { timestamp: "2026-10-28T14:15:00Z", gitBranch: "feat/replay-metric", message: { content: "https://github.com/acme/client-sdk/pull/88" } },
]);
const deps = (run: Run, now = Date.parse("2026-10-28T14:30:00Z")): PrDeps => ({ run, now: () => now, currentBranch: async () => "feat/replay-metric" });

describe("a pane's pull requests", () => {
  it("lists the chat's PRs by attention, and its events in time order", async () => {
    const { run } = fakeGh();
    const answer = await panePullRequests({ paneId: "p1", cwd: "/w", chat: chat(), fresh: false }, deps(run));
    expect(answer.gh).toBe("ok");
    expect(answer.pull_requests.map((pr) => `${pr.repo}#${pr.number}`)).toEqual(["acme/client-sdk#88", "acme/api#1931", "acme/api#1925"]);
    expect(answer.events.map((event) => event.kind === "branch" ? `branch ${event.from}>${event.to}` : `${event.kind} ${event.url.split("/").pop()}`))
      .toEqual(["opened 1925", "merged 1925", "branch feat/idempotent>feat/replay-metric", "opened 1931", "opened 88"]);
  });

  it("drops a PR that ended before the chat began unless the chat links it", async () => {
    const { run } = fakeGh();
    const onMain = transcript("main.jsonl", [{ timestamp: "2026-10-28T13:00:00Z", gitBranch: "main" }]);
    const quiet = await panePullRequests({ paneId: "p2", cwd: "/w", chat: onMain, fresh: false }, { ...deps(run), currentBranch: async () => "main" });
    expect(quiet.pull_requests).toEqual([]);
    VIEWS["https://github.com/acme/api/pull/1500"] = LISTS["main"]![0];
    resetPullRequestCache();
    const linked = transcript("linked.jsonl", [{ timestamp: "2026-10-28T13:00:00Z", gitBranch: "main", message: { content: "look at https://github.com/acme/api/pull/1500" } }]);
    const kept = await panePullRequests({ paneId: "p2", cwd: "/w", chat: linked, fresh: false }, { ...deps(run), currentBranch: async () => "main" });
    expect(kept.pull_requests.map((pr) => pr.number)).toEqual([1500]);
  });

  it("asks gh nothing again within a minute, and a fresh read never re-reads a merged PR", async () => {
    const { run, calls } = fakeGh();
    const at = Date.parse("2026-10-28T14:30:00Z");
    await panePullRequests({ paneId: "p3", cwd: "/w", chat: chat(), fresh: false }, deps(run, at));
    const gh = () => calls.filter((call) => call[0] === "gh").length;
    const first = gh();
    await panePullRequests({ paneId: "p3", cwd: "/w", chat: chat(), fresh: false }, deps(run, at + OPEN_TTL_MS - 1));
    expect(gh()).toBe(first);
    const before = calls.length;
    await panePullRequests({ paneId: "p3", cwd: "/w", chat: chat(), fresh: true }, deps(run, at + 1000));
    const again = calls.slice(before).filter((call) => call[0] === "gh");
    expect(again.some((call) => call[3] === "https://github.com/acme/api/pull/1925")).toBe(false);
    expect(again.some((call) => call[3] === "https://github.com/acme/client-sdk/pull/88")).toBe(true);
  });

  it("says gh is missing and still shows the branch switches", async () => {
    const { run } = fakeGh({ installed: false });
    const answer = await panePullRequests({ paneId: "p4", cwd: "/w", chat: chat(), fresh: false }, deps(run));
    expect(answer.gh).toBe("missing");
    expect(answer.pull_requests).toEqual([]);
    expect(answer.events.map((event) => event.kind)).toEqual(["branch"]);
  });

  it("follows a branch switch it sees itself when the transcript names no branch", async () => {
    const { run } = fakeGh();
    let branch = "feat/idempotent";
    const plain: Chat = { id: "opencode:none", read: async () => ({ urls: [], branches: [], started_at: null }) };
    const base = { run, currentBranch: async () => branch };
    await panePullRequests({ paneId: "p5", cwd: "/w", chat: plain, fresh: false }, { ...base, now: () => Date.parse("2026-10-28T13:30:00Z") });
    branch = "feat/replay-metric";
    const answer = await panePullRequests({ paneId: "p5", cwd: "/w", chat: plain, fresh: true }, { ...base, now: () => Date.parse("2026-10-28T14:00:00Z") });
    expect(answer.events.filter((event) => event.kind === "branch")).toEqual([{ at: "2026-10-28T14:00:00.000Z", kind: "branch", from: "feat/idempotent", to: "feat/replay-metric" }]);
    expect(answer.pull_requests.map((pr) => pr.number).sort()).toEqual([1925, 1931]);
  });
});

describe("a chat's own pull requests, as review found them", () => {
  const listing = (lists: Record<string, unknown[]>, views: Record<string, unknown> = {}, repo = "acme/api"): Run => async (argv) => {
    if (argv[0] === "git") return { code: 0, stdout: "x\n", stderr: "" };
    if (argv[1] === "repo") return { code: 0, stdout: JSON.stringify({ nameWithOwner: repo }), stderr: "" };
    if (argv[2] === "list") return { code: 0, stdout: JSON.stringify(lists[argv[4]!] ?? []), stderr: "" };
    if (argv[2] === "view") return views[argv[3]!] ? { code: 0, stdout: JSON.stringify(views[argv[3]!]), stderr: "" } : { code: 1, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  const at = (iso: string) => Date.parse(iso);

  it("does not hand a new chat in the same pane the last chat's branches", async () => {
    const run = listing({
      "feature-a": [raw(1, "acme/api", { headRefName: "feature-a", createdAt: "2026-10-28T10:05:00Z" })],
      "feature-b": [raw(2, "acme/api", { headRefName: "feature-b", createdAt: "2026-10-28T11:05:00Z" })],
    });
    const a = transcript("chat-a.jsonl", [{ timestamp: "2026-10-28T10:00:00Z", gitBranch: "feature-a" }]);
    await panePullRequests({ paneId: "same", cwd: "/w", chat: a, fresh: false }, { run, now: () => at("2026-10-28T10:30:00Z"), currentBranch: async () => "feature-a" });
    const b = transcript("chat-b.jsonl", [{ timestamp: "2026-10-28T11:00:00Z", gitBranch: "feature-b" }]);
    const answer = await panePullRequests({ paneId: "same", cwd: "/w", chat: b, fresh: false }, { run, now: () => at("2026-10-28T11:30:00Z"), currentBranch: async () => "feature-b" });
    expect(answer.pull_requests.map((pr) => pr.number)).toEqual([2]);
  });

  it("keeps a return to a branch the transcript named as its own switch", async () => {
    const run = listing({});
    const path = join(dir, "codex-return.jsonl");
    writeFileSync(path, JSON.stringify({ timestamp: "2026-10-28T10:00:00Z", type: "session_meta", payload: { git: { branch: "feature-a" } } }) + "\n");
    const chat = fileChat(path);
    let branch = "feature-a";
    const ask = (when: string) => panePullRequests({ paneId: "ret", cwd: "/w", chat, fresh: true }, { run, now: () => at(when), currentBranch: async () => branch });
    await ask("2026-10-28T10:10:00Z");
    branch = "feature-b";
    await ask("2026-10-28T10:20:00Z");
    branch = "feature-a";
    const answer = await ask("2026-10-28T10:30:00Z");
    expect(answer.events.filter((event) => event.kind === "branch").map((event) => event.kind === "branch" ? `${event.from}>${event.to}` : "")).toEqual(["feature-a>feature-b", "feature-b>feature-a"]);
  });

  it("keeps a merged PR as it was first read when its branch list is read again", async () => {
    const merged = (title: string) => raw(5, "acme/api", { title, state: "MERGED", headRefName: "feature-a", createdAt: "2026-10-28T10:05:00Z", mergedAt: "2026-10-28T10:20:00Z" });
    const lists: Record<string, unknown[]> = { "feature-a": [merged("Original")] };
    const chat = transcript("merged.jsonl", [{ timestamp: "2026-10-28T10:00:00Z", gitBranch: "feature-a" }]);
    const ask = (when: string) => panePullRequests({ paneId: "m", cwd: "/w", chat, fresh: false }, { run: listing(lists), now: () => at(when), currentBranch: async () => "feature-a" });
    expect((await ask("2026-10-28T10:30:00Z")).pull_requests[0]!.title).toBe("Original");
    lists["feature-a"] = [merged("Changed on GitHub after merge")];
    expect((await ask(new Date(at("2026-10-28T10:30:00Z") + OPEN_TTL_MS + 1000).toISOString())).pull_requests[0]!.title).toBe("Original");
  });

  it("says whether a PR is in the asking pane's own repository, whoever read it first", async () => {
    const sdk = raw(99, "acme/sdk", { createdAt: "2026-10-28T10:05:00Z" });
    const views = { "https://github.com/acme/sdk/pull/99": sdk };
    const linked = transcript("linked-sdk.jsonl", [{ timestamp: "2026-10-28T10:00:00Z", message: { content: "https://github.com/acme/sdk/pull/99" } }]);
    const now = () => at("2026-10-28T10:30:00Z");
    const api = (fresh: boolean) => panePullRequests({ paneId: "api", cwd: "/api", chat: linked, fresh }, { run: listing({}, views, "acme/api"), now, currentBranch: async () => null });
    expect((await api(true)).pull_requests[0]!.own).toBe(false);
    const sdkPane = await panePullRequests({ paneId: "sdk", cwd: "/sdk", chat: linked, fresh: true }, { run: listing({}, views, "acme/sdk"), now, currentBranch: async () => null });
    expect(sdkPane.pull_requests[0]!.own).toBe(true);
    // from the cache the SDK pane filled: still another repository's here
    expect((await api(false)).pull_requests[0]!.own).toBe(false);
  });

  it("counts the chat's links even when gh cannot read them", async () => {
    const { run } = fakeGh({ installed: false });
    const answer = await panePullRequests({ paneId: "count", cwd: "/w", chat: chat(), fresh: false }, deps(run));
    expect([answer.gh, answer.linked]).toEqual(["missing", 2]);
  });
});
