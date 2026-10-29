import { describe, expect, test } from "bun:test";
import { prStatus, prStatusWord, remoteWebUrl } from "./pr-status.ts";

describe("prStatus", () => {
  test("an open PR with its checks, review and diff, as the plugin's compact style writes them", () => {
    expect(prStatus({ pr: "● #8371", pr_checks: "✓ 12/12", pr_review: "approved", pr_diff: "+4 -0", pr_threads: "0 threads" })).toEqual({
      number: 8371, state: "open", checksTone: "ok", checks: "✓ 12/12", review: { text: "approved", tone: "ok" }, diff: "+4 -0", threads: null,
    });
  });

  test("merged, closed and draft come from the word and the glyph alike", () => {
    expect(prStatus({ pr: "◆ #8470 MERGED", pr_diff: "+89 -311" })).toMatchObject({ number: 8470, state: "merged", checks: null, review: null, diff: "+89 -311" });
    expect(prStatus({ pr: "⊘ #12 CLOSED" })?.state).toBe("closed");
    expect(prStatus({ pr: "◌ #8560 DRAFT", pr_checks: "✓ 6/6", pr_review: "review req" })).toMatchObject({ state: "draft", checksTone: "ok", review: { text: "review req", tone: "pending" } });
    expect(prStatus({ pr: "\u{1F7E3} #5 MERGED" })?.state).toBe("merged");
    expect(prStatus({ pr: "\u{26AA} #5" })?.state).toBe("draft");
  });

  test("failing and running checks: from pr_checks, else from the state glyph", () => {
    expect(prStatus({ pr: "⊗ #1", pr_checks: "✗ 2/14", pr_review: "changes req" })).toMatchObject({ state: "open", checksTone: "fail", review: { tone: "fail" } });
    expect(prStatus({ pr: "◐ #1", pr_checks: "… 3/14" })?.checksTone).toBe("pending");
    expect(prStatus({ pr: "\u{1F7E1} #1", pr_checks: "⏳ 3/14" })?.checksTone).toBe("pending");
    expect(prStatus({ pr: "⊗ #1" })).toMatchObject({ checksTone: "fail", checks: null });
    expect(prStatus({ pr: "\u{1F534} #1" })?.checksTone).toBe("fail");
    expect(prStatus({ pr: "● #1" })?.checksTone).toBe("neutral");
  });

  test("no plugin, no PR or a value it did not write: no badge", () => {
    expect(prStatus(undefined)).toBeNull();
    expect(prStatus({})).toBeNull();
    expect(prStatus({ progress: "70% 3m" })).toBeNull();
    expect(prStatus({ pr: "" })).toBeNull();
    expect(prStatus({ pr: 8470 })).toBeNull();
    expect(prStatus({ pr: "no pull request" })).toBeNull();
  });
});

describe("prStatusWord", () => {
  const word = (tokens: Record<string, string>) => prStatusWord(prStatus(tokens)!);

  test("each state the badge can show maps to its one word", () => {
    expect(word({ pr: "● #1", pr_checks: "✓ 4/4", pr_review: "approved" })).toBe("ready");
    expect(word({ pr: "● #1" })).toBe("ready");
    expect(word({ pr: "● #1", pr_checks: "✓ 4/4", pr_review: "review req" })).toBe("review");
    expect(word({ pr: "● #1", pr_checks: "✓ 4/4", pr_review: "changes req" })).toBe("changes");
    expect(word({ pr: "◐ #1", pr_checks: "… 3/14" })).toBe("running");
    expect(word({ pr: "⊗ #1", pr_checks: "✗ 2/14" })).toBe("failed");
    expect(word({ pr: "◌ #1 DRAFT", pr_checks: "✗ 2/14" })).toBe("draft");
    expect(word({ pr: "◆ #1 MERGED" })).toBe("merged");
    expect(word({ pr: "⊘ #1 CLOSED" })).toBe("closed");
  });

  test("failing checks outrank a review, and a review outranks running checks", () => {
    expect(word({ pr: "⊗ #1", pr_checks: "✗ 2/14", pr_review: "changes req" })).toBe("failed");
    expect(word({ pr: "◐ #1", pr_checks: "… 3/14", pr_review: "changes req" })).toBe("changes");
    expect(word({ pr: "◐ #1", pr_checks: "… 3/14", pr_review: "review req" })).toBe("running");
  });

  test("open threads are kept, none is nothing to say", () => {
    expect(prStatus({ pr: "● #1", pr_threads: "2 threads" })?.threads).toBe("2 threads");
    expect(prStatus({ pr: "● #1", pr_threads: "0 threads" })?.threads).toBeNull();
  });
});

describe("remoteWebUrl", () => {
  test("ssh, scp-like and https remotes name the same page", () => {
    expect(remoteWebUrl("git@github.com:hallelshohat/ovis.git")).toBe("https://github.com/hallelshohat/ovis");
    expect(remoteWebUrl("https://github.com/hallelshohat/ovis.git\n")).toBe("https://github.com/hallelshohat/ovis");
    expect(remoteWebUrl("https://github.com/hallelshohat/ovis/")).toBe("https://github.com/hallelshohat/ovis");
    expect(remoteWebUrl("ssh://git@github.com:22/hallelshohat/ovis.git")).toBe("https://github.com/hallelshohat/ovis");
  });

  test("a local path or a hostless remote has no page", () => {
    expect(remoteWebUrl("/Users/hallel/repo")).toBeNull();
    expect(remoteWebUrl("file:///Users/hallel/repo")).toBeNull();
    expect(remoteWebUrl("origin:repo")).toBeNull();
    expect(remoteWebUrl("")).toBeNull();
  });
});
