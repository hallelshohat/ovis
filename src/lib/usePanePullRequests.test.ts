import { describe, expect, it } from "bun:test";
import { nextDelay, PR_POLL_MS } from "./usePanePullRequests.ts";

describe("pull request polling", () => {
  it("reads every minute while the page is seen and online, and waits otherwise", () => {
    expect(nextDelay(true, true)).toBe(PR_POLL_MS);
    expect(PR_POLL_MS).toBe(60_000);
    expect(nextDelay(false, true)).toBeNull();
    expect(nextDelay(true, false)).toBeNull();
  });
});
