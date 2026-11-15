import { z } from "zod";
import { boardTaskOf } from "../../shared/board-tasks.ts";
import type { BoardRunner } from "../board-routes.ts";

/** The board's record is ownership evidence even when a finished task starts another chat. */
export async function boardPrContext({ cwd, run, fresh, now }: { cwd: string; run: BoardRunner; fresh: boolean; now: number }): Promise<BoardPrContext | null> {
  let entry = reads.get(run);
  if (!entry || (entry.settled && (fresh || now - entry.at > BOARD_TTL_MS))) {
    const next = { at: now, settled: false, tasks: readTasks(run).finally(() => { next.settled = true; }) };
    reads.set(run, next);
    entry = next;
  }
  const tasks = await entry.tasks;
  return boardTaskOf({ worktree: { checkout_path: cwd, is_linked_worktree: true } }, tasks);
}

export function resetBoardPrCache(): void { reads = new WeakMap(); }

const BOARD_TTL_MS = 60_000;
const taskSchema = z.object({
  id: z.string().min(1), worktree: z.string().nullish().transform((value) => value ?? null), branch: z.string().nullish().transform((value) => value ?? null),
  pr: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/).nullish().transform((value) => value ?? null),
  created: z.number().transform((ms) => new Date(ms)).pipe(z.date()).nullable().optional(),
  archivedAt: z.number().nullable().optional(),
}).transform(({ created, archivedAt, ...task }) => ({ ...task, archived: archivedAt != null, started_at: created?.toISOString() ?? null }));
const listSchema = z.object({ tasks: z.array(z.unknown()) });
export type BoardPrContext = Omit<z.infer<typeof taskSchema>, "archived">;
let reads = new WeakMap<BoardRunner, { at: number; settled: boolean; tasks: Promise<BoardPrContext[]> }>();

async function readTasks(run: BoardRunner): Promise<BoardPrContext[]> {
  const answer = await run(["remote", "list"]).catch(() => null);
  if (!answer || answer.code !== 0) return [];
  let raw: unknown;
  try { raw = JSON.parse(answer.stdout); } catch { return []; }
  const parsed = listSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.tasks.flatMap((raw) => {
    const task = taskSchema.safeParse(raw);
    if (!task.success || task.data.archived) return [];
    const { archived: _archived, ...context } = task.data;
    return [context];
  });
}
