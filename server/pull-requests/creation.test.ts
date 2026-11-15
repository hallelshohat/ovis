import { describe, expect, it } from "bun:test";
import { createdPrUrls, creationRecordUrls, type CreationCalls } from "./creation.ts";

const url = "https://github.com/acme/api/pull/3";
const part = { kind: "tool", name: "Bash", summary: "Create PR", input: JSON.stringify({ command: "gh pr create --title 'Fix it' --body-file body.md" }), output: `${url}\n`, state: "ok" } as const;

describe("PR creation evidence", () => {
  it("accepts a successful create and normalizes its one result URL", () => {
    expect(createdPrUrls({ part })).toEqual([url]);
    expect(createdPrUrls({ part: { ...part, name: "exec_command", input: JSON.stringify({ cmd: "gh pr create --fill\n# execution stamp" }), output: `Process exited with code 0\nFinal output:\n${url}\n`, state: undefined } })).toEqual([url]);
  });

  it("does not mistake commands, examples or other output for creation", () => {
    for (const command of ["gh pr list --state open", "gh pr view 3", "gh api repos/actions/runner/releases/latest", "echo 'gh pr create'", "cat example.md", "gh pr create --help", "gh pr create --dry-run", "false && gh pr create", "gh pr create; gh pr list", "printf 'example\\ngh pr create'"]) {
      expect(createdPrUrls({ part: { ...part, input: JSON.stringify({ command }) } })).toEqual([]);
    }
    expect(createdPrUrls({ part: { ...part, name: "Read" } })).toEqual([]);
    expect(createdPrUrls({ part: { ...part, output: `A pull request already exists: ${url}` } })).toEqual([]);
    expect(createdPrUrls({ part: { ...part, output: `${url}\nhttps://github.com/acme/api/pull/4` } })).toEqual([]);
  });

  it("requires a completed successful result, not a failed or pending call", () => {
    expect(createdPrUrls({ part: { ...part, error: true } })).toEqual([]);
    expect(createdPrUrls({ part: { ...part, state: "pending" } })).toEqual([]);
    expect(createdPrUrls({ part: { ...part, exit_code: 1 } })).toEqual([]);
    expect(createdPrUrls({ part: { ...part, state: undefined } })).toEqual([]);
    expect(createdPrUrls({ part: { ...part, state: undefined, output: `Process exited with code 1\n${url}` } })).toEqual([]);
  });

  it.each(["claude", "codex", "pi"])("pairs %s calls with their own results, ignoring other tools", (provider) => {
    const calls: CreationCalls = new Map();
    const call = ({ id, command }: { id: string; command: string }) => {
      const inputs = {
        claude: { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } },
        codex: { type: "response_item", payload: { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd: command }) } },
        pi: { type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: id, toolName: "bash", toolInput: { command } }] } },
      };
      return creationRecordUrls({ value: inputs[provider], calls });
    };
    const result = ({ id, failed = false }: { id: string; failed?: boolean }) => {
      const outputs = {
        claude: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: url, is_error: failed }] } },
        codex: { type: "response_item", payload: { type: "function_call_output", call_id: id, output: `Process exited with code ${failed ? 1 : 0}\nFinal output:\n${url}` } },
        pi: { type: "message", message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text: url }], isError: failed } },
      };
      return creationRecordUrls({ value: outputs[provider], calls });
    };
    expect(call({ id: "create", command: "gh pr create --fill" })).toEqual([]);
    expect(call({ id: "read", command: "gh pr list" })).toEqual([]);
    expect(result({ id: "read" })).toEqual([]);
    expect(result({ id: "create" })).toEqual([url]);
    expect(result({ id: "create" })).toEqual([]);
    call({ id: "failed", command: "gh pr create --fill" });
    expect(result({ id: "failed", failed: true })).toEqual([]);
    expect(calls.size).toBe(0);
  });
});
