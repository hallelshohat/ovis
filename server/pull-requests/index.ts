/**
 * A pane's pull requests: the PR links its chat wrote, plus every PR of each branch the chat ran
 * on (from the transcript, and the branches seen here while the chat was open), looked up with
 * `gh` in the pane's working directory. Merged and closed PRs never change, so they are read once;
 * open ones and the branch lists are kept OPEN_TTL_MS unless the caller asks for a fresh read.
 */
import { byAttention, type GhStatus, type PanePullRequests, type PrEvent, type PullRequest } from "../../shared/pull-requests.ts";
import { bunRun, ghListHead, ghRepo, ghView, GH_TIMEOUT_MS, type Run } from "./gh.ts";
import { resetSourceCache, type Chat, type ChatSources } from "./sources.ts";

export const OPEN_TTL_MS = 60_000;
const REPO_TTL_MS = 10 * 60_000;
const OBSERVED_PER_PANE = 50;

export interface PrDeps { run: Run; now: () => number; currentBranch: (cwd: string) => Promise<string | null> }
/** `chat`: the conversation the pane shows now (sources.ts); null for a pane with none, a shell. */
export interface PrInput { paneId: string; cwd: string; chat: Chat | null; fresh: boolean }

const prs = new Map<string, { pr: PullRequest; at: number }>();
const lists = new Map<string, { urls: string[]; at: number }>();
const repos = new Map<string, { status: GhStatus; repo: string | null; at: number }>();
/** the branches seen in a chat while it was open, by pane and chat: a new chat in the pane starts with none */
const observed = new Map<string, { branch: string; at: string }[]>();
const inflight = new Map<string, Promise<PanePullRequests>>();

let runner: Run = bunRun;

/** Tests answer gh and git with fixtures; returns the restore. */
export function setPullRequestRunner(run: Run): () => void {
  const previous = runner;
  runner = run;
  return () => { runner = previous; };
}

export function pullRequestDeps(): PrDeps {
  return { run: runner, now: Date.now, currentBranch: gitBranchOf(runner) };
}

/** A merged PR is read again on the next answer, not taken from the open one kept here. */
export function forgetPullRequest(url: string): void {
  prs.delete(url);
}

export function resetPullRequestCache(): void {
  for (const map of [prs, lists, repos, observed, inflight]) map.clear();
  resetSourceCache();
}

export function gitBranchOf(run: Run): (cwd: string) => Promise<string | null> {
  return async (cwd) => {
    const result = await run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], cwd, GH_TIMEOUT_MS);
    const branch = result?.code === 0 ? result.stdout.trim() : "";
    return branch && branch !== "HEAD" ? branch : null;
  };
}

export function panePullRequests(input: PrInput, deps: PrDeps): Promise<PanePullRequests> {
  const key = `${input.paneId}\0${input.chat?.id ?? ""}\0${input.fresh ? 1 : 0}`;
  const running = inflight.get(key);
  if (running) return running;
  const lookup = read(input, deps).finally(() => inflight.delete(key));
  inflight.set(key, lookup);
  return lookup;
}

async function read(input: PrInput, deps: PrDeps): Promise<PanePullRequests> {
  const now = deps.now();
  const sources: ChatSources = input.chat ? await input.chat.read().catch(() => ({ urls: [], branches: [], started_at: null })) : { urls: [], branches: [], started_at: null };
  const timeline = branchTimeline(`${input.paneId}\0${input.chat?.id ?? ""}`, sources, await deps.currentBranch(input.cwd).catch(() => null), now);
  const linked = sources.urls.length;
  const branchEvents = switches(timeline);

  let repo = repos.get(input.cwd);
  if (!repo || now - repo.at > REPO_TTL_MS) {
    repo = { ...await ghRepo(deps.run, input.cwd), at: now };
    repos.set(input.cwd, repo);
  }
  if (repo.status === "missing" || repo.status === "unauthenticated" || repo.status === "error") {
    return { gh: repo.status, pull_requests: [], events: inWindow(branchEvents, sources.started_at), linked };
  }

  const fresh = (url: string): PullRequest | null => {
    const hit = prs.get(url);
    if (!hit) return null;
    if (hit.pr.state === "merged" || hit.pr.state === "closed") return hit.pr;
    return input.fresh || now - hit.at > OPEN_TTL_MS ? null : hit.pr;
  };
  const found = new Map<string, { pr: PullRequest; linked: boolean }>();
  // a lookup gh could not answer keeps what was known (stale, but true); with nothing known the answer says so
  let failed = false;

  // branch lists only make sense in the pane's own repository
  if (repo.repo !== null) {
    for (const branch of new Set(timeline.map((entry) => entry.branch))) {
      const listKey = `${input.cwd}\0${branch}`;
      const listed = lists.get(listKey);
      let urls = listed && !input.fresh && now - listed.at <= OPEN_TTL_MS ? listed.urls : null;
      if (urls === null) {
        const pulled = await ghListHead(deps.run, input.cwd, branch, repo.repo);
        if (pulled === null) {
          failed = true;
          urls = listed?.urls ?? [];
        } else {
          // a merged or closed PR keeps what it was first read as: it is never read again
          for (const pr of pulled) if (!ended(prs.get(pr.url)?.pr)) prs.set(pr.url, { pr, at: now });
          urls = pulled.map((pr) => pr.url);
          lists.set(listKey, { urls, at: now });
        }
      }
      for (const url of urls) {
        const pr = fresh(url) ?? prs.get(url)?.pr;
        if (pr) found.set(url, { pr, linked: false });
      }
    }
  }
  for (const { url } of sources.urls) {
    let pr = fresh(url);
    if (pr === null) {
      pr = await ghView(deps.run, input.cwd, url, repo.repo);
      if (pr) prs.set(url, { pr, at: now });
      else {
        failed = true;
        pr = prs.get(url)?.pr ?? null;
      }
    }
    if (pr) found.set(url, { pr, linked: true });
  }

  // a branch reused for months lists PRs that ended before this chat began: only links keep those
  const started = sources.started_at;
  const pull_requests = [...found.values()]
    .filter(({ pr, linked }) => linked || started === null || (pr.merged_at ?? pr.closed_at ?? started) >= started)
    // the cache is every chat's: whether a PR is in this pane's own repository is said per answer
    .map(({ pr }) => ({ ...pr, own: repo.repo !== null && pr.repo.toLowerCase() === repo.repo.toLowerCase() }))
    .sort(byAttention);
  const events: PrEvent[] = [...branchEvents];
  for (const pr of pull_requests) {
    if (pr.created_at) events.push({ at: pr.created_at, kind: "opened", url: pr.url });
    if (pr.merged_at) events.push({ at: pr.merged_at, kind: "merged", url: pr.url });
    else if (pr.state === "closed" && pr.closed_at) events.push({ at: pr.closed_at, kind: "closed", url: pr.url });
  }
  return { gh: failed && pull_requests.length === 0 ? "error" : "ok", pull_requests, events: inWindow(events, started).sort((a, b) => a.at.localeCompare(b.at)), linked };
}

/** The branches this chat ran on, in time order: its transcript's and every one seen here, a return to a branch included. */
function branchTimeline(chatKey: string, sources: ChatSources, current: string | null, now: number): { branch: string; at: string | null }[] {
  const seen = observed.get(chatKey) ?? [];
  if (current !== null && seen.at(-1)?.branch !== current) {
    seen.push({ branch: current, at: new Date(now).toISOString() });
    if (seen.length > OBSERVED_PER_PANE) seen.shift();
    observed.set(chatKey, seen);
  }
  const merged = [...sources.branches, ...seen];
  merged.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  return merged.filter((entry, index) => merged[index - 1]?.branch !== entry.branch);
}

const ended = (pr: PullRequest | undefined): boolean => pr?.state === "merged" || pr?.state === "closed";

function switches(timeline: { branch: string; at: string | null }[]): PrEvent[] {
  const events: PrEvent[] = [];
  for (let index = 1; index < timeline.length; index++) {
    const from = timeline[index - 1]!, to = timeline[index]!;
    if (to.at !== null) events.push({ at: to.at, kind: "branch", from: from.branch, to: to.branch });
  }
  return events;
}

function inWindow(events: PrEvent[], started: string | null): PrEvent[] {
  return started === null ? events : events.filter((event) => event.at >= started);
}
