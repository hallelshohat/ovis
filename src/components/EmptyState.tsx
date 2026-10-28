import "./EmptyState.css";

import type { LucideIcon } from "lucide-react";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  detail?: string;
  action?: { label: string; onClick(): void };
}

/** One empty or unavailable place, said once (DESIGN.md §1, Messages): a glyph, one sentence, and the one control that does something about it. */
export function EmptyState({ icon: Icon, title, detail, action }: EmptyStateProps) {
  return (
    <div className="empty-state" role="status">
      <span className="empty-state-icon" aria-hidden="true"><Icon /></span>
      <p className="empty-state-title">{title}</p>
      {detail && <p className="empty-state-detail">{detail}</p>}
      {action && <button type="button" className="btn" onClick={action.onClick}>{action.label}</button>}
    </div>
  );
}
