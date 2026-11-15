import { z } from "zod";
import { codexOutputText } from "./codex.ts";
import type { CommandTranscript } from "./conversation.ts";

export type CodexDeliveryAnchor = CommandTranscript;

/** Only a new canonical user record proves acceptance; event echoes can repeat an earlier send. */
export function codexDeliveryAccepted({ anchor, current, text }: {
  anchor: CodexDeliveryAnchor | null; current: CommandTranscript | null; text: string;
}): boolean {
  if (!anchor || !current || current.identity !== anchor.identity || current.end <= anchor.end) return false;
  const sent = text.replace(/\r\n?/g, "\n").trim();
  return sent.length > 0 && current.records.some(({ offset, entry }) => {
    if (offset < anchor.end) return false;
    const parsed = canonicalUser.safeParse(entry);
    return parsed.success && codexOutputText(parsed.data.payload.content).replace(/\r\n?/g, "\n").trim() === sent;
  });
}

// Receipt evidence keeps literal user text, including envelopes hidden or rewritten in chat.
const canonicalUser = z.object({ type: z.literal("response_item"), payload: z.object({
  type: z.literal("message"), role: z.literal("user"),
  content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]),
}) });
