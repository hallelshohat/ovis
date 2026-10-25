/**
 * The herdr-projects work board's actions (server/board-routes.ts), in one place for the two that
 * offer them: a task's space's row menu in the sidebar (components/Sidebar.tsx) and the PC's Board
 * tasks dialog, which lists every task, also the ones whose space has closed. What each action does
 * is the board's CLI's; the page only says what the board answered. An approve says the step it was
 * offered for, so the server refuses it once the task has moved on (a plan's yes never merges).
 */
import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, Check, GitMerge, ListChecks, ShieldCheck, Square, Trash2, X, type LucideIcon } from "lucide-react";

import "./BoardTasks.css";

import { boardApproveKind, boardTaskRepo, type BoardActionRequest, type BoardTask } from "../../shared/board-tasks.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { userErrorMessage } from "../lib/userError.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import type { RowMenuItem } from "./RowMenu.tsx";

/** long enough to reach Undo */
const BOARD_NOTE_MS = 10000;

/** the board's own words after an action, with Undo after an archive; a refusal stays until dismissed */
export interface BoardNote { message: string; failed: boolean; undo?: () => void }

/** a question before an action, in ConfirmDialog's terms */
export interface BoardQuestion { title: string; body: string; action: string; run: () => Promise<void> }

/** One PC's board: its tasks, read on `refresh`, and its actions with their note. */
export function useBoard() {
  const { boardAction, fetchBoardTasks } = useMachineApi();
  // null: not asked yet, or this PC has no board (404) or did not answer
  const [tasks, setTasks] = useState<BoardTask[] | null>(null);
  const [note, setNote] = useState<BoardNote | null>(null);
  const refresh = useCallback(() => fetchBoardTasks().then(setTasks, () => setTasks(null)), [fetchBoardTasks]);
  useEffect(() => {
    if (note === null || note.failed) return;
    const timer = window.setTimeout(() => setNote(null), BOARD_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [note]);
  /** the board does it and says so; a refusal throws, for a question's dialog to show */
  const act = async (request: BoardActionRequest, undo?: BoardActionRequest): Promise<void> => {
    try {
      const { message } = await boardAction(request);
      setNote({ message, failed: false, undo: undo && (() => run(undo)) });
    } finally {
      void refresh();
    }
  };
  /** an action without a question: its refusal shows in the note */
  const run = (request: BoardActionRequest, undo?: BoardActionRequest): void => {
    setNote(null);
    act(request, undo).catch((error: unknown) => setNote({ message: error instanceof ApiError ? error.detail : userErrorMessage(error).message, failed: true }));
  };
  return { tasks, refresh, note, setNote, act, run };
}

type Board = ReturnType<typeof useBoard>;

/**
 * A task's actions where it stands now. `leave` wraps an asked action whose task's space closes
 * (the sidebar moves the focus off the row that goes).
 */
export function boardTaskItems(task: BoardTask, board: Board, ask: (question: BoardQuestion) => void, t: ReturnType<typeof useT>, leave: (deed: () => Promise<void>) => Promise<void> = (deed) => deed()): RowMenuItem[] {
  const name = `${task.id} “${task.title}”`;
  const approve: BoardActionRequest = { action: "approve", id: task.id, expect: { stage: task.stage, kind: task.kind } };
  const approves = boardApproveKind(task);
  return [
    { id: "board-archive", label: t("Archive task"), icon: Archive, divider: true, run: () => board.run({ action: "archive", id: task.id }, { action: "restore", id: task.id }) },
    ...(task.state === "working" ? [{ id: "board-stop", label: t("Stop agent"), icon: Square, run: () => board.run({ action: "stop", id: task.id }) }] : []),
    ...(approves === "plan" ? [{ id: "board-approve-plan", label: t("Approve plan"), icon: Check, run: () => board.run(approve) }] : []),
    ...(approves === "permission" ? [{ id: "board-approve-permission", label: t("Allow request"), icon: ShieldCheck, run: () => board.run(approve) }] : []),
    ...(approves === "merge" ? [{ id: "board-approve", label: t("Approve and merge…"), icon: GitMerge, run: () => ask({
      title: t("Merge {task}?", { task: name }),
      body: t("The board merges the task's finished work into its main branch, and closes its space."),
      action: t("Merge"),
      run: () => leave(() => board.act(approve)),
    }) }] : []),
    { id: "board-clear", label: t("Remove task…"), icon: Trash2, danger: true, run: () => ask({
      title: t("Remove task {task}?", { task: name }),
      body: t("The task leaves the board with its description and reviews, and its worktree is removed. Work in it that is not saved or not merged is kept."),
      action: t("Remove"),
      run: () => leave(() => board.act({ action: "clear", id: task.id })),
    }) },
  ];
}

export function BoardNoteView({ board }: { board: Board }) {
  const t = useT();
  const note = board.note;
  if (note === null) return null;
  return (
    <p className={`board-note${note.failed ? " is-failed" : ""}`} role={note.failed ? "alert" : "status"}>
      <span className="board-note-text">{note.message}</span>
      {note.undo && <button type="button" className="btn btn-ghost board-note-action" onClick={note.undo}>{t("Undo")}</button>}
      <button type="button" className="board-note-dismiss" aria-label={t("Dismiss")} onClick={() => board.setNote(null)}><X aria-hidden="true" /></button>
    </p>
  );
}

/** Every task on this PC's board with its actions, and its done tasks archived at once. */
export function BoardTasksDialog({ board, title, onClose }: { board: Board; title: string; onClose: () => void }) {
  const t = useT();
  const id = useId();
  const [question, setQuestion] = useState<BoardQuestion | null>(null);
  const surface = useFocusTrap<HTMLDivElement>(question === null);
  useSheetSwipe(surface, question === null ? onClose : null);
  usePhoneSheetBack(() => { if (question !== null) return false; onClose(); });
  const { refresh } = board;
  useEffect(() => { void refresh(); }, [refresh]);
  const tasks = board.tasks ?? [];
  const done = tasks.filter((task) => task.state === "done");
  const repos = [...new Set(done.map(boardTaskRepo))].sort();
  const button = (key: string, label: string, Icon: LucideIcon, run: () => void, danger = false) => (
    <button key={key} type="button" className={`btn btn-ghost board-task-action${danger ? " is-danger" : ""}`} onClick={run}><Icon aria-hidden="true" />{label}</button>
  );
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal board-tasks-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
        onKeyDown={(event) => { if (event.key === "Escape" && question === null) { event.stopPropagation(); onClose(); } }}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{title}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          <BoardNoteView board={board} />
          {board.tasks === null ? <p className="board-tasks-empty" role="status">{t("Loading…")}</p>
            : tasks.length === 0 ? <p className="board-tasks-empty" role="status">{t("No tasks on the board")}</p>
            : <ul className="board-tasks-list">{tasks.map((task) => (
              <li key={task.id} className="board-task" data-task={task.id}>
                <div className="board-task-head">
                  <span className="board-task-id">{task.id}</span>
                  <span className="board-task-title">{task.title}</span>
                  <span className={`board-task-state is-${task.state}`}>{[task.state, task.stage !== task.state ? task.stage : ""].filter(Boolean).join(" · ")}</span>
                </div>
                <div className="board-task-actions">{boardTaskItems(task, board, setQuestion, t).map((item) => button(item.id, item.label, item.icon, item.run, item.danger))}</div>
              </li>
            ))}</ul>}
          {done.length > 0 && <div className="board-tasks-bulk">
            {button("all", t("Archive done tasks in every repo ({n})", { n: done.length }), Archive, () => board.run({ action: "archive-done" }))}
            {repos.length > 1 && repos.map((repo) => button(repo, t("Archive done tasks in {repo} ({n})", { repo, n: done.filter((task) => boardTaskRepo(task) === repo).length }), Archive, () => board.run({ action: "archive-done", repo })))}
          </div>}
        </div>
      </div>
      {question && <ConfirmDialog title={question.title} body={question.body} confirmLabel={question.action} onConfirm={async () => { await question.run(); setQuestion(null); }} onClose={() => setQuestion(null)} />}
    </div>,
    document.body,
  );
}

/**
 * The PC header's Board tasks button: there only where this PC has a board, asked once when the PC
 * is reachable and this device may act. It opens the list of every task, whose space may be long gone.
 */
export function BoardTasksButton({ machineName, enabled }: { machineName: string; enabled: boolean }) {
  const t = useT();
  const board = useBoard();
  const [open, setOpen] = useState(false);
  const { refresh } = board;
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);
  if (!enabled || board.tasks === null) return null;
  const label = t("Board tasks on {name}", { name: machineName });
  return <>
    <button type="button" className="sidebar-row-action machine-board" aria-label={label} title={t("Board tasks")} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><ListChecks aria-hidden="true" /></button>
    {open && <BoardTasksDialog board={board} title={label} onClose={() => setOpen(false)} />}
  </>;
}
