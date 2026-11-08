import { match } from "ts-pattern";
import { z } from "zod";
import type { ConversationPart } from "../shared/protocol.ts";

/** Only terminal display items cross this boundary; model context and encrypted reasoning do not. */
export function codexNativeItem(value: unknown): { message: z.infer<typeof messageSchema> | null; display: { id: string; part: ConversationPart; processId?: string } | null } | null {
  const parsed = nativeItemSchema.safeParse(value);
  if (!parsed.success) return null;
  const item = parsed.data;
  if ("role" in item) return { message: item, display: null };
  return { message: null, display: displayPart(item) };
}

export function codexDisplayEvent(value: unknown): z.infer<typeof eventSchema> | null {
  const parsed = eventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function displayPart(item: z.infer<typeof displayItem>): { id: string; part: ConversationPart; processId?: string } {
  const part = match(item)
    .with({ type: "CommandExecution" }, (command): ConversationPart => {
      const cmd = command.command.length === 3 && /^-[a-z]*c$/.test(command.command[1]!) ? command.command[2]! : command.command.join(" ");
      const reads = command.parsed_cmd.filter((entry) => entry.type === "read");
      return { kind: "tool", native: true, call_id: command.id,
        name: reads.length > 0 && reads.length === command.parsed_cmd.length ? "read" : "exec_command",
        summary: reads.length > 0 && reads.length === command.parsed_cmd.length ? reads.map((read) => read.name ?? read.path ?? cmd).join(", ") : cmd,
        input: JSON.stringify({ command: cmd, cwd: command.cwd, ...(reads.length === 1 ? { path: reads[0]!.name ?? reads[0]!.path } : {}) }), output: command.aggregated_output ?? "",
        ...outcome(command.status), ...(command.exit_code == null ? {} : { exit_code: command.exit_code }) };
    })
    .with({ type: "FileChange" }, (edit): ConversationPart => ({ kind: "tool", native: true, call_id: edit.id,
      name: "apply_patch", summary: Object.keys(edit.changes).join(", "), input: filePatch(edit.changes),
      output: [edit.stdout, edit.stderr].filter(Boolean).join("\n"), ...outcome(edit.status) }))
    .with({ type: "Reasoning" }, (reasoning): ConversationPart => ({ kind: "thinking", native: true, text: reasoning.summary_text.join("\n\n") }))
    .exhaustive();
  return { id: item.id, part, ...(item.type === "CommandExecution" && item.process_id ? { processId: item.process_id } : {}) };
}

function outcome(status: z.infer<typeof statusSchema> | undefined): Pick<Extract<ConversationPart, { kind: "tool" }>, "state" | "error"> {
  return match(status)
    .with("in_progress", () => ({ state: "pending" as const }))
    .with("completed", () => ({ state: "ok" as const }))
    .with("failed", "declined", () => ({ state: "error" as const, error: true }))
    .with(undefined, () => ({}))
    .exhaustive();
}

function filePatch(changes: z.infer<typeof changesSchema>): string {
  const files = Object.entries(changes).map(([path, change]) => match(change)
    .with({ type: "update" }, (update) => `*** Update File: ${path}\n${update.move_path ? `*** Move to: ${update.move_path}\n` : ""}${update.unified_diff}`)
    .with({ type: "add" }, (add) => `*** Add File: ${path}\n${add.content.split("\n").map((line) => `+${line}`).join("\n")}`)
    .with({ type: "delete" }, (removed) => `*** Delete File: ${path}\n${removed.content.split("\n").map((line) => `-${line}`).join("\n")}`)
    .exhaustive());
  return `*** Begin Patch\n${files.join("\n")}\n*** End Patch`;
}

const statusSchema = z.enum(["in_progress", "completed", "failed", "declined"]);
const changesSchema = z.record(z.string(), z.discriminatedUnion("type", [
  z.object({ type: z.literal("update"), unified_diff: z.string(), move_path: z.string().nullable().optional() }),
  z.object({ type: z.literal("add"), content: z.string() }),
  z.object({ type: z.literal("delete"), content: z.string() }),
]));
const displayItem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("CommandExecution"), id: z.string().min(1), command: z.array(z.string()).min(1), cwd: z.string(),
    process_id: z.string().optional(),
    parsed_cmd: z.array(z.object({ type: z.string(), name: z.string().optional(), path: z.string().optional() })),
    status: statusSchema, aggregated_output: z.string().nullable().optional(), exit_code: z.number().int().nullable().optional() }),
  z.object({ type: z.literal("FileChange"), id: z.string().min(1), changes: changesSchema,
    status: statusSchema.optional(), stdout: z.string().optional(), stderr: z.string().optional() }),
  z.object({ type: z.literal("Reasoning"), id: z.string().min(1), summary_text: z.array(z.string()) }),
]);

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Plan"), text: z.string() })
    .transform((item) => ({ role: "assistant" as const, text: item.text, phase: "final_answer" as const })),
  z.object({ type: z.literal("UserMessage"), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) })
    .transform((item) => ({ role: "user" as const, text: item.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"), phase: undefined })),
  z.object({ type: z.literal("AgentMessage"), content: z.array(z.object({ type: z.literal("Text"), text: z.string() })), phase: z.enum(["commentary", "final_answer"]).nullable().optional() })
    .transform((item) => ({ role: "assistant" as const, text: item.content.map((part) => part.text).join("\n"), phase: item.phase ?? undefined })),
]);
const noticeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["warning", "guardian_warning", "error", "stream_error", "auth_recovery_started", "auth_recovery_completed"]), message: z.string().min(1) }),
  z.object({ type: z.literal("deprecation_notice"), summary: z.string(), details: z.string().nullable().optional() })
    .transform((notice) => ({ type: notice.type, message: [notice.summary, notice.details].filter(Boolean).join("\n") })),
]);
const planSchema = z.object({ type: z.literal("plan_update"), explanation: z.string().nullable().optional(),
  plan: z.array(z.object({ step: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })) });

const nativeItemSchema = z.union([messageSchema, displayItem]);
const eventSchema = z.union([
  noticeSchema.transform((notice): Extract<ConversationPart, { kind: "notice" }> => ({ kind: "notice", native: true, source: notice.type, text: notice.message })),
  planSchema.transform((plan): Extract<ConversationPart, { kind: "tool" }> => ({ kind: "tool", native: true, name: "update_plan", summary: "update_plan", input: JSON.stringify(plan), output: "", state: "ok" })),
]);
