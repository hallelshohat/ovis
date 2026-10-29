import "./PullRequestBadge.css";

import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import { openCount, prLabel, type PullRequest } from "../../shared/pull-requests.ts";
import { useT } from "../lib/i18n.ts";
import { usePanePullRequests } from "../lib/usePanePullRequests.ts";

export type PrTone = "open" | "failing" | "pending" | "review" | "changes" | "draft" | "merged" | "closed";

/** The one word for where a pull request stands, and the colour class that goes with it. */
export function prTone(pr: PullRequest): PrTone {
  if (pr.state === "merged" || pr.state === "closed" || pr.state === "draft") return pr.state;
  if (pr.checks === "failing") return "failing";
  if (pr.review === "changes_requested") return "changes";
  if (pr.review === "review_required") return "review";
  if (pr.checks === "pending") return "pending";
  return "open";
}

export function usePrWord(): (pr: PullRequest) => string {
  const t = useT();
  return (pr) => {
    switch (prTone(pr)) {
      case "failing": return t("Checks failing");
      case "pending": return t("Checks running");
      case "review": return t("Review requested");
      case "changes": return t("Changes requested");
      case "draft": return t("Draft");
      case "merged": return t("Merged");
      case "closed": return t("Closed");
      default: return t("Ready to merge");
    }
  };
}

export interface PullRequestBadgeProps {
  pr: PullRequest;
  /** the chat's other open PRs, drawn as +N */
  more?: number;
  /** "row": the glyph and number (a sidebar row, the composer strip); "full": with its state word too */
  size?: "row" | "full";
}

/** A pull request's number in its state's colour (DESIGN.md: Pull requests), with +N for the chat's others. */
export function PullRequestBadge({ pr, more = 0, size = "row" }: PullRequestBadgeProps) {
  const t = useT();
  const word = usePrWord()(pr);
  const tone = prTone(pr);
  const Icon = pr.state === "merged" ? GitMerge : pr.state === "closed" ? GitPullRequestClosed : pr.state === "draft" ? GitPullRequestDraft : GitPullRequest;
  const label = prLabel(pr);
  return (
    <span className={`pull-badge is-${tone}`} title={`${label} · ${word} · ${pr.title}`}>
      <Icon className="pull-badge-icon" aria-hidden="true" />
      <span className="pull-badge-number">{label}</span>
      {size === "full" ? <span className="pull-badge-word">{word}</span> : <span className="visually-hidden">{word}</span>}
      {more > 0 && <span className="pull-badge-more" aria-label={t("{n} more open", { n: more })}>+{more}</span>}
    </span>
  );
}

/** A pane's leading pull request, with +N for its other open ones; nothing when its chat has none. */
export function PaneLeadBadge({ machineId, paneId, size = "row" }: { machineId: string; paneId: string; size?: "row" | "full" }) {
  const data = usePanePullRequests(machineId, paneId);
  const lead = data?.pull_requests[0];
  if (!lead) return null;
  const more = openCount(data.pull_requests) - (lead.state === "open" || lead.state === "draft" ? 1 : 0);
  return <PullRequestBadge pr={lead} more={more} size={size} />;
}
