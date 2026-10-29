import { describe, expect, it } from "bun:test";
import type { PrEvent, PullRequest } from "../../shared/pull-requests.ts";
import { prEventRows } from "./prEventRows.ts";

const url = "https://github.com/acme/api/pull/1925";
const pr = { url, number: 1925 } as PullRequest;

describe("pull request events among the turns", () => {
  const turns = ["2026-10-28T13:00:00Z", "2026-10-28T13:05:00Z", "2026-10-28T13:45:00Z", null];
  it("puts each event before the first turn that began after it, or at the end", () => {
    const events: PrEvent[] = [
      { at: "2026-10-28T13:20:00Z", kind: "opened", url },
      { at: "2026-10-28T13:41:00Z", kind: "merged", url },
      { at: "2026-10-28T14:00:00Z", kind: "branch", from: "feat/a", to: "feat/b" },
    ];
    const rows = prEventRows(events, turns, [pr]);
    expect(rows.map((row) => row.before)).toEqual([2, 2, 4]);
    expect(rows[0]!.pr).toBe(pr);
    expect(rows[2]!.pr).toBeNull();
  });

  it("keys the opening and the merge of one PR apart, and drops an event with no time", () => {
    const rows = prEventRows([{ at: "2026-10-28T13:20:00Z", kind: "opened", url }, { at: "2026-10-28T13:41:00Z", kind: "merged", url }, { at: "not a time", kind: "closed", url }], turns, [pr]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });
});
