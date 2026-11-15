import { z } from "zod";
import { match } from "ts-pattern";
import type { ConversationPart } from "../../shared/protocol.ts";
import { codexNativeItem } from "../codex-items.ts";
import { piMessage, piResults, resultText } from "../transcript-records.ts";

type Tool = Extract<ConversationPart, { kind: "tool" }>;
export type CreationCalls = Map<string, Pick<Tool, "name" | "input">>;

/** A command's own successful result, never a link in a prompt, search or quoted example. */
export function createdPrUrls({ part }: { part: Tool }): string[] {
  if (!isCreation(part) || part.error || part.state === "error" || part.state === "pending") return [];
  const header = /^(?:Process exited with code|Exit code:) (\d+)\r?$/m.exec(part.output);
  const exit = part.exit_code ?? (header ? Number(header[1]) : undefined);
  if (exit !== undefined ? exit !== 0 : part.state !== "ok") return [];
  const urls = part.output.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*/g) ?? [];
  return urls.length === 1 && part.output.split(/\r?\n/).some((line) => line.trim() === urls[0]) ? urls : [];
}

/** Raw providers pair their calls/results by ID; native Codex already pairs them in one item. */
export function creationRecordUrls({ value, calls }: { value: unknown; calls: CreationCalls }): string[] {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return [];
  return match(parsed.data)
    .with({ type: "event_msg" }, ({ payload }) => {
      const part = codexNativeItem(payload.item)?.display?.part;
      return part?.kind === "tool" ? createdPrUrls({ part }) : [];
    })
    .with({ type: "response_item" }, ({ payload }) => match(payload)
      .with({ type: "function_call" }, (call) => {
        remember({ calls, id: call.call_id, name: call.name, input: call.arguments });
        return [];
      })
      .with({ type: "function_call_output" }, (answer) => result({ calls, id: answer.call_id, output: resultText(answer.output) }))
      .exhaustive())
    .with({ type: "assistant" }, { type: "user" }, { type: "message" }, (entry) => messageUrls({ entry, calls }))
    .exhaustive();
}

function messageUrls({ entry, calls }: { entry: { type: "assistant" | "user" | "message"; message: unknown }; calls: CreationCalls }): string[] {
  const pi = piMessage(entry);
  const message = messageSchema.safeParse(pi ?? entry.message);
  if (!message.success) return [];
  const urls: string[] = [];
  for (const block of message.data.content) {
    const call = callSchema.safeParse(block);
    if (message.data.role === "assistant" && call.success) {
      remember({ calls, id: call.data.id, name: call.data.name, input: JSON.stringify(call.data.input) });
    }
    const answer = resultSchema.safeParse(block);
    if (entry.type === "user" && answer.success) urls.push(...result({ calls, id: answer.data.tool_use_id, output: resultText(answer.data.content), error: answer.data.is_error, state: "ok" }));
  }
  if (pi) for (const answer of piResults(pi)) urls.push(...result({ calls, id: answer.id, output: answer.text, error: answer.error, state: "ok" }));
  return urls;
}

const shellTools = new Set(["Bash", "bash", "exec_command", "shell_command", "shell", "terminal"]);
const inputSchema = z.object({ command: z.string().optional(), cmd: z.string().optional() });
function isCreation({ name, input }: Pick<Tool, "name" | "input">): boolean {
  if (!shellTools.has(name)) return false;
  let raw: unknown;
  try { raw = JSON.parse(input); } catch { return false; }
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return false;
  const command = (parsed.data.command ?? parsed.data.cmd ?? "").replace(/\n\s*#[^\n]*/g, "").trim();
  // Only a literal single command proves creation; compound scripts still use exact-head discovery.
  return /^gh\s+pr\s+create(?:\s|$)/.test(command) && !/[\n\r;&|<>`$]/.test(command)
    && !/(?:^|\s)(?:--help|-h|--dry-run)(?:\s|$)/.test(command);
}

function remember({ calls, id, name, input }: { calls: CreationCalls; id: string; name: string; input: string }): void {
  calls.delete(id);
  if (isCreation({ name, input })) calls.set(id, { name, input });
}

function result({ calls, id, output, error, state }: { calls: CreationCalls; id: string; output: string; error?: boolean; state?: "ok" }): string[] {
  const call = calls.get(id);
  if (!call) return [];
  calls.delete(id);
  return createdPrUrls({ part: { kind: "tool", summary: "", ...call, output, error, state } });
}

const nativeSchema = z.object({ type: z.literal("item_completed"), item: z.unknown() });
const codexSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("function_call"), call_id: z.string(), name: z.string(), arguments: z.string() }),
  z.object({ type: z.literal("function_call_output"), call_id: z.string(), output: z.unknown() }),
]);
const messageSchema = z.object({ role: z.string(), content: z.array(z.unknown()) });
const callSchema = z.union([
  z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("toolCall"), id: z.string(), name: z.string(), arguments: z.unknown() }).transform(({ id, name, arguments: input }) => ({ id, name, input })),
]);
const resultSchema = z.object({ type: z.literal("tool_result"), tool_use_id: z.string(), content: z.unknown(), is_error: z.boolean().optional() });

const envelopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event_msg"), payload: nativeSchema }),
  z.object({ type: z.literal("response_item"), payload: codexSchema }),
  z.object({ type: z.enum(["assistant", "user", "message"]), message: z.unknown() }),
]);
