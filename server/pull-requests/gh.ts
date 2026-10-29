/**
 * The GitHub CLI, run in the pane's working directory with prompts off. Every call goes through a
 * `Run`, so tests answer with fixtures and never reach GitHub. `null` from a run means the program
 * is not installed.
 */
import type { GhStatus, PrCheck, PrChecks, PrReview, PrState, PullRequest } from "../../shared/pull-requests.ts";

export type Run = (argv: string[], cwd: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string } | null>;

export const GH_FIELDS = "number,url,title,state,isDraft,reviewDecision,reviewRequests,headRefName,baseRefName,additions,deletions,createdAt,mergedAt,closedAt,updatedAt,statusCheckRollup";
export const GH_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

export const bunRun: Run = async (argv, cwd, timeoutMs) => {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" } });
  } catch {
    return null;
  }
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, 4096) };
  } finally {
    clearTimeout(timer);
  }
};

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const stamp = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

function checkRun(raw: unknown): PrCheck {
  const fields = record(raw);
  if (fields["__typename"] === "StatusContext") {
    const state = text(fields["state"]);
    return { name: text(fields["context"]), url: stamp(fields["targetUrl"]), state: state === "SUCCESS" ? "passing" : state === "PENDING" || state === "EXPECTED" ? "pending" : "failing" };
  }
  const conclusion = text(fields["conclusion"]);
  const state = text(fields["status"]) !== "COMPLETED" ? "pending"
    : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion) ? "passing" : "failing";
  return { name: text(fields["name"]), url: stamp(fields["detailsUrl"]), state };
}

/**
 * One run per check, its newest: a check run again (a cancelled run, then a passing one) counts by
 * the run GitHub itself goes by. A check is its workflow and name; a status, its context.
 */
export function newestRuns(raw: readonly unknown[]): unknown[] {
  const newest = new Map<string, { run: unknown; at: string }>();
  raw.forEach((run, index) => {
    const fields = record(run);
    const key = fields["__typename"] === "StatusContext" ? `status\0${text(fields["context"])}` : `run\0${text(fields["workflowName"])}\0${text(fields["name"])}`;
    const at = text(fields["startedAt"]) || text(fields["completedAt"]) || text(fields["createdAt"]) || String(index).padStart(8, "0");
    const known = newest.get(key);
    if (!known || at >= known.at) newest.set(key, { run, at });
  });
  return [...newest.values()].map((entry) => entry.run);
}

function rollup(runs: PrCheck[]): PrChecks {
  if (runs.length === 0) return "none";
  if (runs.some((run) => run.state === "failing")) return "failing";
  return runs.some((run) => run.state === "pending") ? "pending" : "passing";
}

export function repoOfUrl(url: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url);
  return match ? `${match[1]}/${match[2]}` : "";
}

export function toPullRequest(raw: unknown, ownRepo: string | null): PullRequest {
  const fields = record(raw);
  const url = text(fields["url"]);
  const repo = repoOfUrl(url);
  const rawState = text(fields["state"]);
  const state: PrState = rawState === "MERGED" ? "merged" : rawState === "CLOSED" ? "closed" : fields["isDraft"] === true ? "draft" : "open";
  const decision = text(fields["reviewDecision"]);
  // a reviewer asked for and not yet answered is a review requested, whatever the decision field says
  // (GitHub leaves it empty where no review is required by branch protection)
  const pending = Array.isArray(fields["reviewRequests"]) && fields["reviewRequests"].length > 0;
  const review: PrReview = decision === "APPROVED" ? "approved" : decision === "CHANGES_REQUESTED" ? "changes_requested"
    : decision === "REVIEW_REQUIRED" || pending ? "review_required" : "none";
  const check_runs = Array.isArray(fields["statusCheckRollup"]) ? newestRuns(fields["statusCheckRollup"]).map(checkRun) : [];
  return {
    url, number: count(fields["number"]), repo, own: ownRepo !== null && repo.toLowerCase() === ownRepo.toLowerCase(),
    title: text(fields["title"]), state, checks: rollup(check_runs), review, check_runs,
    head: text(fields["headRefName"]), base: text(fields["baseRefName"]),
    additions: count(fields["additions"]), deletions: count(fields["deletions"]),
    created_at: text(fields["createdAt"]), merged_at: stamp(fields["mergedAt"]), closed_at: stamp(fields["closedAt"]), updated_at: text(fields["updatedAt"]),
  };
}

function failure(result: { code: number; stderr: string } | null): GhStatus {
  if (result === null) return "missing";
  if (result.code === 4 || /gh auth login|not logged in|authentication/i.test(result.stderr)) return "unauthenticated";
  if (/no git remote|not a git repository|none of the git remotes/i.test(result.stderr)) return "no_remote";
  return "error";
}

export async function ghRepo(run: Run, cwd: string): Promise<{ status: GhStatus; repo: string | null }> {
  const result = await run(["gh", "repo", "view", "--json", "nameWithOwner"], cwd, GH_TIMEOUT_MS);
  if (result === null || result.code !== 0) return { status: failure(result), repo: null };
  const repo = text(record(safeJson(result.stdout))["nameWithOwner"]);
  return repo ? { status: "ok", repo } : { status: "error", repo: null };
}

export async function ghView(run: Run, cwd: string, url: string, ownRepo: string | null): Promise<PullRequest | null> {
  const result = await run(["gh", "pr", "view", url, "--json", GH_FIELDS], cwd, GH_TIMEOUT_MS);
  if (result === null || result.code !== 0) return null;
  const raw = safeJson(result.stdout);
  return raw === null ? null : toPullRequest(raw, ownRepo);
}

/** The branch's PRs; null when gh could not say (an empty list means it has none). */
export async function ghListHead(run: Run, cwd: string, branch: string, ownRepo: string | null): Promise<PullRequest[] | null> {
  const result = await run(["gh", "pr", "list", "--head", branch, "--state", "all", "--limit", "20", "--json", GH_FIELDS], cwd, GH_TIMEOUT_MS);
  if (result === null || result.code !== 0) return null;
  const raw = safeJson(result.stdout);
  return Array.isArray(raw) ? raw.map((item) => toPullRequest(item, ownRepo)) : null;
}

export async function ghMerge(run: Run, cwd: string, url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await run(["gh", "pr", "merge", url, "--squash"], cwd, 60_000);
  if (result === null) return { ok: false, reason: "missing" };
  return result.code === 0 ? { ok: true } : { ok: false, reason: result.stderr.trim().split("\n")[0] ?? "" };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}
