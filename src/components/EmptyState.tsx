import "./EmptyState.css";

import type { LucideIcon } from "lucide-react";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  detail?: string;
  action?: { label: string; onClick(): void };
  /** a failure is said at once (alert); an empty place is a status */
  role?: "status" | "alert";
  /** the place's own name for it, which its tests and its layout keep */
  className?: string;
}

/** One empty or unavailable place, said once (DESIGN.md §1, Messages): a glyph, one sentence, and the one control that does something about it. */
export function EmptyState({ icon: Icon, title, detail, action, role = "status", className }: EmptyStateProps) {
  return (
    <div className={className ? `empty-state ${className}` : "empty-state"} role={role}>
      <span className="empty-state-icon" aria-hidden="true"><Icon /></span>
      <p className="empty-state-title">{title}</p>
      {detail && <p className="empty-state-detail">{detail}</p>}
      {action && <button type="button" className="btn" onClick={action.onClick}>{action.label}</button>}
    </div>
  );
}
