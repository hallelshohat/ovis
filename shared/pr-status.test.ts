import { describe, expect, test } from "bun:test";
import { prStatus, remoteWebUrl } from "./pr-status.ts";

describe("prStatus", () => {
  test("an open PR with its checks, review and diff, as the plugin's compact style writes them", () => {
    expect(prStatus({ pr: "● #8371", pr_checks: "✓ 12/12", pr_review: "approved", pr_diff: "+4 -0", pr_threads: "0 threads" })).toEqual({
      number: 8371, state: "open", checksTone: "ok", checks: "✓ 12/12", review: { text: "approved", tone: "ok" }, diff: "+4 -0",
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
