import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeSubagents, forgetSubagents, taskNotification } from "./claude-subagents.ts";

// Every kind of background task a Claude Code session starts, as its transcript records it:
// a Bash call's `backgroundTaskId`, a Monitor's or a Workflow's `taskId`, and the
// `<task-notification>` that ends each (shapes taken from Claude Code 2.1.3xx transcripts).
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  forgetSubagents();
});

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const at = (minutes: number): string => new Date(NOW - 60 * 60 * 1000 + minutes * 60 * 1000).toISOString();
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

function session() {
  const root = mkdtempSync(join(tmpdir(), "ovis-bg-kinds-"));
  roots.push(root);
  const path = join(root, "p", "22222222-2222-4222-8222-222222222222.jsonl");
  mkdirSync(join(root, "p", "22222222-2222-4222-8222-222222222222", "subagents"), { recursive: true });
  writeFileSync(path, json({ type: "user", timestamp: at(0), message: { role: "user", content: "go" } }));
  const write = (entry: unknown) => appendFileSync(path, json(entry));
  return {
    path,
    /** a call of `tool` and its answer, whose `toolUseResult` is `result` */
    call(tool: string, id: string, minute: number, input: Record<string, unknown>, result: Record<string, unknown>) {
      write({ type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${id}`, name: tool, input }] } });
      write({ type: "user", timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${id}`, content: "started" }] }, toolUseResult: result });
    },
    notify(id: string, minute: number, status: string, summary: string) {
      write({ type: "queue-operation", operation: "enqueue", timestamp: at(minute), content: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<output-file>/tmp/x/tasks/${id}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` });
    },
    stop(id: string, minute: number) {
      write({ type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_stop_${id}`, name: "TaskStop", input: { task_id: id } }] } });
      write({ type: "user", timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_stop_${id}`, content: "stopped" }] }, toolUseResult: { task_id: id, task_type: "monitor" } });
    },
  };
}

const only = (path: string, live = true) => {
  const tasks = claudeSubagents(path, live, NOW);
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
};

describe("background task kinds", () => {
  it("lists a Monitor launch as running, then completed from its notice", () => {
    const s = session();
    s.call("Monitor", "bmon1", 1, { description: "CI finishes", command: "gh run watch 1", timeout_ms: 900000 }, { taskId: "bmon1", timeoutMs: 900000, persistent: false });
    expect(only(s.path)).toMatchObject({ id: "bmon1", kind: "monitor", category: "monitor", title: "CI finishes", command: "gh run watch 1", status: "running", detail_kind: "output", tool_use_id: "toolu_bmon1" });
    s.notify("bmon1", 3, "completed", 'Monitor "CI finishes" stream ended');
    expect(only(s.path)).toMatchObject({ status: "completed", exit_code: null, ended_at: at(3) });
  });

  it("lists a Workflow launch by its taskId", () => {
    const s = session();
    s.call("Workflow", "wf1", 1, { name: "review-changes", args: {} }, { taskId: "wf1" });
    expect(only(s.path)).toMatchObject({ id: "wf1", kind: "workflow", title: "review-changes", status: "running" });
  });

  it("does not take another tool's taskId for a launch", () => {
    const s = session();
    s.call("TaskCreate", "t1", 1, { subject: "x" }, { taskId: "t1" });
    expect(claudeSubagents(s.path, true, NOW)).toEqual([]);
  });

  it("gives a failed background command the exit code its notice names", () => {
    const s = session();
    s.call("Bash", "bsh1", 1, { command: "bun test", description: "Run tests", run_in_background: true }, { stdout: "", stderr: "", backgroundTaskId: "bsh1" });
    expect(only(s.path)).toMatchObject({ kind: "command", category: "shell", command: "bun test", title: "Run tests", status: "running", exit_code: null });
    s.notify("bsh1", 4, "failed", 'Background command "Run tests" failed with exit code 2');
    expect(only(s.path)).toMatchObject({ status: "failed", exit_code: 2 });
  });

  it("marks a monitor TaskStop stopped as cancelled", () => {
    const s = session();
    s.call("Monitor", "bmon2", 1, { description: "logs", command: "tail -f x" }, { taskId: "bmon2" });
    s.stop("bmon2", 2);
    expect(only(s.path)).toMatchObject({ status: "cancelled", ended_at: at(2) });
  });

  it("leaves a running monitor lost once the pane no longer runs the session", () => {
    const s = session();
    s.call("Monitor", "bmon3", 1, { description: "logs", command: "tail -f x" }, { taskId: "bmon3" });
    expect(only(s.path, false).status).toBe("lost");
  });

  it("reads each notice's kind and exit code", () => {
    const block = (summary: string) => `<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`;
    expect(taskNotification(block('Background command "x" completed (exit code 0)'))).toMatchObject({ kind: "command", exitCode: 0, agent: false });
    expect(taskNotification(block('Monitor "x" stream ended'))).toMatchObject({ kind: "monitor", exitCode: null });
    expect(taskNotification(block('Workflow "x" completed'))).toMatchObject({ kind: "workflow" });
    expect(taskNotification(block('Agent "x" finished'))).toMatchObject({ kind: "subagent", agent: true });
  });
});
