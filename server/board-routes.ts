/**
 * The herdr-projects work board, acted on from the sidebar: GET /api/board/tasks lists its tasks and
 * POST /api/board/action archives, restores, removes, stops or approves one (or archives every done
 * task) through the board's own CLI. The board keeps every task's state; this only runs its command,
 * with an argument list (never a shell) built from a checked request (shared/board-tasks.ts). The
 * dispatcher in index.ts runs the access gate first, and a watching device makes no POST.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { boardApproveExpectation, boardCommand, type BoardActionResult, type BoardTask } from "../shared/board-tasks.ts";
import { badRequest, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";

export interface BoardRun { code: number; stdout: string; stderr: string }
/** runs the board with these arguments; null when the board is not installed here */
export type BoardRunner = (args: string[]) => Promise<BoardRun | null>;

/** `$HERDR_PROJECTS_BIN`, the board's own install, or one on PATH */
function boardBinary(): string | null {
  const configured = process.env["HERDR_PROJECTS_BIN"];
  if (configured) return configured;
  const installed = join(homedir(), ".herdr-projects", "data", "bin", "herdr-projects");
  return existsSync(installed) ? installed : Bun.which("herdr-projects");
}

export const runBoard: BoardRunner = async (args) => {
  const binary = boardBinary();
  if (binary === null) return null;
  // an approve merges and an archive stops an agent first: give it most of the request's minute
  const proc = Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 50_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
};

const unavailable = () => jsonResponse({ error: { code: "board_unavailable", message: "the herdr-projects board is not installed on this PC" } }, 404);
/** the board's refusal in its own words */
const refused = (run: BoardRun) => jsonResponse({ error: { code: "board_refused", message: run.stderr || run.stdout || `herdr-projects exited with ${run.code}` } }, 422);

/**
 * Every task on the board, from the board's own machine answer (`remote list`, what its web Board and
 * other machines read): one read that holds each task's checkout, step, and the pull request and
 * reviewed commit a merge's yes is checked against. A Response when the board cannot answer.
 */
async function listTasks(run: BoardRunner): Promise<BoardTask[] | Response> {
  const answer = await run(["remote", "list"]);
  if (answer === null) return unavailable();
  if (answer.code !== 0) return refused(answer);
  let listed: { tasks?: unknown };
  try { listed = JSON.parse(answer.stdout) as { tasks?: unknown }; } catch { return jsonResponse({ error: { code: "board_unreadable", message: "herdr-projects printed no task list" } }, 502); }
  const text = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;
  return (Array.isArray(listed.tasks) ? listed.tasks : [])
    .filter((task: Record<string, unknown>) => typeof task?.["id"] === "string" && typeof task["title"] === "string" && !task["archivedAt"])
    .map((task: Record<string, unknown>): BoardTask => ({
      id: String(task["id"]), title: String(task["title"]), state: String(task["state"] ?? ""), stage: String(task["stage"] ?? ""), kind: String(task["kind"] ?? ""),
      worktree: text(task["worktree"]), pr: text(task["pr"]), reviewedHead: text(task["reviewedHead"]),
    }));
}

/** The answer for a board route, or null when the path is not one. */
export async function handleBoardRequest(request: Request, pathname: string, run: BoardRunner = runBoard): Promise<Response | null> {
  if (pathname === "/api/board/tasks") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const tasks = await listTasks(run);
    if (tasks instanceof Response) return tasks;
    return jsonResponse({ tasks }, 200, { "cache-control": "no-store" });
  }
  if (pathname === "/api/board/action") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject(request);
    if (payload instanceof Response) return payload;
    const args = boardCommand(payload);
    if (args === null) return badRequest("invalid_board_action", "action must be archive, restore, clear or stop with a task id (OVS-5 or repo/5), approve with a task id and the stage and kind it was offered for, or archive-done with an optional repo");
    // approve does what the task's step asks when the board acts (a yes to a plan, a permission, or a
    // merge). The guard that holds is the board's own: its approve merges only what `seen` names
    // (shared/board-tasks.ts). This early look only says sooner, in words, that the task moved on.
    const expected = boardApproveExpectation(payload);
    if (expected !== null) {
      const tasks = await listTasks(run);
      if (tasks instanceof Response) return tasks;
      const id = String((payload as { id?: unknown }).id);
      const now = tasks.find((task) => task.id === id);
      if (!now || now.stage !== expected.stage || now.kind !== expected.kind) {
        return jsonResponse({ error: { code: "board_task_moved", message: `${id} is no longer where it was shown (now: ${now ? [now.stage, now.kind].filter(Boolean).join(", ") : "not on the board"}). Look at it again before approving.` } }, 409);
      }
    }
    const answer = await run(args);
    if (answer === null) return unavailable();
    if (answer.code !== 0) return refused(answer);
    // an approve goes through the board's machine request, which answers {ok, msg} on one line
    if (args[0] === "remote") {
      let said: { ok?: unknown; msg?: unknown };
      try { said = JSON.parse(answer.stdout) as { ok?: unknown; msg?: unknown }; } catch { return jsonResponse({ error: { code: "board_unreadable", message: "herdr-projects gave no answer" } }, 502); }
      if (said.ok !== true) return refused({ code: 1, stdout: "", stderr: typeof said.msg === "string" ? said.msg : "the board refused" });
      return jsonResponse({ message: typeof said.msg === "string" ? said.msg : "" } satisfies BoardActionResult);
    }
    return jsonResponse({ message: answer.stdout || answer.stderr } satisfies BoardActionResult);
  }
  return null;
}
