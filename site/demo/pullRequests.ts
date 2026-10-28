/**
 * The demo's pull requests, by fixture key (fixtures/panes.json). checkout-api's chat is the
 * design's own story: #1925 opened and merged, a branch switch in the same worktree, then #1931
 * here and client-sdk#88 in another repository, whose failing check makes it lead.
 */
import { byAttention, type PanePullRequests, type PullRequest } from "../../shared/pull-requests.ts";
import { t } from "./fixtures.ts";

const pr = (number: number, title: string, over: Partial<PullRequest>): PullRequest => ({
  url: `https://github.com/acme/checkout-api/pull/${number}`, number, repo: "acme/checkout-api", own: true, title,
  state: "open", checks: "passing", review: "none", check_runs: [], head: "feat/branch", base: "main",
  additions: 12, deletions: 3, created_at: t(1), merged_at: null, closed_at: null, updated_at: t(1), ...over,
});
const passing = (...names: string[]) => names.map((name) => ({ name, state: "passing" as const, url: null }));

const merged1925 = pr(1925, "Make payment retries idempotent", { state: "merged", head: "feat/idempotent", additions: 214, deletions: 38, created_at: t(4, 30), merged_at: t(5, 10), updated_at: t(5, 10), check_runs: passing("Fast checks", "Integration and browser"), review: "approved" });
let open1931 = pr(1931, "Count replayed payment requests", { head: "feat/replay-metric", additions: 4, deletions: 1, created_at: t(6, 20), updated_at: t(6, 20), review: "approved", check_runs: passing("Fast checks", "Integration and browser", "Native Windows install") });
const failing88: PullRequest = {
  ...pr(88, "Send Idempotency-Key from the SDK", { head: "feat/idem-key", additions: 31, deletions: 12, created_at: t(6, 40), updated_at: t(6, 45), checks: "failing", review: "review_required" }),
  url: "https://github.com/acme/client-sdk/pull/88", repo: "acme/client-sdk", own: false,
  check_runs: [{ name: "Fast checks", state: "passing", url: null }, { name: "Integration and browser", state: "failing", url: null }],
};

export function demoPullRequests(key: string | undefined, shiftMs = 0): PanePullRequests {
  const moved = (at: string): string => new Date(Date.parse(at) + shiftMs).toISOString();
  const answer = fixtureAnswer(key);
  return {
    ...answer,
    pull_requests: answer.pull_requests.map((pr) => ({ ...pr, created_at: moved(pr.created_at), updated_at: moved(pr.updated_at), merged_at: pr.merged_at && moved(pr.merged_at), closed_at: pr.closed_at && moved(pr.closed_at) })),
    events: answer.events.map((event) => ({ ...event, at: moved(event.at) })),
  };
}

function fixtureAnswer(key: string | undefined): PanePullRequests {
  if (key === "api") {
    const prs = [merged1925, open1931, failing88].sort(byAttention);
    return {
      gh: "ok", pull_requests: prs,
      events: [
        { at: t(4, 30), kind: "opened", url: merged1925.url },
        { at: t(5, 10), kind: "merged", url: merged1925.url },
        { at: t(5, 50), kind: "branch", from: "feat/idempotent", to: "feat/replay-metric" },
        { at: t(6, 20), kind: "opened", url: open1931.url },
        ...(open1931.merged_at ? [{ at: open1931.merged_at, kind: "merged" as const, url: open1931.url }] : []),
        { at: t(6, 40), kind: "opened", url: failing88.url },
      ],
    };
  }
  const one: Record<string, PullRequest> = {
    web: pr(1934, "Guard the export button", { state: "draft", head: "feat/export-guard", checks: "pending", check_runs: [{ name: "Fast checks", state: "pending", url: null }] }),
    flaky: pr(1936, "Fix the flaky retry test", { head: "fix/flaky-retry", checks: "failing", check_runs: [{ name: "Integration and browser", state: "failing", url: null }] }),
    cli: pr(1929, "Ship the retry flag", { state: "merged", head: "feat/retry-flag", merged_at: t(3), updated_at: t(3) }),
    hermes: pr(1940, "Changelog for 2.0", { head: "docs/changelog", review: "review_required", check_runs: passing("Fast checks") }),
  };
  const only = key ? one[key] : undefined;
  return { gh: "ok", pull_requests: only ? [only] : [], events: only ? [{ at: only.created_at, kind: "opened", url: only.url }] : [] };
}

/** The demo's merge: a listed open PR with no failing check turns merged. */
export function demoMerge(url: string): { ok: true } | { error: { code: string; message: string } } {
  if (url === open1931.url && open1931.state === "open") {
    // in the fixtures' own clock, which demoPullRequests moves to now with the rest
    open1931 = { ...open1931, state: "merged", merged_at: t(6, 50), updated_at: t(6, 50) };
    return { ok: true };
  }
  return { error: { code: "pr_not_mergeable", message: "Its checks are failing now" } };
}
