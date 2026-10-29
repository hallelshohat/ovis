/**
 * A list that reorders moves its rows to their new places instead of jumping them there (FLIP): each
 * row's top is kept after a render, and a row found somewhere else after the next one is played from
 * its old place to its new one. Nothing moves under reduced motion, and the rows take input throughout.
 */
import { useLayoutEffect, useRef, type RefObject } from "react";

export const FLIP_MS = 180;

/** How far each row that stayed in the list moved: old top minus new top, for the rows that moved. */
export function flipDeltas(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): Map<string, number> {
  const moved = new Map<string, number>();
  for (const [key, top] of after) {
    const was = before.get(key);
    if (was !== undefined && Math.abs(was - top) >= 1) moved.set(key, was - top);
  }
  return moved;
}

/** Plays every reorder of the `[attr]` rows inside `container`, after each render. */
export function useFlip(container: RefObject<HTMLElement | null>, attr: string): void {
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const root = container.current;
    // a renderer with no layout (a test's) has nothing to move
    if (!root || typeof root.querySelectorAll !== "function") return;
    const rows = new Map<string, HTMLElement>();
    const after = new Map<string, number>();
    for (const row of root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
      const key = row.getAttribute(attr)!;
      rows.set(key, row);
      after.set(key, row.getBoundingClientRect().top - root.getBoundingClientRect().top);
    }
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced && typeof Element.prototype.animate === "function") {
      for (const [key, delta] of flipDeltas(tops.current, after)) {
        rows.get(key)!.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], { duration: FLIP_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" });
      }
    }
    tops.current = after;
  });
}
