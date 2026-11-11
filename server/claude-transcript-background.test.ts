import { describe, expect, it } from "bun:test";

import type { ConversationPart } from "../shared/protocol.ts";
import { createClaudeTranscriptParser } from "./claude-transcript.ts";

// A call that starts a background task, its immediate answer, then the `<task-notification>` that
// ends the task, as Claude Code 2.1.3xx writes them.
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;
const call = (id: string, name: string, input: Record<string, unknown>, at = "2026-11-02T10:00:00.000Z") =>
  json({ type: "assistant", timestamp: at, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] } });
const answer = (id: string, result: Record<string, unknown>, at = "2026-11-02T10:00:01.000Z") =>
  json({ type: "user", timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "started" }] }, toolUseResult: result });
const notify = (task: string, toolUse: string, status: string, summary: string) =>
  json({ type: "queue-operation", operation: "enqueue", timestamp: "2026-11-02T10:05:00.000Z", content: `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${toolUse}</tool-use-id>\n<output-file>/tmp/t/tasks/${task}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` });

const prompt = json({ type: "user", timestamp: "2026-11-02T09:59:59.000Z", origin: { kind: "human" }, message: { role: "user", content: "go" } });

function parse(text: string) {
  const parser = createClaudeTranscriptParser();
  parser.write(text);
  const turns = parser.snapshot();
  const tools = turns.flatMap((turn) => turn.parts).filter((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool");
  const notices = turns.flatMap((turn) => turn.parts).filter((part): part is Extract<ConversationPart, { kind: "notice" }> => part.kind === "notice");
  return { tools, notices };
}

describe("a chat card's background task", () => {
  it("links a run_in_background Bash card to its task, running until its notice", () => {
    const started = prompt + call("toolu_1", "Bash", { command: "bun test", run_in_background: true }) + answer("toolu_1", { stdout: "", backgroundTaskId: "bk1" });
    expect(parse(started).tools[0]!.background).toEqual({ task_id: "bk1", kind: "command" });
    const ended = parse(started + notify("bk1", "toolu_1", "failed", 'Background command "bun test" failed with exit code 3'));
    expect(ended.tools[0]!.background).toEqual({ task_id: "bk1", kind: "command", status: "failed", exit_code: 3 });
    expect(ended.notices).toEqual([{ kind: "notice", text: 'Background command "bun test" failed with exit code 3', source: "task-notification" }]);
  });

  it("links a Monitor and a Workflow card by taskId", () => {
    const { tools } = parse(prompt
      + call("toolu_m", "Monitor", { description: "logs", command: "tail -f x" }) + answer("toolu_m", { taskId: "bm1", timeoutMs: 900000 })
      + call("toolu_w", "Workflow", { name: "review" }) + answer("toolu_w", { taskId: "wf1" }));
    expect(tools.map((tool) => tool.background)).toEqual([{ task_id: "bm1", kind: "monitor" }, { task_id: "wf1", kind: "workflow" }]);
  });

  it("links a background Agent card to its subagent, settled by its notice", () => {
    const text = prompt + call("toolu_a", "Agent", { description: "Review", prompt: "x", run_in_background: true }) + answer("toolu_a", { isAsync: true, status: "async_launched", agentId: "a123" })
      + notify("a123", "toolu_a", "completed", 'Agent "Review" finished');
    expect(parse(text).tools[0]!.background).toEqual({ task_id: "a123", kind: "subagent", status: "completed" });
  });

  it("starts no task from another tool's taskId or a failed call", () => {
    const text = prompt + call("toolu_t", "TaskCreate", { subject: "x" }) + answer("toolu_t", { taskId: "t1" })
      + call("toolu_b", "Bash", { command: "x" }) + json({ type: "user", timestamp: "2026-11-02T10:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_b", content: "no", is_error: true }] }, toolUseResult: { backgroundTaskId: "bk9" } });
    expect(parse(text).tools.map((tool) => tool.background)).toEqual([undefined, undefined]);
  });
});
