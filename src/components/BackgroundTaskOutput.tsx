import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowDown } from "lucide-react";

import "./BackgroundTaskOutput.css";

import { ansiLines, type AnsiSpan } from "../lib/ansi.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";

/** how often a running task's output is read again */
export const OUTPUT_POLL_MS = 1000;
/** how much of an output the view keeps: past this, its start goes */
export const OUTPUT_KEEP_CHARS = 512 * 1024;
/** how close to the end counts as following it: a reader scrolled further up has paused the follow */
const FOLLOW_SLACK_PX = 24;

export interface OutputBuffer { text: string; offset: number | null; dropped: boolean; gone: boolean }
export const emptyOutput = (): OutputBuffer => ({ text: "", offset: null, dropped: false, gone: false });

/**
 * The buffer after one read: a `reset` read replaces it, any other appends; past
 * OUTPUT_KEEP_CHARS the oldest lines go, from a line's start.
 */
export function mergeOutput(buffer: OutputBuffer, read: { text: string; start: number; offset: number; reset: boolean; gone: boolean }): OutputBuffer {
  if (read.gone) return { ...buffer, gone: true };
  let text = read.reset ? read.text : buffer.text + read.text;
  // a tail read leaves out what came before its start
  let dropped = read.reset ? read.start > 0 : buffer.dropped;
  if (text.length > OUTPUT_KEEP_CHARS) {
    const cut = text.length - OUTPUT_KEEP_CHARS;
    const line = text.indexOf("\n", cut);
    text = text.slice(line === -1 ? cut : line + 1);
    dropped = true;
  }
  return { text, offset: read.offset, dropped, gone: false };
}

const spanStyle = (span: AnsiSpan): { className?: string; style?: CSSProperties } => {
  const classes: string[] = [];
  const style: CSSProperties = {};
  // inverse swaps what the text and its cell are drawn in
  const fg = span.inverse ? span.bg ?? "fg-default" : span.fg;
  const bg = span.inverse ? span.fg ?? "bg-default" : span.bg;
  if (fg === "fg-default") classes.push("ansi-fg-inverse");
  else if (typeof fg === "number") classes.push(`ansi-fg-${fg}`);
  else if (typeof fg === "string") style.color = fg;
  if (bg === "bg-default") classes.push("ansi-bg-inverse");
  else if (typeof bg === "number") classes.push(`ansi-bg-${bg}`);
  else if (typeof bg === "string") style.backgroundColor = bg;
  if (span.bold) classes.push("ansi-bold");
  if (span.dim) classes.push("ansi-dim");
  if (span.italic) classes.push("ansi-italic");
  if (span.underline) classes.push("ansi-underline");
  return { ...(classes.length > 0 ? { className: classes.join(" ") } : {}), ...(Object.keys(style).length > 0 ? { style } : {}) };
};

/**
 * A background task's output as the terminal printed it, streaming while the task runs: read
 * from where the last read stopped every OUTPUT_POLL_MS while the page is shown, once more after
 * it ends. ANSI colours are drawn in the theme's terminal colours. The view follows the end until
 * the reader scrolls up, and "Jump to latest" follows it again. At most OUTPUT_KEEP_CHARS are
 * kept: a long output loses its start, and says so.
 */
export function BackgroundTaskOutput({ paneId, taskId, running }: { paneId: string; taskId: string; running: boolean }) {
  const t = useT();
  const { fetchPaneBackgroundOutput } = useMachineApi();
  const [buffer, setBuffer] = useState<OutputBuffer>(emptyOutput);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const offset = useRef<number | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      if (document.visibilityState !== "hidden") {
        try {
          const next = await fetchPaneBackgroundOutput(paneId, taskId, offset.current);
          if (!alive) return;
          offset.current = next.gone ? offset.current : next.offset;
          setBuffer((known) => mergeOutput(known, next));
          setLoaded(true); setFailed(false);
          // a read cut at its limit has more waiting: read on at once
          if (!next.gone && next.offset < next.size) { timer = setTimeout(() => void read(), 0); return; }
        } catch {
          if (alive) setFailed(true);
        }
      }
      if (alive && running) timer = setTimeout(() => void read(), OUTPUT_POLL_MS);
    };
    void read();
    return () => { alive = false; clearTimeout(timer); };
  }, [paneId, taskId, running, fetchPaneBackgroundOutput]);

  const lines = useMemo(() => {
    const drawn = ansiLines(buffer.text).lines;
    // the newline that ends the output opens no line of its own
    if (drawn.length > 1 && drawn.at(-1)!.length === 0) drawn.pop();
    return drawn;
  }, [buffer.text]);

  const view = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const [paused, setPaused] = useState(false);
  useLayoutEffect(() => {
    const node = view.current;
    if (node !== null && follow.current) node.scrollTop = node.scrollHeight;
  }, [lines]);
  const onScroll = (): void => {
    const node = view.current;
    if (node === null) return;
    follow.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK_PX;
    setPaused(!follow.current);
  };
  const jump = (): void => {
    const node = view.current;
    follow.current = true;
    setPaused(false);
    if (node !== null) node.scrollTop = node.scrollHeight;
  };

  const empty = loaded && buffer.text.length === 0;
  return <div className="bg-output">
    {!loaded && !failed && <p className="bg-agent-note">{t("Loading…")}</p>}
    {failed && <p className="bg-agent-note is-failure" role="status">{t(loaded ? "Couldn't refresh the output: this is what it last read" : "Couldn't read the task's output")}</p>}
    {buffer.gone && <p className="bg-agent-note" role="status">{t("The session no longer keeps this task's output")}</p>}
    {empty && !buffer.gone && <p className="bg-agent-note">{t(running ? "Nothing printed yet" : "The task printed nothing")}</p>}
    {buffer.text.length > 0 && <div className="bg-output-frame">
      {/* a tab stop of its own: the keyboard scrolls a long output */}
      <pre ref={view} className="bg-output-text" tabIndex={0} aria-label={t("Output")} aria-live="off" onScroll={onScroll}>
        {buffer.dropped && <span className="bg-output-dropped">{t("Earlier output is left out")}{"\n"}</span>}
        {lines.map((line, index) => <span key={index} className="bg-output-line">{line.map((span, at) => <span key={at} {...spanStyle(span)}>{span.text}</span>)}{"\n"}</span>)}
      </pre>
      {paused && <button type="button" className="btn btn-secondary bg-output-jump" onClick={jump}><ArrowDown aria-hidden="true" />{t("Jump to latest")}</button>}
    </div>}
  </div>;
}
