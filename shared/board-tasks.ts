/**
 * The herdr-projects work board's tasks, as the sidebar acts on them: the board's own CLI does
 * every action (server/board-routes.ts), so nothing here keeps a task's state. A task's space is
 * a herdr worktree workspace named after it, which is how a sidebar row finds its task.
 */

/** One task as `herdr-projects list --json` prints it; only the fields the sidebar reads. */
export interface BoardTask {
  /** `<repo>/<n>`, as the board names it in its JSON */
  id: string;
  /** idle, working, blocked, done or error */
  state: string;
  /** the board's step: `approval` waits for a merge, `plan` for a yes to the plan */
  stage: string;
  title: string;
}

export type BoardTaskAction = "archive" | "restore" | "clear" | "stop" | "approve";

export type BoardActionRequest =
  | { action: BoardTaskAction; id: string }
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
  return typeof id === "string" && isBoardTaskId(id) ? [action, id] : null;
}

/** the repo part of a task's `<repo>/<n>` id */
export const boardTaskRepo = (task: Pick<BoardTask, "id">): string => task.id.slice(0, task.id.lastIndexOf("/"));

/**
 * The task a workspace is the space of: one of the task's repo, labelled with its title, or with
 * its key and number first (`OVS-5 Close and archive…`), as the board names the spaces it opens.
 */
export function boardTaskOf(workspace: { label: string; worktree?: { repo_name: string; is_linked_worktree: boolean } | null }, tasks: readonly BoardTask[]): BoardTask | null {
  if (!workspace.worktree?.is_linked_worktree) return null;
  const keyed = /^[A-Za-z][A-Za-z0-9]{1,4}-(\d+) (.+)$/.exec(workspace.label);
  return tasks.find((task) => {
    if (boardTaskRepo(task) !== workspace.worktree!.repo_name) return false;
    if (workspace.label === task.title) return true;
    return keyed !== null && keyed[2] === task.title && task.id.endsWith(`/${keyed[1]}`);
  }) ?? null;
}
