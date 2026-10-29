import { GitBranch } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import type { PrEventRowData } from "../lib/prEventRows.ts";
import { PullRequestBadge, prTone } from "./PullRequestBadge.tsx";
import { TurnTime } from "./TurnTime.tsx";

/** One line of the chat's pull request story, where it happened: opened, merged, closed, or the branch it moved to. */
export function PrEventRow({ row }: { row: PrEventRowData }) {
  const t = useT();
  const { event, pr } = row;
  if (event.kind === "branch") {
    return (
      <div className="pr-event is-branch" role="note">
        <GitBranch className="pr-event-icon" aria-hidden="true" />
        <span className="pr-event-text">{t("Branch {from} → {to}", { from: event.from, to: event.to })}</span>
        <TurnTime ts={event.at} />
      </div>
    );
  }
  if (pr === null) return null;
  const verb = event.kind === "opened" ? t("Opened") : event.kind === "merged" ? t("Merged") : t("Closed");
  const tone = event.kind === "opened" ? prTone(pr) : event.kind;
  return (
    <div className={`pr-event is-${tone}`} role="note">
      <PullRequestBadge pr={pr} />
      <span className="pr-event-text"><b className="pr-event-verb">{verb}</b> {pr.title}</span>
      <TurnTime ts={event.at} />
    </div>
  );
}
