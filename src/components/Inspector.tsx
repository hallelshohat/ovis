import "./Inspector.css";

import { X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useT } from "../lib/i18n.ts";

export interface InspectorProps {
  /** the column's name, said by its head and to assistive tech */
  title: string;
  id?: string;
  children: ReactNode;
  onClose(): void;
}

/**
 * The workbench's column beside the work panel (DESIGN.md: Inspector): what the selected pane is
 * about, here its pull requests. Escape inside it closes it; it never takes the focus on its own.
 */
export function Inspector({ title, id, children, onClose }: InspectorProps) {
  const t = useT();
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };
  return (
    <aside id={id} className="inspector" role="complementary" aria-label={title} onKeyDown={onKeyDown}>
      <header className="inspector-head">
        <h2 className="inspector-title section-label">{title}</h2>
        <button type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      <div className="inspector-body">{children}</div>
    </aside>
  );
}
