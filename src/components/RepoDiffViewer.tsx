import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Columns2, Copy, CopySlash, FileText, FoldVertical, Rows3, Search, TriangleAlert, X } from "lucide-react";

import "./FindBar.css";
import "./RepoChanges.css";
import "./RepoDiffViewer.css";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { Skeleton } from "./Skeleton.tsx";

import type { RepoDiffFile, RepoDiffFilePatch } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { pathParts } from "../lib/filePaths.ts";
import { canHighlight, languageForPath } from "../lib/highlight.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { comparisonChangedWord, comparisonWord, diffColorable, diffErrorMessage, diffStyleFor, repositoryFilePath, sameComparison, STATUS_MARK, statusWord, unavailableMessage, type RepoDiffTarget } from "../lib/repoDiff.ts";
import { DIFF_FIND_MAX_QUERY, diffChanges, diffFindLines, findInDiff, stepMatch, type DiffFindMatch } from "../lib/repoDiffFind.ts";
import { useSettings } from "../lib/settings.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { skeletonRows } from "../lib/skeleton.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";

const RepoDiff = lazy(() => import("./RepoDiff.tsx"));

export interface RepoDiffViewerProps {
  target: RepoDiffTarget;
  onClose: () => void;
  /** opens the file itself (an absolute path on the PC that holds the repository) in the file viewer */
  onOpenFile: (path: string) => void;
  /** a file preview or Settings above it takes Escape */
  keyboardActive?: boolean;
  /** another changed file of the same comparison, picked in the file column or stepped to */
  onSwitchFile: (file: RepoDiffFile) => void;
}

/** The file column beside the rows: from this width, as VS Code's changes list beside its diff; narrower, a stepper in the header. */
const FILE_COLUMN_QUERY = "(min-width: 901px)";

/** Whether a key press belongs to a text field, where arrows and function keys keep their own meaning. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select") !== null);
}

/** `stale`: a branch patch answered for another identity than the list's, which is never drawn as this one */
type Load = { status: "pending" } | { status: "failed"; error: unknown } | { status: "stale" } | { status: "ready"; answer: RepoDiffFilePatch };
const PENDING: Load = { status: "pending" };

/** the text shown as one selected box when the clipboard is out of reach: the patch, or the file's path */
type Shown = { kind: "patch" | "path"; text: string };

/** Copies a text (disabled until there is one); without a clipboard, hands it over to be shown as a selected text box instead. */
function CopyButton({ text, label, doneLabel, icon, onShowText }: { text: string | null; label: string; doneLabel: string; icon: ReactNode; onShowText: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const name = copied ? doneLabel : label;
  const copy = async (): Promise<void> => {
    if (text === null) return;
    if (await copyText(text)) setCopied(true);
    else onShowText(text);
  };
  return <button type="button" className="icon-button repo-diff-action" aria-label={name} title={name} disabled={text === null} onClick={() => void copy()}>
    {copied ? <Check aria-hidden="true" /> : icon}
  </button>;
}

/** Where the active match is, in words: its kind and its line on its side, so it is not told by the row's tint alone. */
function matchPlace(t: Translate, match: DiffFindMatch): string {
  const line = match.line.toLocaleString();
  switch (match.kind) {
    case "addition": return t("Added line {line}", { line });
    case "deletion": return t("Removed line {line}", { line });
    case "context": return t("Unchanged line {line}", { line });
  }
}

const DIFF_SKELETON_ROWS = 6;

/** Rows the size of a diff's, a number and a line each, while the patch is read or its viewer loads: the dialog holds its shape. */
function DiffSkeleton({ label }: { label: string }) {
  return <div className="repo-diff-loading" role="status">
    <span className="visually-hidden">{label}</span>
    {skeletonRows(DIFF_SKELETON_ROWS).map((width, index) => <div key={index} className="repo-diff-loading-row" aria-hidden="true">
      <Skeleton className="repo-diff-loading-number" />
      <Skeleton width={width} />
    </div>)}
  </div>;
}

/**
 * One changed file of a repository, compared as the Changes list was: its patch as a window of
 * rows, unified or side by side (Settings → File viewer, one column on a phone), with the context
 * around each change folded to a line or shown whole, the file's status and counts in the header
 * (their places kept while the patch is on its way), the file itself a tap away in the file viewer,
 * and the patch copied as git printed it, or the file's path on its own.
 */
export function RepoDiffViewer({ target, onClose, onOpenFile, keyboardActive = true, onSwitchFile }: RepoDiffViewerProps) {
  const t = useT();
  const { settings, update, resolvedEntry } = useSettings();
  const { fetchRepoDiffFile, fetchRepoDiffFiles, fetchRepoDiffContents } = useMachineApi();
  const surface = useFocusTrap<HTMLElement>(true);
  const narrow = useMediaQuery(SHEET_QUERY);
  const columned = useMediaQuery(FILE_COLUMN_QUERY);
  // the comparison's other files, for the column and the stepper: read by the viewer itself, so a reload that restores it has them too
  const [siblings, setSiblings] = useState<RepoDiffFile[] | null>(null);
  // the change brought into view by Previous/Next change; none until the reader steps
  const [changeIndex, setChangeIndex] = useState<number | null>(null);
  const filesRef = useRef<HTMLUListElement>(null);
  const [load, setLoad] = useState<Load>(PENDING);
  const [folded, setFolded] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Find in this diff: local to the dialog, over the loaded patch only
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // each open (the button, Ctrl/Cmd+F) focuses the query, also on a bar already open
  const [findRequest, setFindRequest] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const findButton = useRef<HTMLButtonElement>(null);
  // the control that opened Find, which gets the focus back when it closes
  const findOpener = useRef<HTMLElement | null>(null);
  const findingRef = useRef(finding);
  findingRef.current = finding;
  useSheetSwipe(surface, onClose);

  const { paneId, directory, scope, base, head, comparison, path, oldPath } = target;
  useEffect(() => {
    let live = true;
    setLoad(PENDING);
    setShown(null);
    fetchRepoDiffFile({ paneId, directory, scope, base, head, comparison }, path, oldPath).then(
      // a branch patch is the list's comparison or nothing: one answered for another identity is not drawn
      (answer) => { if (live) setLoad(sameComparison(answer.comparison ?? null, comparison) ? { status: "ready", answer } : { status: "stale" }); },
      (error: unknown) => { if (live) setLoad({ status: "failed", error }); },
    );
    return () => { live = false; };
  }, [fetchRepoDiffFile, paneId, directory, scope, base, head, comparison, path, oldPath]);

  useEffect(() => {
    let live = true;
    setSiblings(null);
    // a list names its base, never the pinned identity; one that answers for another identity (HEAD moved) is not this comparison's
    fetchRepoDiffFiles({ paneId, directory, scope, base: comparison?.base_oid ?? base, head, comparison: null }).then(
      (list) => { if (live && sameComparison(list.comparison ?? null, comparison)) setSiblings(list.files); },
      () => undefined,
    );
    return () => { live = false; };
  }, [fetchRepoDiffFiles, paneId, directory, scope, base, head, comparison]);

  const loadContents = useCallback(() => fetchRepoDiffContents({ paneId, directory, scope, base, head, comparison }, path, oldPath), [fetchRepoDiffContents, paneId, directory, scope, base, head, comparison, path, oldPath]);

  const patchText = load.status === "ready" ? load.answer.patch : null;
  // a new file, comparison or patch drops the query and its active match: their lines were another patch's
  useEffect(() => {
    setQuery("");
    setActiveIndex(null);
    setChangeIndex(null);
  }, [patchText]);

  const openFind = useCallback((): void => {
    const focused = document.activeElement;
    // Ctrl/Cmd+F again on an open bar only refocuses the query: the control that first opened it keeps the return
    if (!findingRef.current || findOpener.current?.isConnected !== true) findOpener.current = focused instanceof HTMLElement && focused !== findInput.current ? focused : findButton.current;
    // the copy fallback's text stands in for the diff: Find goes back to the rows it marks
    setShown(null);
    setFinding(true);
    setFindRequest((request) => request + 1);
  }, []);
  useLayoutEffect(() => {
    if (findRequest === 0) return;
    findInput.current?.focus();
    findInput.current?.select();
  }, [findRequest]);
  // the query and its active match stay for a reopen, which shows them again; a new patch drops both (above)
  const closeFind = useCallback((): void => {
    setFinding(false);
    const opener = findOpener.current;
    findOpener.current = null;
    (opener?.isConnected === true ? opener : findButton.current)?.focus();
  }, []);

  useEffect(() => {
    if (!keyboardActive) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229 || nativeModalOver(surface.current)) return;
      // a dialog above the viewer (the palette) keeps its own keys while it has the focus
      const coveredBy = (): boolean => {
        const focused = document.activeElement;
        const owner = focused instanceof Element && surface.current?.contains(focused) !== true ? focused.closest("dialog, [aria-modal='true']") : null;
        return owner !== null && surface.current !== null && !owner.contains(surface.current);
      };
      // Ctrl/Cmd+F is this dialog's: the browser's own find cannot reach the rows not mounted
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        if (coveredBy()) return;
        event.preventDefault();
        if (patchText !== null || findingRef.current) openFind();
        return;
      }
      // VS Code's F7 / Shift+F7 and Alt+Down / Alt+Up step the changes; Alt+Shift+Down / Up steps the files
      if (!event.ctrlKey && !event.metaKey && !typing(event.target)) {
        const down = event.key === "ArrowDown";
        const step = event.key === "F7" && !event.altKey ? (event.shiftKey ? -1 : 1) : event.altKey && (down || event.key === "ArrowUp") ? (down ? 1 : -1) : null;
        if (step !== null && !coveredBy()) {
          event.preventDefault();
          if (event.altKey && event.shiftKey) stepsRef.current.file(step);
          else stepsRef.current.change(step);
          return;
        }
      }
      if (event.key !== "Escape") return;
      // Escape closes Find first, the viewer on the next press
      if (findingRef.current) { event.preventDefault(); closeFind(); return; }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, keyboardActive, surface, patchText, openFind, closeFind]);

  useLayoutEffect(() => {
    if (shown === null) return;
    textRef.current?.focus();
    textRef.current?.select();
  }, [shown]);

  const answer = load.status === "ready" ? load.answer : null;
  const file = answer?.file ?? null;
  const patch = answer?.patch ?? null;
  const style = diffStyleFor(settings.diffStyle, narrow);
  const wantsColor = canHighlight(languageForPath(path));
  const colored = patch !== null && diffColorable(path, patch);
  const notes = [
    wantsColor && patch !== null && !colored ? t("Too long to highlight") : null,
    narrow && settings.diffStyle === "split" ? t("Split view needs a wider screen; showing one column.") : null,
  ].filter((note): note is string => note !== null);
  const { stem, extension } = pathParts(path);
  const { folder } = pathParts(path);
  const openable = answer !== null && file !== null && file.status !== "deleted";
  const findLines = useMemo(() => diffFindLines(patch), [patch]);
  const matches = useMemo(() => findInDiff(findLines, query), [findLines, query]);
  const current = activeIndex !== null && activeIndex < matches.length ? activeIndex : null;
  const activeMatch = current === null ? null : matches[current] ?? null;
  const step = (direction: 1 | -1): void => setActiveIndex(stepMatch(current, matches.length, direction));
  const changes = useMemo(() => diffChanges(findLines), [findLines]);
  const currentChange = changeIndex !== null && changeIndex < changes.length ? changeIndex : null;
  const changeLine = finding || currentChange === null ? null : changes[currentChange] ?? null;
  // a change's row is ringed and brought to the middle as a match's is, with no text painted
  const changeMark = useMemo(() => (changeLine === null ? null : { side: changeLine.side, line: changeLine.line, start: 0, end: 0 }), [changeLine]);
  const fileIndex = siblings?.findIndex((file) => file.path === path) ?? -1;
  const neighbour = (direction: 1 | -1): RepoDiffFile | null => (siblings === null || fileIndex < 0 ? null : siblings[fileIndex + direction] ?? null);
  const stepChange = (direction: 1 | -1): void => {
    // Find's match holds the ring while its bar is open: a change step hands it back to the changes
    if (finding) closeFind();
    setChangeIndex(stepMatch(currentChange, changes.length, direction));
  };
  const stepFile = (direction: 1 | -1): void => {
    const file = neighbour(direction);
    if (file !== null) onSwitchFile(file);
  };
  const stepsRef = useRef({ change: stepChange, file: stepFile });
  stepsRef.current = { change: stepChange, file: stepFile };
  const changeCount = currentChange === null ? "" : t("Change {current} of {total}", { current: (currentChange + 1).toLocaleString(), total: changes.length.toLocaleString() });
  const unfold = useCallback(() => setFolded(false), []);
  const findCount = query === "" ? "" : current !== null ? t("{current} of {total}", { current: current + 1, total: matches.length }) : matches.length === 0 ? t("No matches") : "";

  const body = (() => {
    if (shown !== null) return <textarea ref={textRef} className="repo-diff-select-source" readOnly value={shown.text} aria-label={shown.kind === "patch" ? t("Patch") : t("Path")} spellCheck={false} />;
    if (load.status === "pending") return <DiffSkeleton label={t("Opening…")} />;
    if (load.status === "stale") return <p className="repo-diff-note" role="alert">{comparisonChangedWord(t)}</p>;
    if (load.status === "failed") {
      const stale = load.error instanceof ApiError && load.error.status === 404 && load.error.code === "not_found";
      return <p className="repo-diff-note" role="alert">{stale ? t("This file has no changes here any more; the list is out of date.") : diffErrorMessage(t, load.error)}</p>;
    }
    const unavailable = unavailableMessage(t, load.answer);
    if (unavailable !== null || patch === null) return <p className="repo-diff-note">{unavailable ?? t("No lines changed.")}</p>;
    return <RenderBoundary resetKey={patch} fallback={() => <p className="repo-diff-note" role="alert">{t("This change can't be shown.")}</p>}>
      <Suspense fallback={<DiffSkeleton label={t("Opening…")} />}>
        <RepoDiff patch={patch} style={style} folded={folded} wrap={settings.wrapCode} theme={resolvedEntry.mode} colored={colored} active={finding ? activeMatch : changeMark} onUnfold={unfold} loadContents={loadContents} />
      </Suspense>
    </RenderBoundary>;
  })();

  return (
    <div className="modal-scrim repo-diff-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal repo-diff-viewer" role="dialog" aria-modal="true" aria-label={t("Changes to {name}", { name: `${stem}${extension}` })} ref={surface} tabIndex={-1}>
        <header className="modal-header repo-diff-header">
          <div className="repo-diff-title">
            <h2 className="modal-title"><span className="repo-diff-stem">{stem}</span>{extension}</h2>
            <p className="repo-diff-meta" title={oldPath === null ? path : t("Renamed from {path}", { path: oldPath })}>
              {load.status === "pending" && <>
                <Skeleton className="repo-diff-skeleton-status" />
                <Skeleton className="repo-diff-skeleton-counts" />
              </>}
              {file !== null && <span className="repo-diff-status" data-status={file.status}>{statusWord(t, file.status)}</span>}
              {file !== null && file.additions !== null && file.deletions !== null && <span className="repo-diff-counts">
                <span className="repo-diff-added">+{file.additions.toLocaleString()}</span>
                <span className="repo-diff-deleted">−{file.deletions.toLocaleString()}</span>
              </span>}
              {file?.binary === true && <span className="repo-diff-binary">{t("Binary")}</span>}
              {notes.length > 0 && <span className="repo-diff-notice" title={notes.join("\n")}>
                <TriangleAlert aria-hidden="true" />
                <span>{notes[0]}</span>
                <span className="visually-hidden">{notes.join(". ")}</span>
              </span>}
              <span className="repo-diff-compare">{comparisonWord(t, target)}</span>
              {/* a rename shows where it came from, cut from its start as the folder is */}
              {oldPath !== null
                ? <span className="repo-diff-path" title={t("Renamed from {path}", { path: oldPath })}><span dir="ltr">{oldPath} → {path}</span></span>
                : folder !== "" && <span className="repo-diff-path"><span dir="ltr">{folder}</span></span>}
            </p>
          </div>
          <div className="repo-diff-actions">
            <div className="segmented repo-diff-styles" role="group" aria-label={t("Diff layout")}>
              <button type="button" aria-pressed={style === "unified"} onClick={() => update({ diffStyle: "unified" })}><Rows3 aria-hidden="true" /><span className="repo-diff-style-word">{t("Unified")}</span></button>
              <button type="button" aria-pressed={style === "split"} disabled={narrow} title={narrow ? t("Split view needs a wider screen") : undefined} onClick={() => update({ diffStyle: "split" })}><Columns2 aria-hidden="true" /><span className="repo-diff-style-word">{t("Split")}</span></button>
            </div>
            <div className="repo-diff-changes" role="group" aria-label={t("Changes")}>
              <button type="button" className="icon-button repo-diff-action" aria-label={t("Previous change")} title={`${t("Previous change")} (Shift+F7)`} disabled={changes.length === 0} onClick={() => stepChange(-1)}><ChevronUp aria-hidden="true" /></button>
              <button type="button" className="icon-button repo-diff-action" aria-label={t("Next change")} title={`${t("Next change")} (F7)`} disabled={changes.length === 0} onClick={() => stepChange(1)}><ChevronDown aria-hidden="true" /></button>
              <span className="repo-diff-change-count" role="status">{changeCount}</span>
            </div>
            {!columned && siblings !== null && siblings.length > 1 && fileIndex >= 0 && <div className="repo-diff-stepper" role="group" aria-label={t("Changed files")}>
              <button type="button" className="icon-button repo-diff-action" aria-label={t("Previous file")} title={t("Previous file")} disabled={neighbour(-1) === null} onClick={() => stepFile(-1)}><ChevronLeft aria-hidden="true" /></button>
              <span className="repo-diff-file-count"><span aria-hidden="true">{(fileIndex + 1).toLocaleString()}/{siblings.length.toLocaleString()}</span><span className="visually-hidden">{t("File {current} of {total}", { current: (fileIndex + 1).toLocaleString(), total: siblings.length.toLocaleString() })}</span></span>
              <button type="button" className="icon-button repo-diff-action" aria-label={t("Next file")} title={t("Next file")} disabled={neighbour(1) === null} onClick={() => stepFile(1)}><ChevronRight aria-hidden="true" /></button>
            </div>}
            <div className="repo-diff-group">
              <button ref={findButton} type="button" className="icon-button repo-diff-action" aria-pressed={finding} aria-label={t("Find in diff")} title={patch === null && !finding ? t("There is no loaded patch to search.") : t("Find in diff")} disabled={patch === null && !finding} onClick={() => (finding ? closeFind() : openFind())}><Search aria-hidden="true" /></button>
              <button type="button" className="icon-button repo-diff-action" aria-pressed={folded} aria-label={t("Fold context")} title={folded ? t("Showing one line around each change") : t("Fold context")} disabled={patch === null} onClick={() => setFolded((value) => !value)}><FoldVertical aria-hidden="true" /></button>
              <button type="button" className="icon-button repo-diff-action" aria-label={t("Open file")} title={t("Open file")} disabled={!openable} onClick={() => answer !== null && onOpenFile(repositoryFilePath(answer.repository.root, path))}><FileText aria-hidden="true" /></button>
              {shown === null && <>
                <CopyButton text={path} label={t("Copy path")} doneLabel={t("Path copied")} icon={<CopySlash aria-hidden="true" />} onShowText={(text) => setShown({ kind: "path", text })} />
                {(load.status === "pending" || patch !== null) && <CopyButton text={patch} label={t("Copy patch")} doneLabel={t("Patch copied")} icon={<Copy aria-hidden="true" />} onShowText={(text) => setShown({ kind: "patch", text })} />}
              </>}
            </div>
          </div>
          <button type="button" className="icon-button repo-diff-action repo-diff-close" aria-label={t("Close diff")} title={t("Close diff")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {finding && <form className="find-bar repo-diff-find" role="search" aria-label={t("Find in diff")} onSubmit={(event) => { event.preventDefault(); step(1); }}>
          <div className="find-bar-controls">
            <label className="find-bar-query">
              <Search size={16} aria-hidden="true" />
              <span className="repo-diff-find-label">{t("Find in diff")}</span>
              <input ref={findInput} className="input" type="search" value={query} maxLength={DIFF_FIND_MAX_QUERY} disabled={patch === null} spellCheck={false}
                onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
                }} />
            </label>
            <span className="find-bar-count" role="status">
              {findCount}
              {activeMatch !== null && <span className="repo-diff-find-place">{matchPlace(t, activeMatch)}</span>}
            </span>
            <button className="icon-button repo-diff-action" type="button" aria-label={t("Previous match")} title={t("Previous match")} disabled={matches.length === 0} onClick={() => step(-1)}><ArrowUp size={16} aria-hidden="true" /></button>
            <button className="icon-button repo-diff-action" type="button" aria-label={t("Next match")} title={t("Next match")} disabled={matches.length === 0} onClick={() => step(1)}><ArrowDown size={16} aria-hidden="true" /></button>
            <button className="icon-button repo-diff-action" type="button" aria-label={t("Close search")} title={t("Close search")} onClick={closeFind}><X size={16} aria-hidden="true" /></button>
          </div>
          <p className="find-bar-hint">{patch === null ? t("There is no loaded patch to search.") : t("Searches this loaded patch, including context. Content outside the patch is not searched.")}</p>
        </form>}
        <div className="repo-diff-panes">
          {columned && siblings !== null && siblings.length > 1 && <nav className="repo-diff-files" aria-label={t("Changed files")}>
            <ul ref={filesRef} onKeyDown={(event) => {
              // the column is one stop for Tab; Up and Down move between its files, Enter or a tap opens one
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              if (event.altKey || event.ctrlKey || event.metaKey) return;
              const buttons = [...(filesRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
              const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = buttons[Math.min(buttons.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))];
              if (next === undefined) return;
              event.preventDefault();
              next.focus();
            }}>
              {siblings.map((file) => {
                const parts = pathParts(file.path);
                const current = file.path === path;
                return <li key={file.path}>
                  <button type="button" className="repo-diff-pick" aria-current={current ? "page" : undefined} tabIndex={current || (fileIndex < 0 && file === siblings[0]) ? 0 : -1} title={file.old_path === null ? file.path : t("Renamed from {path}", { path: file.old_path })} onClick={() => { if (!current) onSwitchFile(file); }}>
                    <span className="repo-change-mark" data-status={file.status} aria-hidden="true">{STATUS_MARK[file.status]}</span>
                    <span className="visually-hidden">{statusWord(t, file.status)}</span>
                    <span className="repo-diff-pick-name">{parts.stem}{parts.extension}</span>
                    {parts.folder !== "" && <span className="repo-diff-pick-folder" dir="ltr">{parts.folder}</span>}
                    {file.binary === true
                      ? <span className="repo-diff-pick-counts">{t("Binary")}</span>
                      : file.additions !== null && file.deletions !== null && <span className="repo-diff-pick-counts">
                        <span className="repo-diff-added">+{file.additions.toLocaleString()}</span>
                        <span className="repo-diff-deleted">−{file.deletions.toLocaleString()}</span>
                      </span>}
                  </button>
                </li>;
              })}
            </ul>
          </nav>}
          <div className="repo-diff-body">{body}</div>
        </div>
      </section>
    </div>
  );
}
