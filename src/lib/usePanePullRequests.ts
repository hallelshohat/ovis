/**
 * A pane's pull requests, shared by everything that shows them (its sidebar rows, the composer
 * strip, the header, the inspector): one request per PC and pane however many ask, read again every
 * PR_POLL_MS while the page is seen and online, and fresh once a chat has been quiet for
 * TURN_SETTLE_MS after its transcript changed (a turn ended, a push went out).
 */
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { PanePullRequests } from "../../shared/pull-requests.ts";
import { fetchPullRequests } from "./api.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

export const PR_POLL_MS = 60_000;

/** Whether this tree asks for pull requests: the app does (App.tsx); a surface drawn alone (a test's fixture) does not. */
export const PullRequestsContext = createContext(false);
export const TURN_SETTLE_MS = 10_000;

interface Entry {
  data: PanePullRequests | null;
  users: number;
  timer: ReturnType<typeof setTimeout> | null;
  settle: ReturnType<typeof setTimeout> | null;
  pending: Promise<void> | null;
  listeners: Set<() => void>;
  /** the reads asked for, numbered, and the newest one whose answer is shown: an older answer landing late is dropped */
  issued: number;
  shown: number;
}

const entries = new Map<string, Entry>();
const keyOf = (machineId: string, paneId: string) => `${machineId}\0${paneId}`;

/** When the next read is due: a hidden page or one offline waits for the person to come back. */
export function nextDelay(visible: boolean, online: boolean): number | null {
  return visible && online ? PR_POLL_MS : null;
}

const seen = (): boolean => typeof document === "undefined" || document.visibilityState === "visible";
const online = (): boolean => typeof navigator === "undefined" || navigator.onLine !== false;

function entry(key: string): Entry {
  let found = entries.get(key);
  if (!found) {
    found = { data: null, users: 0, timer: null, settle: null, pending: null, listeners: new Set(), issued: 0, shown: 0 };
    entries.set(key, found);
  }
  return found;
}

let fetcher = fetchPullRequests;

/** Tests answer the reads themselves; returns the restore. */
export function setPullRequestFetcher(next: typeof fetchPullRequests): () => void {
  const previous = fetcher;
  fetcher = next;
  return () => { fetcher = previous; };
}

/** What a pane's reads last showed (tests). */
export function shownPullRequests(machineId: string, paneId: string): PanePullRequests | null {
  return entries.get(keyOf(machineId, paneId))?.data ?? null;
}

/** One read of a pane's PRs; a fresh one does not wait for a read already under way, and whichever was asked last wins. */
export function readPullRequests(machineId: string, paneId: string, fresh: boolean): Promise<void> {
  const key = keyOf(machineId, paneId);
  const own = entry(key);
  if (own.pending && !fresh) return own.pending;
  const number = ++own.issued;
  const pending = fetcher(paneId, fresh, machineId).then((data) => {
    // a slower read asked before the one shown says older news: it is dropped
    if (number < own.shown) return;
    own.shown = number;
    own.data = data;
  }, () => {
    // an older PC (no such route) or one away: nothing to show, and nothing said about it
  }).finally(() => {
    if (own.pending === pending) own.pending = null;
    for (const listener of own.listeners) listener();
    schedule(machineId, paneId);
  });
  own.pending = pending;
  return pending;
}

function schedule(machineId: string, paneId: string): void {
  const own = entry(keyOf(machineId, paneId));
  if (own.timer) clearTimeout(own.timer);
  own.timer = null;
  if (own.users === 0) return;
  const delay = nextDelay(seen(), online()) ?? PR_POLL_MS;
  own.timer = setTimeout(() => {
    if (nextDelay(seen(), online()) === null) schedule(machineId, paneId);
    else void readPullRequests(machineId, paneId, false);
  }, delay);
}

/** The chat's transcript changed: read again, fresh, once it has been quiet for TURN_SETTLE_MS. */
export function pullRequestsChanged(machineId: string, paneId: string): void {
  const own = entries.get(keyOf(machineId, paneId));
  if (!own || own.users === 0) return;
  if (own.settle) clearTimeout(own.settle);
  own.settle = setTimeout(() => { own.settle = null; void readPullRequests(machineId, paneId, true); }, TURN_SETTLE_MS);
}

/** Read again now, fresh (after a merge, or when the person asks). */
export function refreshPullRequests(machineId: string, paneId: string): Promise<void> {
  return readPullRequests(machineId, paneId, true);
}

export function usePanePullRequests(machineId: string | null, paneId: string | null): PanePullRequests | null {
  return usePullRequestData(machineId, paneId, useContext(PullRequestsContext));
}

function usePullRequestData(machineId: string | null, paneId: string | null, enabled: boolean): PanePullRequests | null {
  const key = enabled && machineId !== null && paneId !== null ? keyOf(machineId, paneId) : null;
  useEffect(() => {
    if (key === null) return;
    const own = entry(key);
    own.users += 1;
    if (own.data === null && !own.pending) void readPullRequests(machineId!, paneId!, false);
    else if (!own.timer) schedule(machineId!, paneId!);
    return () => {
      own.users -= 1;
      if (own.users > 0) return;
      if (own.timer) clearTimeout(own.timer);
      if (own.settle) clearTimeout(own.settle);
      own.timer = own.settle = null;
    };
  }, [key, machineId, paneId]);
  return useSyncExternalStore(
    (listener) => {
      if (key === null) return () => {};
      const own = entry(key);
      own.listeners.add(listener);
      return () => own.listeners.delete(listener);
    },
    () => (key === null ? null : entries.get(key)?.data ?? null),
    () => null,
  );
}

/**
 * The selected pane's pull requests and where they show: an inspector column beside the pane from
 * 1200px, which the person can hide, or a sheet the header opens below that.
 */
/**
 * `columnTaken`: a file or a page is docked beside the pane, in the column the inspector would use;
 * then the PRs open as a sheet, as on a narrow window, and the file stays where it is.
 */
export function usePullRequestInspector(machineId: string, paneId: string | null, columnTaken: boolean) {
  // App holds the provider it would ask, so it asks for itself
  const pullRequests = usePullRequestData(machineId, paneId, true);
  const docked = useMediaQuery("(min-width: 1200px)") && !columnTaken;
  const [panelOpen, setPanelOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  // PRs to show, or links the chat wrote that gh cannot read: then the inspector says why
  const shown = (pullRequests?.pull_requests.length ?? 0) > 0 || (pullRequests !== null && pullRequests.gh !== "ok" && pullRequests.linked > 0);
  const toggle = (): void => { if (docked) setPanelOpen((open) => !open); else setSheetOpen(true); };
  return { pullRequests, docked, shown, panelOpen, setPanelOpen, sheetOpen, setSheetOpen, toggle, expanded: docked ? panelOpen && shown : sheetOpen };
}
