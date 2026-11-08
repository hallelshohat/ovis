import { stripVTControlCharacters } from "node:util";
import type { CodexDisplay } from "../shared/protocol.ts";
import { codexComposer } from "./codex-steering.ts";
import { findLastIndex } from "./dialogs/shared.ts";

/** Ephemeral terminal state, read beside the prompt; it never authorizes input or an interrupt. */
export function readCodexDisplay({ screen }: { screen: string }): CodexDisplay | null {
  const live = codexComposer(screen);
  if (!live) {
    const warnings = warningScreen(screen);
    return warnings === null ? null : { status_lines: [warnings], pending_inputs: [] };
  }
  const { rows, composer, status, footer } = live;
  const panel = status < 0 ? [] : rows.slice(status + 1, composer);
  const command = panel.filter((row) => row.text.startsWith("└")).map((row) => row.text);
  return { status_lines: [...screenNotices(screen), ...(status < 0 ? [] : [rows[status]!.text, ...command]), ...footer], pending_inputs: pendingInputs(panel) };
}

function warningScreen(screen: string): string | null {
  const lines = stripVTControlCharacters(screen).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.at(-1) !== "k keep & next · esc dismiss & close · ⌃o copy · ←/→ warning") return null;
  const header = findLastIndex(lines, (line) => /^Warnings · \d+ of \d+ · .+$/.test(line));
  return header < 0 ? null : lines.slice(header, -1).join("\n");
}

function pendingInputs(panel: NonNullable<ReturnType<typeof codexComposer>>["rows"]): CodexDisplay["pending_inputs"] {
  const pending_inputs: CodexDisplay["pending_inputs"] = [];
  let kind: "steering" | "queued" | null = null;
  let header = "";
  let indent = -1;
  for (const row of panel) {
    if (/^(?:⇧←|Alt\+Up|alt\+up).*edit last queued message$/.test(row.text)) continue;
    if (/^[•◦]/.test(row.text) && (indent < 0 || row.indent < indent)) { header = row.text.replace(/^[•◦]\s*/, ""); kind = null; indent = -1; continue; }
    if (indent < 0 && !row.text.startsWith("↳")) { header += ` ${row.text}`; continue; }
    if (indent < 0) {
      const title = header.replace(/\s/g, "");
      if (title === "Messagestobesubmittedafternexttoolcall(pressesctointerruptandsendimmediately)") kind = "steering";
      if (title === "Messagestobesubmittedatendofturn" || title === "Queuedfollow-upinputs") kind = "queued";
    }
    if (kind === null) continue;
    if (row.text.startsWith("↳") && (indent < 0 || row.indent === indent)) {
      indent = row.indent;
      pending_inputs.push({ text: row.text.replace(/^↳\s*/, ""), kind });
    } else {
      const last = pending_inputs.at(-1);
      if (!last) continue;
      if (row.text === "…") last.truncated = true;
      else last.text += `\n${row.text}`;
    }
  }
  return pending_inputs;
}

function screenNotices(screen: string): string[] {
  const lines = stripVTControlCharacters(screen).split(/\r?\n/);
  const welcome = findLastIndex(lines, (line) => />_ OpenAI Codex \(v[\d.]+\)/.test(line));
  if (welcome < 0) return [];
  const before = lines.slice(0, welcome).filter((line) => line.trim());
  if (before.at(-1)?.trim() === "/status") {
    const composer = findLastIndex(lines, (line) => /^\s*[›»](?:\s+Ask Codex to do anything)?\s*$/.test(line));
    const body = lines.slice(welcome, composer);
    if (composer > welcome && body.some((line) => /^\s*Model:/.test(line)) && !body.some((line) => /^\s*[›»•◦]/.test(line))) return [body.map((line) => line.trim()).join("\n").trim()];
  }
  const prefix = lines.slice(0, welcome);
  const update = findLastIndex(prefix, (line) => /✨\s*Update available!/.test(line));
  const warning = findLastIndex(prefix, (line) => /^WARNING:/.test(line));
  const notices: string[] = [];
  if (warning >= 0) {
    const end = prefix.findIndex((line, index) => index > warning && !line.trim());
    notices.push(prefix.slice(warning, end < 0 ? welcome : end).join("\n"));
  }
  if (update >= 0) {
    const end = prefix.findIndex((line, index) => index > update && /^[\s]*╰/.test(line));
    notices.push(prefix.slice(update, end < 0 ? welcome : end).map((line) => line.trim().replace(/^│\s*|\s*│$/g, "")).join("\n").trim());
  }
  return notices;
}
