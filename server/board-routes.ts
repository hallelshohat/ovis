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
import { boardCommand, type BoardActionResult, type BoardTask } from "../shared/board-tasks.ts";
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

/** The answer for a board route, or null when the path is not one. */
export async function handleBoardRequest(request: Request, pathname: string, run: BoardRunner = runBoard): Promise<Response | null> {
  if (pathname === "/api/board/tasks") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const answer = await run(["list", "--json"]);
    if (answer === null) return unavailable();
    if (answer.code !== 0) return refused(answer);
    let listed: unknown;
    try { listed = JSON.parse(answer.stdout); } catch { return jsonResponse({ error: { code: "board_unreadable", message: "herdr-projects printed no task list" } }, 502); }
    const tasks: BoardTask[] = (Array.isArray(listed) ? listed : []).flatMap((task: Record<string, unknown>) =>
      typeof task?.["id"] === "string" && typeof task["title"] === "string"
        ? [{ id: task["id"], title: task["title"], state: String(task["state"] ?? ""), stage: String(task["stage"] ?? "") }]
        : []);
    return jsonResponse({ tasks }, 200, { "cache-control": "no-store" });
  }
  if (pathname === "/api/board/action") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject(request);
    if (payload instanceof Response) return payload;
    const args = boardCommand(payload);
    if (args === null) return badRequest("invalid_board_action", "action must be archive, restore, clear, stop or approve with a task id (OVS-5 or repo/5), or archive-done with an optional repo");
    const answer = await run(args);
    if (answer === null) return unavailable();
    if (answer.code !== 0) return refused(answer);
    return jsonResponse({ message: answer.stdout || answer.stderr } satisfies BoardActionResult);
  }
  return null;
}
