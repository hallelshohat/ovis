import { describe, expect, it } from "bun:test";
import type { PanePullRequests } from "../../shared/pull-requests.ts";
import { nextDelay, PR_POLL_MS, readPullRequests, setPullRequestFetcher, shownPullRequests } from "./usePanePullRequests.ts";

describe("pull request polling", () => {
  it("reads every minute while the page is seen and online, and waits otherwise", () => {
    expect(nextDelay(true, true)).toBe(PR_POLL_MS);
    expect(PR_POLL_MS).toBe(60_000);
    expect(nextDelay(false, true)).toBeNull();
    expect(nextDelay(true, false)).toBeNull();
  });
});

describe("pull request reads that cross", () => {
  it("keeps a fresh answer when an older read lands after it", async () => {
    const answer = (gh: "ok" | "error", linked: number): PanePullRequests => ({ gh, pull_requests: [], events: [], linked });
    let releaseOld: (value: PanePullRequests) => void = () => {};
    const restore = setPullRequestFetcher((_pane, fresh) => fresh
      ? Promise.resolve(answer("ok", 2))
      : new Promise<PanePullRequests>((resolve) => { releaseOld = resolve; }));
    try {
      const old = readPullRequests("local", "race:p1", false);
      await readPullRequests("local", "race:p1", true);
      expect(shownPullRequests("local", "race:p1")?.linked).toBe(2);
      releaseOld(answer("ok", 1));
      await old;
      expect(shownPullRequests("local", "race:p1")?.linked).toBe(2);
    } finally { restore(); }
  });
});
