/**
 * A workspace's pull request, as the herdr plugin `jmarbutt.spaces-pr-status` reports it in the
 * workspace's metadata tokens (`herdr workspace report-metadata --token`): `pr` (`● #8371`,
 * `◆ #8470 MERGED`), `pr_checks` (`✓ 12/12`), `pr_review` (`approved`), `pr_diff` (`+89 -311`).
 * The plugin writes either its compact glyphs or its emoji ones. Ovis never asks GitHub itself:
 * no plugin, or no PR, is no token and no badge. Kept apart from protocol.ts so the browser can
 * import the values.
 */

export type PrState = "open" | "draft" | "merged" | "closed";
/** as herdr's sidebar colours them: green passed or approved, amber pending, red failing or changes requested */
export type PrTone = "ok" | "pending" | "fail" | "neutral";

export interface PrStatus {
  number: number;
  state: PrState;
  /** what the checks say as a whole, from `pr_checks` or else the state glyph; neutral when nothing says */
  checksTone: PrTone;
  /** `pr_checks` as the plugin wrote it */
  checks: string | null;
  review: { text: string; tone: PrTone } | null;
  diff: string | null;
  /** `pr_threads` (`2 threads`), null when there are none open */
  threads: string | null;
}

/** where an open pull request stands in one word, or its state when it is not open */
export type PrWord = "ready" | "review" | "changes" | "running" | "failed" | "draft" | "merged" | "closed";

/** the plugin's glyph for each rolled state, compact and emoji */
const GLYPHS: Record<string, { state: PrState; checks: PrTone }> = {
  "◆": { state: "merged", checks: "neutral" }, "\u{1F7E3}": { state: "merged", checks: "neutral" },
  "⊘": { state: "closed", checks: "neutral" }, "\u{26AB}": { state: "closed", checks: "neutral" },
  "◌": { state: "draft", checks: "neutral" }, "\u{26AA}": { state: "draft", checks: "neutral" },
  "⊗": { state: "open", checks: "fail" }, "\u{1F534}": { state: "open", checks: "fail" },
  "◐": { state: "open", checks: "pending" }, "\u{1F7E1}": { state: "open", checks: "pending" },
  "●": { state: "open", checks: "neutral" }, "\u{1F7E2}": { state: "open", checks: "neutral" },
};
const LABELS: Record<string, PrState> = { MERGED: "merged", CLOSED: "closed", DRAFT: "draft" };
const PR = /^(\S+)?\s*#(\d+)(?:\s+([A-Z]+))?$/u;

const text = (tokens: Readonly<Record<string, unknown>>, name: string): string | null => {
  const value = Object.hasOwn(tokens, name) ? tokens[name] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

function checksTone(checks: string): PrTone {
  if (checks.startsWith("✓")) return "ok";
  if (checks.startsWith("✗")) return "fail";
  if (checks.startsWith("…") || checks.startsWith("⏳")) return "pending";
  return "neutral";
}

function reviewTone(review: string): PrTone {
  if (review === "approved") return "ok";
  if (review === "changes req" || review === "changes requested") return "fail";
  return "pending";
}

/** The pull request a workspace's tokens describe, or null when they name none. */
export function prStatus(tokens: Readonly<Record<string, unknown>> | null | undefined): PrStatus | null {
  if (!tokens) return null;
  const pr = text(tokens, "pr");
  const match = pr === null ? null : PR.exec(pr);
  if (!match) return null;
  const glyph = match[1] === undefined ? undefined : GLYPHS[match[1]];
  const state = (match[3] === undefined ? undefined : LABELS[match[3]]) ?? glyph?.state ?? "open";
  const checks = text(tokens, "pr_checks");
  const review = text(tokens, "pr_review");
  const threads = text(tokens, "pr_threads");
  return {
    number: Number(match[2]),
    state,
    checksTone: checks !== null ? checksTone(checks) : glyph?.checks ?? "neutral",
    checks,
    review: review === null ? null : { text: review, tone: reviewTone(review) },
    diff: text(tokens, "pr_diff"),
    threads: threads === null || /^0\b/.test(threads) ? null : threads,
  };
}

/** The badge's word for a pull request: failing checks first, then a review's answer, then running checks. */
export function prStatusWord(pr: PrStatus): PrWord {
  if (pr.state !== "open") return pr.state;
  if (pr.checksTone === "fail") return "failed";
  if (pr.review?.tone === "fail") return "changes";
  if (pr.checksTone === "pending") return "running";
  if (pr.review?.tone === "pending") return "review";
  return "ready";
}

/**
 * The web page of a git remote's repository (`git@github.com:o/r.git`, `https://github.com/o/r`,
 * `ssh://git@github.com/o/r.git`), as the plugin reads `origin`; null for a local path or anything
 * else that names no host.
 */
export function remoteWebUrl(remote: string): string | null {
  const trimmed = remote.trim();
  const match = trimmed.includes("://")
    ? /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(trimmed)
    : /^(?:[^@/]+@)?([^:/]+):([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (!match) return null;
  const [, host, owner, name] = match;
  if (!host!.includes(".") || name!.includes("/")) return null;
  return `https://${host}/${owner}/${name}`;
}
