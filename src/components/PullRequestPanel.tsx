import "./PullRequestPanel.css";

import { Check, Circle, ExternalLink, GitBranch, GitPullRequest, X } from "lucide-react";
import { useEffect, useState } from "react";
import { paneStorageId } from "../../shared/machines.ts";
import { canMerge, prLabel, type GhStatus, type PanePullRequests, type PrCheck, type PullRequest } from "../../shared/pull-requests.ts";
import { mergePullRequest } from "../lib/api.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { refreshPullRequests } from "../lib/usePanePullRequests.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { PullRequestBadge, prTone } from "./PullRequestBadge.tsx";

export interface PullRequestPanelProps {
  data: PanePullRequests;
  machineId: string;
  paneId: string;
  /** the pane's agent as people say it ("Claude"), for Ask … to fix */
  agentName: string;
}

/** What the person is asked to send when checks fail: it goes into the message box, never out on its own. */
export function fixRequest(pr: PullRequest): string {
  const failed = pr.check_runs.filter((run) => run.state === "failing").map((run) => run.name);
  return `These checks failed on ${prLabel(pr)} (${pr.title}): ${failed.join(", ") || "the required checks"}. Please fix them and push the branch.`;
}

const CHECK_ORDER: Record<PrCheck["state"], number> = { failing: 0, pending: 1, passing: 2 };

/**
 * The checks that need the person first: failing, then running, then passed, each in GitHub's order.
 * Checks from two workflows can share a name, so each gets a key of its name and how many of that
 * name came before it: a key React can tell apart while the rows change places.
 */
export function orderChecks(runs: PrCheck[]): { run: PrCheck; key: string }[] {
  const seen = new Map<string, number>();
  return runs.map((run) => {
    const nth = seen.get(run.name) ?? 0;
    seen.set(run.name, nth + 1);
    return { run, key: `${run.name}\u0000${nth}` };
  }).sort((a, b) => CHECK_ORDER[a.run.state] - CHECK_ORDER[b.run.state]);
}

/** One line over the list: "48 passed · 1 running · 1 failed", leaving out the states no check is in. */
export function checksSummary(runs: PrCheck[], t: ReturnType<typeof useT>): string {
  const count = (state: PrCheck["state"]): number => runs.filter((run) => run.state === state).length;
  return [
    count("passing") > 0 ? t("{n} passed", { n: count("passing") }) : null,
    count("pending") > 0 ? t("{n} running", { n: count("pending") }) : null,
    count("failing") > 0 ? t("{n} failed", { n: count("failing") }) : null,
  ].filter((part) => part !== null).join(" · ");
}

/** Puts a request in the pane's message box, after anything the person already wrote there, and gives the box the focus. */
export function askToFix(machineId: string, paneId: string, pr: PullRequest): void {
  const key = `ovis:composer-draft:${paneStorageId(machineId, paneId)}`;
  const request = fixRequest(pr);
  composerDrafts.set(key, (previous) => previous.trim() === "" ? request : `${previous.trimEnd()}\n\n${request}`);
  document.querySelector<HTMLTextAreaElement>(".pane-slot.is-active .composer-text, .composer-text")?.focus({ preventScroll: true });
}

function ghSentence(status: GhStatus, t: ReturnType<typeof useT>): { title: string; detail: string } {
  switch (status) {
    case "missing": return { title: t("GitHub CLI not found"), detail: t("Install gh on this PC to see this chat's pull requests.") };
    case "unauthenticated": return { title: t("GitHub CLI is signed out"), detail: t("Run gh auth login on this PC.") };
    case "no_remote": return { title: t("No GitHub remote"), detail: t("This folder's repository is not on GitHub.") };
    default: return { title: t("GitHub did not answer"), detail: t("Pull requests show again on the next try.") };
  }
}

/** The chat's pull requests (DESIGN.md: Pull requests): the ones needing the person first, then the open rest, then the ones that ended. */
export function PullRequestPanel({ data, machineId, paneId, agentName }: PullRequestPanelProps) {
  const t = useT();
  const [merging, setMerging] = useState<PullRequest | null>(null);
  if (data.gh !== "ok") {
    const sentence = ghSentence(data.gh, t);
    return <EmptyState icon={GitPullRequest} title={sentence.title} detail={sentence.detail} />;
  }
  const open = data.pull_requests.filter((pr) => pr.state === "open" || pr.state === "draft");
  const ended = data.pull_requests.filter((pr) => pr.state === "merged" || pr.state === "closed");
  if (data.pull_requests.length === 0) return <EmptyState icon={GitPullRequest} title={t("No pull requests yet")} detail={t("A pull request this chat opens shows here.")} />;
  return (
    <div className="pr-panel">
      {open.length > 0 && <section className="pr-section" aria-label={t("Open pull requests")}>
        <div className="pr-section-head"><span className="section-label">{t("Open · {n}", { n: open.length })}</span>{open.length > 1 && <span className="pr-section-hint">{t("Needs attention first")}</span>}</div>
        {open.map((pr, index) => index === 0
          ? <LeadCard key={pr.url} pr={pr} agentName={agentName} onAskFix={() => askToFix(machineId, paneId, pr)} onMerge={() => setMerging(pr)} />
          : <PrLine key={pr.url} pr={pr} />)}
      </section>}
      {ended.length > 0 && <section className="pr-section" aria-label={t("Earlier in this chat")}>
        <div className="pr-section-head"><span className="section-label">{t("Earlier in this chat")}</span></div>
        {ended.map((pr) => <PrLine key={pr.url} pr={pr} ended />)}
      </section>}
      {merging !== null && <ConfirmDialog
        title={t("Merge {label}?", { label: prLabel(merging) })}
        body={t("Squash and merge {title} into {base}.", { title: merging.title, base: merging.base })}
        confirmLabel={t("Squash and merge")}
        onConfirm={async () => {
          await mergePullRequest(paneId, merging.url, machineId);
          await refreshPullRequests(machineId, paneId);
          // the owner takes a confirmation down once its deed is done (ConfirmDialog.tsx)
          setMerging(null);
        }}
        onClose={() => setMerging(null)}
      />}
    </div>
  );
}

function LeadCard({ pr, agentName, onAskFix, onMerge }: { pr: PullRequest; agentName: string; onAskFix(): void; onMerge(): void }) {
  const t = useT();
  const tone = prTone(pr);
  const mergeable = canMerge(pr);
  return (
    <article className={`pr-card is-lead is-${tone}`}>
      <div className="pr-card-head"><PullRequestBadge pr={pr} size="full" /><GitHubLink pr={pr} /></div>
      <p className="pr-card-title">{pr.title}</p>
      <p className="pr-card-meta"><GitBranch aria-hidden="true" /><span className="pr-card-branch">{pr.head} → {pr.base}</span><span className="pr-plus">+{pr.additions}</span><span className="pr-minus">−{pr.deletions}</span></p>
      {pr.check_runs.length > 0 && <p className="pr-checks-summary">{checksSummary(pr.check_runs, t)}</p>}
      {/* its own scroller, so 50 checks never push the card's actions away; tabIndex lets the keyboard scroll it */}
      {pr.check_runs.length > 0 && <ul className="pr-checks" aria-label={t("Checks")} tabIndex={0}>
        {orderChecks(pr.check_runs).map(({ run, key }) => <li key={key} className={`pr-check is-${run.state}`}>
          {run.state === "passing" ? <Check aria-hidden="true" /> : run.state === "failing" ? <X aria-hidden="true" /> : <Circle aria-hidden="true" />}
          <span className="pr-check-name" title={run.name}>{run.name}</span>
          <span className="visually-hidden">{run.state === "passing" ? t("passed") : run.state === "failing" ? t("failed") : t("running")}</span>
        </li>)}
      </ul>}
      {pr.review === "approved" && <p className="pr-review is-approved"><Check aria-hidden="true" />{t("Approved")}</p>}
      {tone === "failing" && <button type="button" className="btn pr-card-action" onClick={onAskFix}>{t("Ask {agent} to fix", { agent: agentName })}</button>}
      {mergeable && <button type="button" className="btn btn-primary pr-card-action" onClick={onMerge}>{t("Squash and merge")}</button>}
    </article>
  );
}

function PrLine({ pr, ended = false }: { pr: PullRequest; ended?: boolean }) {
  return (
    <article className={`pr-card is-line${ended ? " is-ended" : ""}`}>
      <div className="pr-card-head"><PullRequestBadge pr={pr} size="full" /><GitHubLink pr={pr} /></div>
      <p className="pr-card-title">{pr.title}</p>
    </article>
  );
}

function GitHubLink({ pr }: { pr: PullRequest }) {
  const t = useT();
  return <a className="icon-button pr-card-link" href={pr.url} target="_blank" rel="noreferrer" aria-label={t("Open {label} on GitHub", { label: prLabel(pr) })} title={t("Open {label} on GitHub", { label: prLabel(pr) })}><ExternalLink aria-hidden="true" /></a>;
}

/** The header's way in: the leading PR and its state; it shows and hides the inspector, or opens the sheet on a narrow window. */
export function PrHeaderButton({ data, expanded, controls, onToggle }: { data: PanePullRequests | null; expanded: boolean; controls: string; onToggle(): void }) {
  const t = useT();
  const lead = data?.pull_requests[0];
  // links the chat wrote that gh cannot read: a quiet way in to the sentence that says why
  if (!lead && data && data.gh !== "ok" && data.linked > 0) {
    const sentence = ghSentence(data.gh, t).title;
    return (
      <button type="button" className="pr-header-button is-unread" aria-expanded={expanded} aria-controls={controls} aria-label={t("Pull requests: {reason}", { reason: sentence })} title={sentence} onClick={onToggle}>
        <GitPullRequest className="pr-header-unread" aria-hidden="true" />
      </button>
    );
  }
  if (!lead || !data) return null;
  const more = data.pull_requests.filter((pr) => pr !== lead && (pr.state === "open" || pr.state === "draft")).length;
  return (
    <button type="button" className="pr-header-button" aria-expanded={expanded} aria-controls={controls} title={expanded ? t("Hide pull requests") : t("Show pull requests")} onClick={onToggle}>
      <PullRequestBadge pr={lead} more={more} size="full" />
    </button>
  );
}

/** The panel as a sheet, where the window is too narrow for the inspector beside the pane. */
export function PrSheet(props: PullRequestPanelProps & { onClose(): void }) {
  const t = useT();
  const surface = useFocusTrap<HTMLElement>(true);
  useSheetSwipe(surface, props.onClose);
  usePhoneSheetBack(props.onClose);
  const { onClose } = props;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape" && !nativeModalOver(surface.current)) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, surface]);
  return (
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      {/* the header button's aria-controls: only one of this sheet and the inspector column is ever drawn */}
      <section ref={surface} id="pull-requests" className="modal pr-sheet" role="dialog" aria-modal="true" aria-label={t("Pull requests")} tabIndex={-1}>
        <header className="modal-header"><h2 className="modal-title">{t("Pull requests")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={props.onClose}><X aria-hidden="true" /></button></header>
        <div className="modal-body"><PullRequestPanel {...props} /></div>
      </section>
    </div>
  );
}
