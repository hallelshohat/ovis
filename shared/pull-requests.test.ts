import { describe, expect, it } from "bun:test";
import { attentionRank, byAttention, canMerge, openCount, prLabel, type PullRequest } from "./pull-requests.ts";

const pr = (over: Partial<PullRequest>): PullRequest => ({
  url: "https://github.com/acme/api/pull/1", number: 1, repo: "acme/api", own: true, title: "t",
  state: "open", checks: "passing", review: "none", check_runs: [], head: "feat", base: "main",
  additions: 0, deletions: 0, created_at: "2026-10-28T10:00:00Z", merged_at: null, closed_at: null,
  updated_at: "2026-10-28T10:00:00Z", ...over,
});

describe("pull request attention order", () => {
  it("puts what needs the person first", () => {
    const order = [
      pr({ checks: "failing" }),
      pr({ review: "changes_requested" }),
      pr({ review: "review_required" }),
      pr({ checks: "pending" }),
      pr({}),
      pr({ state: "draft" }),
      pr({ state: "merged", merged_at: "2026-10-28T11:00:00Z" }),
      pr({ state: "closed", closed_at: "2026-10-28T11:00:00Z" }),
    ];
    expect(order.map(attentionRank)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([...order].reverse().sort(byAttention).map(attentionRank)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("breaks ties by the newest change, and merged ones by the newest merge", () => {
    const older = pr({ number: 1, updated_at: "2026-10-28T10:00:00Z" });
    const newer = pr({ number: 2, updated_at: "2026-10-28T12:00:00Z" });
    expect([older, newer].sort(byAttention).map((p) => p.number)).toEqual([2, 1]);
    const mergedEarly = pr({ number: 3, state: "merged", merged_at: "2026-10-28T09:00:00Z", updated_at: "2026-10-28T13:00:00Z" });
    const mergedLate = pr({ number: 4, state: "merged", merged_at: "2026-10-28T11:00:00Z", updated_at: "2026-10-28T11:00:00Z" });
    expect([mergedEarly, mergedLate].sort(byAttention).map((p) => p.number)).toEqual([4, 3]);
  });

  it("labels its own repository by number and another by its name", () => {
    expect(prLabel(pr({ number: 1931 }))).toBe("#1931");
    expect(prLabel(pr({ own: false, repo: "acme/client-sdk", number: 88 }))).toBe("client-sdk#88");
  });

  it("counts open and draft pull requests as open", () => {
    expect(openCount([pr({}), pr({ state: "draft" }), pr({ state: "merged" }), pr({ state: "closed" })])).toBe(2);
  });

  it("merges only an open PR whose checks are green or absent and with no changes requested", () => {
    expect(canMerge(pr({}))).toBe(true);
    expect(canMerge(pr({ checks: "none", review: "approved" }))).toBe(true);
    for (const over of [{ checks: "pending" as const }, { checks: "failing" as const }, { review: "changes_requested" as const }, { state: "draft" as const }, { state: "merged" as const }]) {
      expect(canMerge(pr(over))).toBe(false);
    }
  });
});
