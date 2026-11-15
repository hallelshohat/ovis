import "./StatusTip.css";
import { useEffect, useRef } from "react";

/**
 * A status said in words under the element that holds it (a pull request badge): its first line
 * the word, then any detail lines. It is a popover in the top layer, so a clipping sidebar or the
 * palette above never hides it, and it wires itself: hovering its parent shows it, and so does
 * keyboard focus on the nearest focusable element around it (the badge link, or the row a badge
 * sits in when the badge holds no control of its own); Escape hides it. Assistive tech gets the
 * same words from the badge's own label, so the tip itself is hidden from it.
 */
export function StatusTip({ word, detail = [] }: { word: string; detail?: readonly (string | null | undefined)[] }) {
  const tip = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const popover = tip.current;
    const anchor = popover?.parentElement;
    if (!popover?.showPopover || !anchor) return;
    const focusable = anchor.closest<HTMLElement>("a[href], button, [tabindex]");
    const show = (): void => {
      const box = anchor.getBoundingClientRect();
      popover.style.top = `${box.bottom + 4}px`;
      popover.style.left = `${box.left}px`;
      if (!popover.matches(":popover-open")) popover.showPopover();
      // kept 16px inside the window's right edge once its width is known
      popover.style.left = `${Math.max(16, Math.min(box.left, window.innerWidth - 16 - popover.offsetWidth))}px`;
    };
    const hide = (): void => { if (popover.matches(":popover-open")) popover.hidePopover(); };
    const focus = (): void => { if (focusable?.matches(":focus-visible")) show(); };
    const key = (event: KeyboardEvent): void => { if (event.key === "Escape") hide(); };
    anchor.addEventListener("pointerenter", show);
    anchor.addEventListener("pointerleave", hide);
    focusable?.addEventListener("focus", focus);
    focusable?.addEventListener("blur", hide);
    focusable?.addEventListener("keydown", key);
    return () => {
      hide();
      anchor.removeEventListener("pointerenter", show);
      anchor.removeEventListener("pointerleave", hide);
      focusable?.removeEventListener("focus", focus);
      focusable?.removeEventListener("blur", hide);
      focusable?.removeEventListener("keydown", key);
    };
  }, []);
  return (
    <span ref={tip} className="status-tip" popover="manual" aria-hidden="true">
      <strong>{word}</strong>
      {detail.filter(Boolean).map((line) => <span key={line}>{line}</span>)}
    </span>
  );
}
