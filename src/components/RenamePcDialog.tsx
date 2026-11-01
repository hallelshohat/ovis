/**
 * Rename a remote PC, from its header's right-click menu in the sidebar. The name field takes the
 * focus with the old name selected; Enter saves, Escape and the scrim cancel. The rename runs here,
 * so a refusal (herdr's, or the server's own checks) shows in the dialog and the name stays to fix.
 * A PC saved in herdr is renamed in herdr (herdr machine rename): the server says so by doing it.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import "./ConfirmDialog.css";

import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";

/** the server's bound on a PC's name (server/machines.ts pcName) */
export const PC_NAME_MAX = 100;

interface Props {
  name: string;
  /** a PC saved in herdr: herdr keeps its name, and the dialog says the rename reaches herdr */
  herdr: boolean;
  /** resolves once the PC is renamed; the owner then takes the dialog down */
  onRename: (name: string) => Promise<void>;
  onClose: () => void;
}

export function RenamePcDialog({ name, herdr, onRename, onClose }: Props) {
  const t = useT();
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: field });
  useSheetSwipe(surface, pending ? null : onClose);
  usePhoneSheetBack(() => { if (pending) return false; onClose(); });
  // the old name is selected, so typing replaces it
  useEffect(() => { field.current?.select(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      if (!pending) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pending]);

  const next = value.trim();
  const unchanged = next === name.trim();
  const submit = async (): Promise<void> => {
    if (pending || next === "") return;
    if (unchanged) { onClose(); return; }
    setPending(true);
    setError(null);
    try { await onRename(next); }
    catch (reason: unknown) {
      setError(reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason));
      setPending(false);
      field.current?.focus();
    }
  };

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
      <div ref={surface} className="modal confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{t("Rename PC")}</h2></header>
          <div className="modal-body">
            <label className="field">
              <span className="field-label">{t("PC name")}</span>
              <input ref={field} className="input" value={value} maxLength={PC_NAME_MAX} disabled={pending} autoComplete="off" spellCheck={false}
                aria-invalid={error !== null || undefined} aria-describedby={herdr ? `${id}-hint` : undefined} onChange={(event) => { setValue(event.target.value); setError(null); }} />
            </label>
            {herdr && <p className="field-hint" id={`${id}-hint`}>{t("Saved in herdr: herdr gets the new name too.")}</p>}
            {error && <p className="confirm-error" role="alert">{error}</p>}
          </div>
          <footer className="modal-footer">
            <button type="button" className="btn" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
            <button type="submit" className="btn btn-primary" disabled={pending || next === ""} aria-busy={pending || undefined}>{t("Rename")}</button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}
