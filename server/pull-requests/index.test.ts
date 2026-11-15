import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardRunner } from "../board-routes.ts";
import type { Run } from "./gh.ts";
import { OPEN_TTL_MS, panePullRequests, resetPullRequestCache, type PrDeps } from "./index.ts";
import { fileChat, type Chat } from "./sources.ts";

const dir = mkdtempSync(join(tmpdir(), "pr-index-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetPullRequestCache());

const noBoard: BoardRunner = async () => null;

const raw = (number: number, repo: string, over: Record<string, unknown>) => ({
  number, author: { login: "owner" }, url: `https://github.com/${repo}/pull/${number}`, title: `PR ${number}`, state: "OPEN", isDraft: false, reviewDecision: "",
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
    if (argv[1] === "api") return { code: 0, stdout: '{"login":"owner"}', stderr: "" };
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
const chat = (): Chat => ({ id: "chat", read: async () => ({
  urls: [{ url: "https://github.com/acme/api/pull/1925", at: "2026-10-28T13:20:00Z" }, { url: "https://github.com/acme/client-sdk/pull/88", at: "2026-10-28T14:15:00Z" }],
  branches: [{ branch: "feat/idempotent", at: "2026-10-28T13:00:00Z" }, { branch: "feat/replay-metric", at: "2026-10-28T13:52:00Z" }], started_at: "2026-10-28T13:00:00Z",
}) });
const deps = (run: Run, now = Date.parse("2026-10-28T14:30:00Z")): PrDeps => ({ board: noBoard, run, now: () => now, currentBranch: async () => "feat/replay-metric" });

describe("a pane's pull requests", () => {
  it("lists the chat's PRs by attention, and its events in time order", async () => {
    const { run } = fakeGh();
    const answer = await panePullRequests({ paneId: "p1", cwd: "/w", chat: chat(), fresh: false }, deps(run));
    expect(answer.gh).toBe("ok");
    expect(answer.pull_requests.map((pr) => `${pr.repo}#${pr.number}`)).toEqual(["acme/client-sdk#88", "acme/api#1931", "acme/api#1925"]);
    expect(answer.events.map((event) => event.kind === "branch" ? `branch ${event.from}>${event.to}` : `${event.kind} ${event.url.split("/").pop()}`))
      .toEqual(["opened 1925", "merged 1925", "branch feat/idempotent>feat/replay-metric", "opened 1931", "opened 88"]);
  });

  it("drops an old reused-branch PR even when the chat mentions it", async () => {
    const { run } = fakeGh();
    const onMain = transcript("main.jsonl", [{ timestamp: "2026-10-28T13:00:00Z", gitBranch: "main" }]);
    const quiet = await panePullRequests({ paneId: "p2", cwd: "/w", chat: onMain, fresh: false }, { ...deps(run), currentBranch: async () => "main" });
    expect(quiet.pull_requests).toEqual([]);
    VIEWS["https://github.com/acme/api/pull/1500"] = LISTS["main"]![0];
    resetPullRequestCache();
    const linked = transcript("linked.jsonl", [{ timestamp: "2026-10-28T13:00:00Z", gitBranch: "main", message: { content: "look at https://github.com/acme/api/pull/1500" } }]);
    const kept = await panePullRequests({ paneId: "p2", cwd: "/w", chat: linked, fresh: false }, { ...deps(run), currentBranch: async () => "main" });
    expect(kept.pull_requests).toEqual([]);
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
    const base = { board: noBoard, run, currentBranch: async () => branch };
    await panePullRequests({ paneId: "p5", cwd: "/w", chat: plain, fresh: false }, { ...base, now: () => Date.parse("2026-10-28T13:30:00Z") });
    branch = "feat/replay-metric";
    const answer = await panePullRequests({ paneId: "p5", cwd: "/w", chat: plain, fresh: true }, { ...base, now: () => Date.parse("2026-10-28T14:00:00Z") });
    expect(answer.events.filter((event) => event.kind === "branch")).toEqual([{ at: "2026-10-28T14:00:00.000Z", kind: "branch", from: "feat/idempotent", to: "feat/replay-metric" }]);
    expect(answer.pull_requests.map((pr) => pr.number)).toEqual([1931]);
  });
});

describe("a chat's own pull requests, as review found them", () => {
  const listing = (lists: Record<string, unknown[]>, views: Record<string, unknown> = {}, repo = "acme/api"): Run => async (argv) => {
    if (argv[1] === "api") return { code: 0, stdout: '{"login":"owner"}', stderr: "" };
    if (argv[0] === "git") return { code: 0, stdout: "x\n", stderr: "" };
    if (argv[1] === "repo") return { code: 0, stdout: JSON.stringify({ nameWithOwner: repo }), stderr: "" };
    if (argv[2] === "list") return { code: 0, stdout: JSON.stringify(lists[argv[4]!] ?? []), stderr: "" };
    if (argv[2] === "view") return views[argv[3]!] ? { code: 0, stdout: JSON.stringify(views[argv[3]!]), stderr: "" } : { code: 1, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  const at = (iso: string) => Date.parse(iso);

  it("rejects other authors, prefix heads, matching bases and old reused-branch PRs", async () => {
    const branch = "feature-a";
    const rows = [
      raw(1, "acme/api", { headRefName: branch }),
      raw(2, "acme/api", { headRefName: branch, author: { login: "teammate" } }),
      raw(3, "acme/api", { headRefName: `${branch}-other` }),
      raw(4, "acme/api", { headRefName: "stacked-child", baseRefName: branch }),
      raw(5, "acme/api", { headRefName: branch, state: "CLOSED", createdAt: "2026-01-01T00:00:00Z", closedAt: "2026-10-28T14:00:00Z" }),
      raw(6, "acme/api", { headRefName: branch, state: "MERGED", mergedAt: "2026-10-28T14:00:00Z" }),
      raw(7, "acme/api", { headRefName: branch, state: "CLOSED", closedAt: "2026-10-28T14:00:00Z" }),
      raw(8, "acme/other", { headRefName: branch }),
    ];
    const c = transcript("matching.jsonl", [{ timestamp: "2026-10-28T12:00:00Z", gitBranch: "old-branch" }]);
    const run = listing({ [branch]: rows, "old-branch": [raw(9, "acme/api", { headRefName: "old-branch" })] });
    const answer = await panePullRequests({ paneId: "matching", cwd: "/w", chat: c, fresh: true }, { ...deps(run), currentBranch: async () => branch });
    expect(answer.pull_requests.map((pr) => pr.number)).toEqual([1, 6, 7]);
    expect(answer.events.filter((event) => event.kind !== "branch").every((event) => [1, 6, 7].some((n) => event.url.endsWith(`/${n}`)))).toBe(true);
    expect(answer.pull_requests.every((pr) => !("author" in pr))).toBe(true);
  });

  it("keeps the board's completed PR through a new chat, plus its additional exact-head PR", async () => {
    const one = raw(1, "acme/api", { headRefName: "old-head", state: "MERGED", createdAt: "2026-10-20T00:00:00Z", mergedAt: "2026-10-21T00:00:00Z" });
    const two = raw(2, "acme/api", { headRefName: "feature-a", state: "CLOSED", createdAt: "2026-10-22T00:00:00Z", closedAt: "2026-10-23T00:00:00Z" });
    const run = listing({ "feature-a": [two] }, { [one.url]: one });
    const board: BoardRunner = async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ tasks: [{ id: "api/1", worktree: "/w", branch: "feature-a", pr: one.url, created: at("2026-10-19T00:00:00Z") }] }) });
    for (const c of [null, transcript("replacement.jsonl", [{ timestamp: "2026-10-28T12:00:00Z" }])]) {
      const answer = await panePullRequests({ paneId: "board", cwd: "/w", chat: c, fresh: true }, { ...deps(run), board, currentBranch: async () => "feature-a" });
      expect(answer.pull_requests.map((pr) => [pr.number, pr.state])).toEqual([[1, "merged"], [2, "closed"]]);
      expect(answer.linked).toBe(1);
    }
  });

  it("requires the viewer's author even for a board PR or a creation result", async () => {
    const other = raw(1, "acme/api", { author: { login: "someone-else" } });
    const run = listing({}, { [other.url]: other });
    const c: Chat = { id: "created", read: async () => ({ urls: [{ url: other.url, at: null }], branches: [], started_at: null }) };
    const board: BoardRunner = async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ tasks: [{ id: "api/1", worktree: "/w", branch: "h", pr: other.url, created: 0 }] }) });
    const answer = await panePullRequests({ paneId: "foreign", cwd: "/w", chat: c, fresh: true }, { ...deps(run), board });
    expect(answer.pull_requests).toEqual([]);
    expect(answer.events).toEqual([]);
    expect(answer.linked).toBe(0);
  });

  it("keeps an agent-created closed PR after a branch switch and a server restart", async () => {
    const created = raw(1, "acme/api", { headRefName: "previous", state: "CLOSED", closedAt: "2026-10-28T14:00:00Z" });
    const run = listing({}, { [created.url]: created });
    const c = transcript("created-closed.jsonl", [
      { type: "assistant", timestamp: "2026-10-28T12:00:00Z", gitBranch: "previous", message: { role: "assistant", content: [{ type: "tool_use", id: "create", name: "Bash", input: { command: "gh pr create --fill" } }] } },
      { type: "user", timestamp: "2026-10-28T13:00:00Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "create", content: created.url, is_error: false }] } },
    ]);
    const ask = () => panePullRequests({ paneId: "created", cwd: "/w", chat: c, fresh: false }, { ...deps(run), currentBranch: async () => "next" });
    expect((await ask()).pull_requests.map((pr) => [pr.number, pr.state])).toEqual([[1, "closed"]]);
    resetPullRequestCache();
    expect((await ask()).pull_requests.map((pr) => [pr.number, pr.state])).toEqual([[1, "closed"]]);
  });

  it("does not resurrect completed branch PRs without a known start or after reusing a branch in a new chat", async () => {
    const run = listing({ "feature-a": [raw(1, "acme/api", { headRefName: "feature-a", state: "CLOSED", closedAt: "2026-10-28T14:00:00Z" })] });
    const ask = (chat: Chat | null) => panePullRequests({ paneId: "reused", cwd: "/w", chat, fresh: false }, { ...deps(run), currentBranch: async () => "feature-a" });
    expect((await ask(null)).pull_requests).toEqual([]);
    expect((await ask(transcript("before.jsonl", [{ timestamp: "2026-10-28T12:00:00Z" }]))).pull_requests.map((pr) => pr.number)).toEqual([1]);
    expect((await ask(transcript("after.jsonl", [{ timestamp: "2026-10-29T12:00:00Z" }]))).pull_requests).toEqual([]);
  });

  it("does not share in-flight ownership between checkouts, and refreshes the signed-in author", async () => {
    const one = raw(1, "acme/api", { headRefName: "feature-a" });
    let login = "owner";
    const base = listing({ "feature-a": [one] });
    const run: Run = async (argv, cwd, timeout) => argv[1] === "api" ? { code: 0, stdout: JSON.stringify({ login }), stderr: "" } : base(argv, cwd, timeout);
    const ask = (cwd: string) => panePullRequests({ paneId: "same", cwd, chat: null, fresh: true }, { ...deps(run), currentBranch: async (path) => path === "/one" ? "feature-a" : "different" });
    const [oneAnswer, twoAnswer] = await Promise.all([ask("/one"), ask("/two")]);
    expect(oneAnswer.pull_requests.map((pr) => pr.number)).toEqual([1]);
    expect(twoAnswer.pull_requests).toEqual([]);
    login = "another-account";
    expect((await ask("/one")).pull_requests).toEqual([]);
  });

  it("does not hand a new chat in the same pane the last chat's branches", async () => {
    const run = listing({
      "feature-a": [raw(1, "acme/api", { headRefName: "feature-a", createdAt: "2026-10-28T10:05:00Z" })],
      "feature-b": [raw(2, "acme/api", { headRefName: "feature-b", createdAt: "2026-10-28T11:05:00Z" })],
    });
    const a = transcript("chat-a.jsonl", [{ timestamp: "2026-10-28T10:00:00Z", gitBranch: "feature-a" }]);
    await panePullRequests({ paneId: "same", cwd: "/w", chat: a, fresh: false }, { board: noBoard, run, now: () => at("2026-10-28T10:30:00Z"), currentBranch: async () => "feature-a" });
    const b = transcript("chat-b.jsonl", [{ timestamp: "2026-10-28T11:00:00Z", gitBranch: "feature-b" }]);
    const answer = await panePullRequests({ paneId: "same", cwd: "/w", chat: b, fresh: false }, { board: noBoard, run, now: () => at("2026-10-28T11:30:00Z"), currentBranch: async () => "feature-b" });
    expect(answer.pull_requests.map((pr) => pr.number)).toEqual([2]);
  });

  it("keeps a return to a branch the transcript named as its own switch", async () => {
    const run = listing({});
    const path = join(dir, "codex-return.jsonl");
    writeFileSync(path, JSON.stringify({ timestamp: "2026-10-28T10:00:00Z", type: "session_meta", payload: { git: { branch: "feature-a" } } }) + "\n");
    const chat = fileChat(path);
    let branch = "feature-a";
    const ask = (when: string) => panePullRequests({ paneId: "ret", cwd: "/w", chat, fresh: true }, { board: noBoard, run, now: () => at(when), currentBranch: async () => branch });
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
    const ask = (when: string) => panePullRequests({ paneId: "m", cwd: "/w", chat, fresh: false }, { board: noBoard, run: listing(lists), now: () => at(when), currentBranch: async () => "feature-a" });
    expect((await ask("2026-10-28T10:30:00Z")).pull_requests[0]!.title).toBe("Original");
    lists["feature-a"] = [merged("Changed on GitHub after merge")];
    expect((await ask(new Date(at("2026-10-28T10:30:00Z") + OPEN_TTL_MS + 1000).toISOString())).pull_requests[0]!.title).toBe("Original");
  });

  it("says whether a PR is in the asking pane's own repository, whoever read it first", async () => {
    const sdk = raw(99, "acme/sdk", { createdAt: "2026-10-28T10:05:00Z" });
    const views = { "https://github.com/acme/sdk/pull/99": sdk };
    const linked: Chat = { id: "created-sdk", read: async () => ({ urls: [{ url: "https://github.com/acme/sdk/pull/99", at: "2026-10-28T10:05:00Z" }], branches: [], started_at: "2026-10-28T10:00:00Z" }) };
    const now = () => at("2026-10-28T10:30:00Z");
    const api = (fresh: boolean) => panePullRequests({ paneId: "api", cwd: "/api", chat: linked, fresh }, { board: noBoard, run: listing({}, views, "acme/api"), now, currentBranch: async () => null });
    expect((await api(true)).pull_requests[0]!.own).toBe(false);
    const sdkPane = await panePullRequests({ paneId: "sdk", cwd: "/sdk", chat: linked, fresh: true }, { board: noBoard, run: listing({}, views, "acme/sdk"), now, currentBranch: async () => null });
    expect(sdkPane.pull_requests[0]!.own).toBe(true);
    // from the cache the SDK pane filled: still another repository's here
    expect((await api(false)).pull_requests[0]!.own).toBe(false);
  });

  it("counts the chat's links even when gh cannot read them", async () => {
    const { run } = fakeGh({ installed: false });
    const answer = await panePullRequests({ paneId: "count", cwd: "/w", chat: chat(), fresh: false }, deps(run));
    expect([answer.gh, answer.linked]).toEqual(["missing", 2]);
  });

  it("keeps a known open PR when gh fails on a fresh read, and says error when nothing is known", async () => {
    let down = false;
    const up = listing({ "feature-a": [raw(7, "acme/api", { headRefName: "feature-a", createdAt: "2026-10-28T10:05:00Z" })] });
    const run: Run = async (argv, cwd, timeout) => (down && argv[1] === "pr" ? { code: 1, stdout: "", stderr: "HTTP 503" } : up(argv, cwd, timeout));
    const chat = transcript("down.jsonl", [{ timestamp: "2026-10-28T10:00:00Z", gitBranch: "feature-a" }]);
    const ask = (paneId: string, c: Chat) => panePullRequests({ paneId, cwd: "/w", chat: c, fresh: true }, { board: noBoard, run, now: () => at("2026-10-28T10:30:00Z"), currentBranch: async () => "feature-a" });
    expect((await ask("down", chat)).pull_requests.map((pr) => pr.number)).toEqual([7]);
    down = true;
    const kept = await ask("down", chat);
    expect([kept.gh, kept.pull_requests.map((pr) => pr.number)]).toEqual(["ok", [7]]);
    resetPullRequestCache();
    const none = await ask("fresh-down", transcript("down2.jsonl", [{ timestamp: "2026-10-28T10:00:00Z", gitBranch: "feature-a" }]));
    expect([none.gh, none.pull_requests]).toEqual(["error", []]);
  });

  it("keeps a resumed chat's switches but discovers only its current branch's PRs", async () => {
    const run = listing({
      "feature-a": [raw(1, "acme/api", { headRefName: "feature-a", createdAt: "2026-10-28T10:05:00Z" })],
      "feature-b": [raw(2, "acme/api", { headRefName: "feature-b", createdAt: "2026-10-28T10:25:00Z" })],
    });
    const chat: Chat = { id: "opencode:db:resumed", read: async () => ({ urls: [], branches: [], started_at: "2026-10-28T10:00:00Z" }) };
    let branch = "feature-a";
    const ask = (paneId: string, when: string) => panePullRequests({ paneId, cwd: "/w", chat, fresh: true }, { board: noBoard, run, now: () => at(when), currentBranch: async () => branch });
    await ask("old-pane", "2026-10-28T10:10:00Z");
    branch = "feature-b";
    const before = await ask("old-pane", "2026-10-28T10:30:00Z");
    const after = await ask("new-pane", "2026-10-28T11:00:00Z");
    for (const answer of [before, after]) {
      expect(answer.pull_requests.map((pr) => pr.number)).toEqual([2]);
      expect(answer.events.filter((event) => event.kind === "branch")).toHaveLength(1);
    }
  });

  it("keeps known PRs when a repository lookup fails, and asks again soon", async () => {
    let repoDown = false;
    const calls: string[][] = [];
    const up = listing({ "feature-a": [raw(1, "acme/api", { headRefName: "feature-a", createdAt: "2026-10-28T10:05:00Z" })] });
    const run: Run = async (argv, cwd, timeout) => {
      calls.push(argv);
      return repoDown && argv[1] === "repo" ? { code: 1, stdout: "", stderr: "HTTP 503" } : up(argv, cwd, timeout);
    };
    const chat = transcript("repo-down.jsonl", [{ timestamp: "2026-10-28T10:00:00Z", gitBranch: "feature-a" }]);
    const ask = (fresh: boolean, ms: number) => panePullRequests({ paneId: "rd", cwd: "/rd", chat, fresh }, { board: noBoard, run, now: () => at("2026-10-28T10:30:00Z") + ms, currentBranch: async () => "feature-a" });
    expect((await ask(false, 0)).pull_requests.map((pr) => pr.number)).toEqual([1]);
    repoDown = true;
    const stale = await ask(false, 600_001);
    expect([stale.gh, stale.pull_requests.map((pr) => pr.number)]).toEqual(["ok", [1]]);
    repoDown = false;
    calls.length = 0;
    const back = await ask(true, 660_001);
    expect(calls.some((argv) => argv[1] === "repo")).toBe(true);
    expect([back.gh, back.pull_requests.map((pr) => pr.number)]).toEqual(["ok", [1]]);
  });

  it("asks a repository that failed with nothing known again on a fresh read, not ten minutes later", async () => {
    let repoDown = true;
    const up = listing({});
    const run: Run = async (argv, cwd, timeout) => (repoDown && argv[1] === "repo" ? { code: 1, stdout: "", stderr: "HTTP 503" } : up(argv, cwd, timeout));
    const ask = (fresh: boolean) => panePullRequests({ paneId: "rf", cwd: "/rf", chat: null, fresh }, { board: noBoard, run, now: () => at("2026-10-28T10:30:00Z"), currentBranch: async () => null });
    expect((await ask(false)).gh).toBe("error");
    repoDown = false;
    expect((await ask(true)).gh).toBe("ok");
  });

  it("keeps every PR of a branch with more than one page of them, and their events", async () => {
    const many = Array.from({ length: 61 }, (_, i) => raw(i + 1, "acme/api", { state: "MERGED", headRefName: "release", createdAt: `2026-10-28T10:${String(i % 60).padStart(2, "0")}:30Z`, mergedAt: "2026-10-28T11:30:00Z" }));
    const limits: number[] = [];
    // gh honours --limit: newest first, as many as asked
    const run: Run = async (argv) => {
      if (argv[1] === "api") return { code: 0, stdout: '{"login":"owner"}', stderr: "" };
    if (argv[0] === "git") return { code: 0, stdout: "release\n", stderr: "" };
      if (argv[1] === "repo") return { code: 0, stdout: '{"nameWithOwner":"acme/api"}', stderr: "" };
      if (argv[2] === "list") { const limit = Number(argv[argv.indexOf("--limit") + 1]); limits.push(limit); return { code: 0, stdout: JSON.stringify([...many].reverse().slice(0, limit)), stderr: "" }; }
      return { code: 1, stdout: "", stderr: "" };
    };
    const chat: Chat = { id: "release-chat", read: async () => ({ urls: [], branches: [{ branch: "release", at: "2026-10-28T10:00:00Z" }], started_at: "2026-10-28T10:00:00Z" }) };
    const answer = await panePullRequests({ paneId: "rel", cwd: "/rel", chat, fresh: true }, { board: noBoard, run, now: () => at("2026-10-28T12:00:00Z"), currentBranch: async () => "release" });
    expect(answer.pull_requests).toHaveLength(61);
    expect(answer.events.filter((event) => event.kind === "opened")).toHaveLength(61);
    expect(limits).toEqual([50, 200]);
  });
});
