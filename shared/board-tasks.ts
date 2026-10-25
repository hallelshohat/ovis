/**
 * The herdr-projects work board's tasks, as the sidebar acts on them: the board's own CLI does
 * every action (server/board-routes.ts), so nothing here keeps a task's state. A task's space is
 * the herdr workspace on the task's own checkout, which is how a sidebar row finds its task.
 */

/** One task as `herdr-projects list --json` and `details --json` print it; only the fields the sidebar reads. */
export interface BoardTask {
  /** `<repo>/<n>`, as the board names it in its JSON */
  id: string;
  /** idle, working, blocked, done or error */
  state: string;
  /** the board's step: `approval` waits for a merge, `plan` for a yes to the plan, `asks` for an answer */
  stage: string;
  /** while it asks: `question`, `permission` or `auth`; empty otherwise */
  kind: string;
  title: string;
  /** the task's checkout; null when it has none */
  worktree: string | null;
  /** its pull request and the commit its review passed: what a merge's yes was shown, checked again by the board */
  pr: string | null;
  reviewedHead: string | null;
}

export type BoardTaskAction = "archive" | "restore" | "clear" | "stop" | "approve";

/**
 * What an approve was offered for. The board decides from the task's step at the moment it acts what
 * approve does (a plan's yes, a permission, or a merge), so the step is checked by the board itself:
 * `seen` is the pull request and reviewed commit the merge question showed, and the board merges
 * nothing when they differ (finish_line::approve). An approve offered for anything but a merge
 * sends a pair the board never holds, so it can never merge, whatever the task has moved on to.
 */
export interface BoardApproveExpectation { stage: string; kind: string; seen: [string | null, string | null] }

/** the `seen` of an approve that is not a merge: no pull request or commit is ever this */
export const NOT_A_MERGE = "ovis:not-a-merge";

export type BoardActionRequest =
  | { action: Exclude<BoardTaskAction, "approve">; id: string }
  /** refused unless the task still stands where the menu showed it, so a stale plan yes never merges */
  | { action: "approve"; id: string; expect: BoardApproveExpectation }
  /** every done task, or a repo's only */
  | { action: "archive-done"; repo?: string };

/** what the board said when it did it, in its own words */
export interface BoardActionResult { message: string }

const TASK_ACTIONS: readonly string[] = ["archive", "restore", "clear", "stop", "approve"] satisfies BoardTaskAction[];
/** a board repo name: never one that reads as a flag */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `OVS-5` (a repo's key and the task's number) or `ovis/5` */
export function isBoardTaskId(id: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9]{1,4}-\d+$/.test(id)) return true;
  const slash = id.lastIndexOf("/");
  return slash > 0 && REPO_NAME.test(id.slice(0, slash)) && /^\d+$/.test(id.slice(slash + 1));
}

export const isBoardRepoName = (repo: string): boolean => REPO_NAME.test(repo);

const base64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** The board's arguments for a request, or null when the request is not a valid one. */
export function boardCommand(request: unknown): string[] | null {
  if (typeof request !== "object" || request === null) return null;
  const { action, id, repo } = request as Record<string, unknown>;
  if (action === "archive-done") {
    if (repo === undefined) return ["archive", "--done"];
    return typeof repo === "string" && isBoardRepoName(repo) ? ["archive", "--done", "--repo", repo] : null;
  }
  if (typeof action !== "string" || !TASK_ACTIONS.includes(action)) return null;
  if (typeof id !== "string" || !isBoardTaskId(id)) return null;
  if (action !== "approve") return [action, id];
  const expected = boardApproveExpectation(request);
  if (expected === null) return null;
  // the board's own request for an approve with what was seen (the web Board's), as one argument
  const seen = expected.stage === "approval" ? expected.seen : [NOT_A_MERGE, NOT_A_MERGE];
  return ["remote", "do", base64(JSON.stringify({ action: "approve", id, seen }))];
}

/** an approve request's expected step, or null when it names none */
export function boardApproveExpectation(request: unknown): BoardApproveExpectation | null {
  const expect = (request as { expect?: unknown } | null)?.expect;
  if (typeof expect !== "object" || expect === null) return null;
  const { stage, kind, seen } = expect as Record<string, unknown>;
  const part = (value: unknown): value is string | null => value === null || (typeof value === "string" && value.length <= 512);
  if (typeof stage !== "string" || typeof kind !== "string" || !Array.isArray(seen) || seen.length !== 2 || !part(seen[0]) || !part(seen[1])) return null;
  return { stage, kind, seen: [seen[0], seen[1]] };
}

/** What approve does for a task where it stands now, or null when approve does nothing there. */
export function boardApproveKind(task: Pick<BoardTask, "stage" | "kind">): "merge" | "plan" | "permission" | null {
  if (task.stage === "approval") return "merge";
  if (task.stage === "plan") return "plan";
  if (task.stage === "asks" && task.kind === "permission") return "permission";
  return null;
}

/** the repo part of a task's `<repo>/<n>` id */
export const boardTaskRepo = (task: Pick<BoardTask, "id">): string => task.id.slice(0, task.id.lastIndexOf("/"));

const trimSlash = (path: string): string => path.replace(/\/+$/, "");

/** The task whose own checkout this workspace is on: one workspace, one task, whatever their names say. */
export function boardTaskOf(workspace: { worktree?: { checkout_path: string; is_linked_worktree: boolean } | null }, tasks: readonly BoardTask[]): BoardTask | null {
  const checkout = workspace.worktree?.is_linked_worktree ? trimSlash(workspace.worktree.checkout_path) : null;
  if (!checkout) return null;
  const owners = tasks.filter((task) => task.worktree !== null && trimSlash(task.worktree) === checkout);
  // two tasks on one checkout (one archived and its space reused) is no answer: act on neither
  return owners.length === 1 ? owners[0]! : null;
}
