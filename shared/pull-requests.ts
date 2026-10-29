/**
 * A chat's pull requests, as `GET /api/pane/pull-requests` answers them (server/pull-requests/).
 * A chat holds a list, never one: the PR links its transcript wrote and the PRs of every branch it
 * ran on. The first in attention order leads; the others are counted beside it.
 */
export type PrState = "open" | "draft" | "merged" | "closed";
export type PrChecks = "passing" | "failing" | "pending" | "none";
export type PrReview = "approved" | "changes_requested" | "review_required" | "none";
export interface PrCheck { name: string; state: "passing" | "failing" | "pending"; url: string | null }
export interface PullRequest {
  url: string;
  number: number;
  /** owner/name */
  repo: string;
  /** the same repository as the pane's working directory */
  own: boolean;
  title: string;
  state: PrState;
  checks: PrChecks;
  review: PrReview;
  check_runs: PrCheck[];
  head: string;
  base: string;
  additions: number;
  deletions: number;
  created_at: string;
  merged_at: string | null;
  closed_at: string | null;
  updated_at: string;
}
export type PrEvent =
  | { at: string; kind: "opened" | "merged" | "closed"; url: string }
  | { at: string; kind: "branch"; from: string; to: string };
export type GhStatus = "ok" | "missing" | "unauthenticated" | "no_remote" | "error";
export interface PanePullRequests {
  gh: GhStatus;
  /** attention order: the first one leads */
  pull_requests: PullRequest[];
  /** time order */
  events: PrEvent[];
  /** the PR links the chat wrote, counted even when gh cannot read them: why a chat with none says nothing */
  linked: number;
}

/** 0 needs the person most: failing checks, then requested changes, a requested review, running checks, green, draft, merged, closed. */
export function attentionRank(pr: PullRequest): number {
  if (pr.state === "merged") return 6;
  if (pr.state === "closed") return 7;
  if (pr.state === "draft") return 5;
  if (pr.checks === "failing") return 0;
  if (pr.review === "changes_requested") return 1;
  if (pr.review === "review_required") return 2;
  if (pr.checks === "pending") return 3;
  return 4;
}

export function byAttention(a: PullRequest, b: PullRequest): number {
  const rank = attentionRank(a) - attentionRank(b);
  if (rank !== 0) return rank;
  const when = (pr: PullRequest) => pr.merged_at ?? pr.closed_at ?? pr.updated_at;
  return when(b).localeCompare(when(a));
}

/** `#1931` in the pane's own repository, `client-sdk#88` in another. */
export function prLabel(pr: Pick<PullRequest, "own" | "repo" | "number">): string {
  return pr.own ? `#${pr.number}` : `${pr.repo.split("/").pop()}#${pr.number}`;
}

export function openCount(prs: readonly PullRequest[]): number {
  return prs.filter((pr) => pr.state === "open" || pr.state === "draft").length;
}

/**
 * Whether Ovis offers to merge it, and whether the server still will: open, its checks green or
 * none, and no changes requested. One rule for the button and the route, so neither merges what the
 * other would not.
 */
export function canMerge(pr: Pick<PullRequest, "state" | "checks" | "review">): boolean {
  return pr.state === "open" && (pr.checks === "passing" || pr.checks === "none") && pr.review !== "changes_requested";
}
