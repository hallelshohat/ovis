import { parseCodexTranscript } from "./codex.ts";
import type { CommandTranscript } from "./conversation.ts";

export type CodexDeliveryAnchor = Pick<CommandTranscript, "identity" | "end">;

/** Only a new canonical user record proves acceptance; event echoes can repeat an earlier send. */
export function codexDeliveryAccepted({ anchor, current, text }: {
  anchor: CodexDeliveryAnchor | null; current: CommandTranscript | null; text: string;
}): boolean {
  if (!anchor || !current || current.identity !== anchor.identity || current.end <= anchor.end) return false;
  const appended = current.records.filter(({ offset, entry }) => offset >= anchor.end && entry.type === "response_item");
  const turns = parseCodexTranscript(appended.map(({ entry }) => JSON.stringify(entry)).join("\n"), Infinity);
  const sent = text.replace(/\r\n?/g, "\n").trim();
  return sent.length > 0 && turns.some((turn) => turn.role === "user"
    && turn.parts.filter((part) => part.kind === "text").map((part) => part.text).join("\n").replace(/\r\n?/g, "\n").trim() === sent);
}
