/**
 * A pane's pull requests: the PR links its chat wrote, plus every PR of each branch the chat ran
 * on (from the transcript, and the branches seen here while the chat was open), looked up with
 * `gh` in the pane's working directory. Merged and closed PRs never change, so they are read once;
 * open ones and the branch lists are kept OPEN_TTL_MS unless the caller asks for a fresh read.
 */
import { byAttention, type GhStatus, type PanePullRequests, type PrEvent, type PullRequest } from "../../shared/pull-requests.ts";
import { ghListHead, ghRepo, ghView, GH_TIMEOUT_MS, type Run } from "./gh.ts";
import { chatSources, type ChatSources } from "./sources.ts";

export const OPEN_TTL_MS = 60_000;
const REPO_TTL_MS = 10 * 60_000;
const OBSERVED_PER_PANE = 50;

export interface PrDeps { run: Run; now: () => number; currentBranch: (cwd: string) => Promise<string | null> }
export interface PrInput { paneId: string; cwd: string; transcript: { path: string; source: string } | null; fresh: boolean }

const prs = new Map<string, { pr: PullRequest; at: number }>();
const lists = new Map<string, { urls: string[]; at: number }>();
const repos = new Map<string, { status: GhStatus; repo: string | null; at: number }>();
const observed = new Map<string, { branch: string; at: string }[]>();
const inflight = new Map<string, Promise<PanePullRequests>>();

export function resetPullRequestCache(): void {
  for (const map of [prs, lists, repos, observed, inflight]) map.clear();
}

/** The PR at `url` if it is one of the pane's last answer, for the merge route. */
export function cachedPullRequest(url: string): PullRequest | null {
  return prs.get(url)?.pr ?? null;
}

export function gitBranchOf(run: Run): (cwd: string) => Promise<string | null> {
  return async (cwd) => {
    const result = await run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], cwd, GH_TIMEOUT_MS);
    const branch = result?.code === 0 ? result.stdout.trim() : "";
    return branch && branch !== "HEAD" ? branch : null;
  };
}

export function panePullRequests(input: PrInput, deps: PrDeps): Promise<PanePullRequests> {
  const key = `${input.paneId}\0${input.fresh ? 1 : 0}`;
  const running = inflight.get(key);
  if (running) return running;
  const lookup = read(input, deps).finally(() => inflight.delete(key));
  inflight.set(key, lookup);
  return lookup;
}

async function read(input: PrInput, deps: PrDeps): Promise<PanePullRequests> {
  const now = deps.now();
  const sources: ChatSources = input.transcript ? await chatSources(input.transcript.path, input.transcript.source).catch(() => ({ urls: [], branches: [], started_at: null })) : { urls: [], branches: [], started_at: null };
  const timeline = branchTimeline(input.paneId, sources, await deps.currentBranch(input.cwd).catch(() => null), now);
  const branchEvents = switches(timeline);

  let repo = repos.get(input.cwd);
  if (!repo || now - repo.at > REPO_TTL_MS) {
    repo = { ...await ghRepo(deps.run, input.cwd), at: now };
    repos.set(input.cwd, repo);
  }
  if (repo.status === "missing" || repo.status === "unauthenticated" || repo.status === "error") {
    return { gh: repo.status, pull_requests: [], events: inWindow(branchEvents, sources.started_at) };
  }

  const fresh = (url: string): PullRequest | null => {
    const hit = prs.get(url);
    if (!hit) return null;
    if (hit.pr.state === "merged" || hit.pr.state === "closed") return hit.pr;
    return input.fresh || now - hit.at > OPEN_TTL_MS ? null : hit.pr;
  };
  const found = new Map<string, { pr: PullRequest; linked: boolean }>();

  // branch lists only make sense in the pane's own repository
  if (repo.repo !== null) {
    for (const branch of new Set(timeline.map((entry) => entry.branch))) {
      const listKey = `${input.cwd}\0${branch}`;
      const listed = lists.get(listKey);
      let urls = listed && !input.fresh && now - listed.at <= OPEN_TTL_MS ? listed.urls : null;
      if (urls === null) {
        const pulled = await ghListHead(deps.run, input.cwd, branch, repo.repo);
        for (const pr of pulled) prs.set(pr.url, { pr, at: now });
        urls = pulled.map((pr) => pr.url);
        lists.set(listKey, { urls, at: now });
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
    }
    if (pr) found.set(url, { pr, linked: true });
  }

  // a branch reused for months lists PRs that ended before this chat began: only links keep those
  const started = sources.started_at;
  const pull_requests = [...found.values()]
    .filter(({ pr, linked }) => linked || started === null || (pr.merged_at ?? pr.closed_at ?? started) >= started)
    .map(({ pr }) => pr)
    .sort(byAttention);
  const events: PrEvent[] = [...branchEvents];
  for (const pr of pull_requests) {
    if (pr.created_at) events.push({ at: pr.created_at, kind: "opened", url: pr.url });
    if (pr.merged_at) events.push({ at: pr.merged_at, kind: "merged", url: pr.url });
    else if (pr.state === "closed" && pr.closed_at) events.push({ at: pr.closed_at, kind: "closed", url: pr.url });
  }
  return { gh: "ok", pull_requests, events: inWindow(events, started).sort((a, b) => a.at.localeCompare(b.at)) };
}

/** The branches this chat ran on, in time order: its transcript's, then the ones seen here. */
function branchTimeline(paneId: string, sources: ChatSources, current: string | null, now: number): { branch: string; at: string | null }[] {
  const seen = observed.get(paneId) ?? [];
  if (current !== null && seen.at(-1)?.branch !== current) {
    seen.push({ branch: current, at: new Date(now).toISOString() });
    if (seen.length > OBSERVED_PER_PANE) seen.shift();
    observed.set(paneId, seen);
  }
  const merged = [...sources.branches, ...seen.filter((entry) => !sources.branches.some((own) => own.branch === entry.branch))];
  merged.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  return merged.filter((entry, index) => merged[index - 1]?.branch !== entry.branch);
}

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
