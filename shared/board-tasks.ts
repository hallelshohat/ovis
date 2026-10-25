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
  /** the task's checkout, from `details --json`; null when it has none (or the board did not say) */
  worktree: string | null;
}

export type BoardTaskAction = "archive" | "restore" | "clear" | "stop" | "approve";

/** what an approve was offered for: the board decides from the task's current step what approve does */
export interface BoardApproveExpectation { stage: string; kind: string }

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

/** The board's arguments for a request, or null when the request is not a valid one. */
export function boardCommand(request: unknown): string[] | null {
  if (typeof request !== "object" || request === null) return null;
  const { action, id, repo } = request as Record<string, unknown>;
  if (action === "archive-done") {
    if (repo === undefined) return ["archive", "--done"];
    return typeof repo === "string" && isBoardRepoName(repo) ? ["archive", "--done", "--repo", repo] : null;
  }
  if (typeof action !== "string" || !TASK_ACTIONS.includes(action)) return null;
  if (action === "approve" && boardApproveExpectation(request) === null) return null;
  return typeof id === "string" && isBoardTaskId(id) ? [action, id] : null;
}

/** an approve request's expected step, or null when it names none */
export function boardApproveExpectation(request: unknown): BoardApproveExpectation | null {
  const expect = (request as { expect?: unknown } | null)?.expect;
  if (typeof expect !== "object" || expect === null) return null;
  const { stage, kind } = expect as Record<string, unknown>;
  return typeof stage === "string" && typeof kind === "string" ? { stage, kind } : null;
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
