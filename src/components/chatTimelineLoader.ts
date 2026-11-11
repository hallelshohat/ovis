import { useSyncExternalStore } from "react";

import type { ChatTimeline as ChatTimelineComponent } from "./ChatTimeline.tsx";

// The chat timeline (and @legendapp/list under it) is its own chunk, out of the entry. The import
// starts as soon as this module is evaluated, so it loads beside the app's first requests;
// ChatView reads a conversation into its state only once it resolves (`loadChatTimeline`), so a
// timeline is never asked for before it exists. ChatView keeps its placeholder until the first
// answer arrives, while the list initializes with ChatView's refs bound.
type Timeline = typeof ChatTimelineComponent;

let loaded: Timeline | null = null;
let pending: Promise<Timeline> | null = null;
const listeners = new Set<() => void>();

export function loadChatTimeline(): Promise<Timeline> {
  if (loaded !== null) return Promise.resolve(loaded);
  pending ??= import("./ChatTimeline.tsx").then((module) => {
    loaded = module.ChatTimeline;
    for (const listener of listeners) listener();
    return loaded;
  }, (cause: unknown) => {
    pending = null;
    throw cause;
  });
  return pending;
}

export function loadedChatTimeline(): Timeline | null {
  return loaded;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useChatTimeline(): Timeline | null {
  return useSyncExternalStore(subscribe, loadedChatTimeline, loadedChatTimeline);
}

loadChatTimeline().catch(() => undefined);
