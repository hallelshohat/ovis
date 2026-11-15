import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { Bot, ChevronDown, ChevronRight, Eye, RefreshCw, SquareTerminal, Workflow, X, type LucideProps } from "lucide-react";

import "./ChatView.css";
import "./BackgroundAgentDetail.css";

import { BackgroundTaskOutput } from "./BackgroundTaskOutput.tsx";
import { Markdown } from "./Markdown.tsx";
import { formatElapsed, taskElapsedMs } from "../lib/omoTasks.ts";
import { workRowLabel } from "../lib/workRowLabel.ts";
import { toolSummary } from "../../shared/tool-summary.ts";

import { ApiError, routeMissing } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import type { BackgroundTaskKind, OmoTask, PaneBackgroundAgentDetail } from "../../shared/protocol.ts";

export const KIND_ICONS: Record<BackgroundTaskKind, ComponentType<LucideProps>> = {
  subagent: Bot, command: SquareTerminal, exec: SquareTerminal, monitor: Eye, workflow: Workflow,
};

/** A task's kind as the list and the sheet name it; OmO's and OpenCode's tasks name none. */
export function taskKind(task: OmoTask): BackgroundTaskKind | null {
  return task.kind ?? (task.detail_kind === "claude-subagent" ? "subagent" : null);
}

/** One tool call of a subagent, drawn as the chat draws a call: a row that opens to its arguments. */
function AgentToolRow({ name, args }: { name: string; args: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { summary, pretty, input } = useMemo(() => {
    let parsed: unknown = null;
    try { parsed = JSON.parse(args); } catch { /* cut arguments: shown as they are */ }
    const fields = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    return { summary: toolSummary(name, fields), pretty: parsed === null ? args : JSON.stringify(parsed, null, 2), input: args };
  }, [name, args]);
  const { verb, narration } = useMemo(() => workRowLabel({ name, input }, summary), [name, input, summary]);
  const hasArgs = args.length > 0 && args !== "{}";
  return <div className="work-row">
    <div className="work-row-line">
      <button type="button" className="work-row-head" aria-expanded={hasArgs ? open : undefined} disabled={!hasArgs} title={`${name} · ${summary}`} onClick={() => setOpen(!open)}>
        <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
        {!narration && (verb !== null ? <span className="work-row-name is-verb">{t(verb)}</span> : <span className="work-row-name">{name}</span>)}
        {summary.length > 0 && summary !== name && <>{" "}<span className="work-row-summary">{summary}</span></>}
      </button>
    </div>
    {open && <div className="work-row-detail"><p className="work-row-tool">{name}</p><pre className="chat-tool-io">{pretty}</pre></div>}
  </div>;
}

/** why the detail was not read: each has a note of its own, and none shows an empty view as if it were the agent's */
type Failure = "update" | "unsupported" | "missing" | "changed" | "offline" | "unavailable" | "error";

const failureOf = (error: unknown): Failure => {
  if (routeMissing(error)) return "update";
  if (!(error instanceof ApiError)) return "error";
  if (error.status === 501) return "unsupported";
  if (error.status === 404) return "missing";
  if (error.status === 409) return "changed";
  if (error.code === "machine_offline") return "offline";
  if (error.status === 503) return "unavailable";
  return "error";
};

/**
 * What a running background task is doing, read from the PC on request: for a Claude Code
 * subagent (`detail_kind` claude-subagent) its own transcript, for an OpenCode one (opencode-subagent)
 * its child session, bounded, as text; the prompt it was
 * dispatched with, then its prose and the tools it called. A task of another kind has no transcript
 * to open and the sheet says so, as it does for a PC whose bridge is from before the route; nothing
 * is shown as the agent's that the PC did not read. Read when opened and on Refresh, never polled.
 * A dialog over the task list: Escape, the scrim and a phone's Back close it, and the focus goes
 * back to the row that opened it.
 */
export function BackgroundAgentDetail({ paneId, task, onClose, clockOffset = 0 }: { paneId: string; task: OmoTask; onClose: () => void; clockOffset?: number }) {
  const t = useT();
  const id = useId();
  const { fetchPaneBackgroundAgent } = useMachineApi();
  const supported = task.detail_kind === "claude-subagent" || task.detail_kind === "opencode-subagent";
  const output = task.detail_kind === "output";
  const [detail, setDetail] = useState<PaneBackgroundAgentDetail | null>(null);
  const [loading, setLoading] = useState(supported);
  const [failure, setFailure] = useState<Failure | null>(supported || output ? null : task.detail_kind === undefined ? "update" : "unsupported");
  const running = task.status === "running";
  // a running task's time ticks with the PC's clock
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  // each read is one generation: an answer to an earlier read, or to a read of a sheet since closed, is dropped
  const generation = useRef(0);
  // the agent's session the sheet shows, as its first answer named it: an answer of another session is
  // the pane's next session, whose agent of the same id is another agent, and is never shown here
  const session = useRef<string | null>(null);
  const load = useCallback((): void => {
    const mine = ++generation.current;
    setLoading(true);
    fetchPaneBackgroundAgent(paneId, task.id).then(
      (next) => {
        if (mine !== generation.current) return;
        if (session.current !== null && next.session_id !== session.current) { setDetail(null); setFailure("changed"); setLoading(false); return; }
        session.current = next.session_id;
        setDetail(next); setFailure(null); setLoading(false);
      },
      (reason: unknown) => {
        if (mine !== generation.current) return;
        const failed = failureOf(reason);
        // what is no longer this agent's, in this pane's session, goes with it: only a passing failure leaves the last read up
        if (failed !== "offline" && failed !== "unavailable" && failed !== "error") setDetail(null);
        setFailure(failed); setLoading(false);
      },
    );
  }, [fetchPaneBackgroundAgent, paneId, task.id]);
  useEffect(() => {
    if (supported) load();
    return () => { generation.current += 1; };
  }, [supported, load]);

  const surface = useFocusTrap<HTMLElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // what happened, then what to do about it: each on a line of its own
  const notes: Record<Failure, [string, string]> = {
    update: [t("This PC's bridge does not offer this yet"), t("Update this PC's bridge to see what a running agent is doing.")],
    unsupported: [t("This PC can't show details for this task"), t("Only Claude Code, Codex and OpenCode background tasks can be opened here.")],
    missing: [t("The agent is no longer in this pane's session"), t("It may have ended. Close this and look at the task list again.")],
    changed: [t("The pane moved to another session"), t("Close this and open the task again from the list.")],
    offline: [t("This PC is disconnected"), t("Refresh once the PC is connected again.")],
    unavailable: [t("The agent's files can't be read right now"), t("Try Refresh in a moment.")],
    error: [t("Couldn't read the agent's details"), t("Try Refresh. If it keeps failing, restart Ovis on the PC.")],
  };
  const note = (lines: string[], className = "bg-agent-note", role?: "status") => <p className={className} role={role}>{lines.map((line) => <span key={line} className="bg-agent-note-line">{line}</span>)}</p>;
  const kind = taskKind(task);
  const kindWords: Record<BackgroundTaskKind, string> = { subagent: t("Subagent"), command: t("Background command"), exec: t("Background terminal"), monitor: t("Monitor"), workflow: t("Workflow") };
  const statusWords: Record<OmoTask["status"], string> = { running: t("running"), completed: t("done"), failed: t("failed"), cancelled: t("stopped"), lost: t("lost") };
  const Icon = kind === null ? KIND_ICONS.command : KIND_ICONS[kind];
  const elapsed = taskElapsedMs(task, now + clockOffset);
  const startedAt = task.started_at === null ? NaN : Date.parse(task.started_at) - clockOffset;
  const meta = [
    kind === null ? null : kindWords[kind],
    kind === "subagent" ? detail?.agent ?? task.category : null,
    task.model,
    Number.isFinite(startedAt) ? t("started {time}", { time: new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }) : null,
    elapsed === null ? null : formatElapsed(elapsed),
  ].filter((part) => part !== null && part !== undefined).join(" · ");
  const exit = task.exit_code ?? null;
  const command = task.command && task.command !== task.title ? task.command : null;
  const empty = detail !== null && detail.prompt === null && detail.events.length === 0;
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={surface} className="modal bg-agent-detail" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-busy={loading} tabIndex={-1}>
        <header className="modal-header bg-agent-detail-header">
          <Icon className={`bg-agent-detail-icon is-${task.status}`} aria-hidden="true" />
          <div className="bg-agent-detail-heading">
            <h2 className="modal-title bg-agent-detail-title" id={`${id}-title`}>{detail?.title ?? task.title}</h2>
            <p className="bg-agent-detail-meta">
              <span className={`bg-agent-status is-${task.status}`}>{statusWords[task.status]}</span>
              {exit !== null && <>{" "}<span className={`bg-agent-exit${exit === 0 ? "" : " is-error"}`}>{t("exit {n}", { n: exit })}</span></>}
              {meta.length > 0 && <>{" · "}{meta}</>}
            </p>
            {command !== null && <code className="bg-agent-detail-command">{command}</code>}
          </div>
          {supported && <button type="button" className="icon-button" aria-label={t("Refresh")} title={t("Refresh")} disabled={loading} onClick={load}><RefreshCw aria-hidden="true" /></button>}
          <button type="button" className="icon-button" aria-label={t("Close details")} title={t("Close details")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className={`modal-body bg-agent-detail-body${output ? " is-output" : ""}`} role="region" aria-labelledby={`${id}-title`} tabIndex={output ? undefined : 0}>
          {output && <BackgroundTaskOutput paneId={paneId} taskId={task.id} running={running} />}
          {loading && detail === null && note([t("Loading…")])}
          {failure !== null && note(notes[failure], "bg-agent-note is-failure", "status")}
          {failure !== null && detail !== null && note([t("Couldn't refresh: this is what it last read")])}
          {empty && note([t("Nothing recorded yet"), t("The agent may still be starting. Try Refresh in a moment.")])}
          {detail?.truncated === true && note([t("The agent wrote more than this view reads."), t("The middle part is left out.")])}
          {detail?.incomplete === true && note([t("Some records couldn't be read and are left out")])}
          {/* the subagent's conversation as the chat draws one: the prompt it was given in the user's seat,
              then its words as prose and each tool it called as a work row */}
          {detail?.prompt !== null && detail?.prompt !== undefined && <div className="chat-user-row bg-agent-prompt">
            <div className="chat-bubble"><div className="chat-bubble-body"><Markdown>{detail.prompt}</Markdown></div></div>
          </div>}
          {detail !== null && detail.events.length > 0 && <div className="bg-agent-turn" aria-label={t("Work so far")}>
            {detail.events.map((event, index) => {
              if (event.kind === "text") return <div key={index} className="bg-agent-prose"><Markdown>{event.text}</Markdown></div>;
              // the server writes a tool event as its name, a space, then the arguments as JSON
              const space = event.text.indexOf(" ");
              return <AgentToolRow key={index} name={space === -1 ? event.text : event.text.slice(0, space)} args={space === -1 ? "" : event.text.slice(space + 1)} />;
            })}
            {running && <p className="bg-agent-working">{t("Working…")}</p>}
          </div>}
        </div>
      </section>
    </div>,
    document.body,
  );
}
