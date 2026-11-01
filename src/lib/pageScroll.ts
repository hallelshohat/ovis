import type { ShortcutEventLike } from "./shortcuts.ts";

export function plainPageDirection(event: ShortcutEventLike): -1 | 1 | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing || event.keyCode === 229) return null;
  return event.key === "PageUp" ? -1 : event.key === "PageDown" ? 1 : null;
}

/**
 * A focused element outside the chat that scrolls on its own (a PR card's checks list, a detail
 * region): its page keys are its own, so the chat leaves them to the browser.
 */
export function ownsPageKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || target.closest(".chat-view") !== null) return false;
  return target.scrollHeight > target.clientHeight && /^(auto|scroll)$/.test(getComputedStyle(target).overflowY);
}

export const PAGE_OVERLAP_ROWS = 1;

export function pageScrollDistance(viewport: number, lineHeight: number, overlapRows: number): number {
  return Math.max(1, viewport - lineHeight * overlapRows);
}
