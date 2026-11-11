import { describe, expect, it, setSystemTime } from "bun:test";
import type { PanePullRequests } from "../../shared/pull-requests.ts";
import { BACKGROUND_READS, ENTER_FRESH_MS, enterPullRequests, nextDelay, prefetchTargets, PR_POLL_MS, readPullRequests, setPullRequestFetcher, shownPullRequests } from "./usePanePullRequests.ts";

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

describe("pull request prefetch", () => {
  const answer: PanePullRequests = { gh: "ok", pull_requests: [], events: [], linked: 0 };
  /** a fetcher whose answers the test releases, and the panes it was asked for */
  function held() {
    const asked: string[] = [];
    const releases: (() => void)[] = [];
    const restore = setPullRequestFetcher((pane) => {
      asked.push(pane);
      return new Promise<PanePullRequests>((resolve) => { releases.push(() => resolve(answer)); });
    });
    return { asked, releases, restore };
  }

  it("shares one request between reads asked at once", async () => {
    const { asked, releases, restore } = held();
    try {
      const first = readPullRequests("local", "dedupe:p", false);
      const second = readPullRequests("local", "dedupe:p", false);
      expect(asked).toEqual(["dedupe:p"]);
      releases[0]!();
      await Promise.all([first, second]);
      expect(shownPullRequests("local", "dedupe:p")).toEqual(answer);
    } finally { restore(); }
  });

  it("runs at most BACKGROUND_READS background reads at once", async () => {
    const { asked, releases, restore } = held();
    const panes = ["cap:1", "cap:2", "cap:3", "cap:4", "cap:5"];
    const reads = panes.map((pane) => readPullRequests("local", pane, false, true));
    try {
      expect(asked.length).toBe(BACKGROUND_READS);
      expect(BACKGROUND_READS).toBe(2);
      releases[0]!();
      await reads[0];
      expect(asked.length).toBe(3);
    } finally {
      // drain the queue: each answer lets the next queued read start
      for (let index = 0; index < panes.length; index++) { releases[index]?.(); await reads[index]; }
      restore();
    }
  });

  it("starts a queued read at once when its pane is entered", async () => {
    const { asked, releases, restore } = held();
    const reads = ["promote:1", "promote:2", "promote:3"].map((pane) => readPullRequests("local", pane, false, true));
    try {
      expect(asked).toEqual(["promote:1", "promote:2"]);
      enterPullRequests("local", "promote:3");
      expect(asked).toEqual(["promote:1", "promote:2", "promote:3"]);
    } finally {
      for (const release of releases) release();
      await Promise.all(reads);
      restore();
    }
  });

  it("reads again on enter only when the last answer is older than ENTER_FRESH_MS", async () => {
    const { asked, releases, restore } = held();
    try {
      const first = readPullRequests("local", "enter:p", false);
      releases[0]!();
      await first;
      enterPullRequests("local", "enter:p");
      expect(asked.length).toBe(1);
      setSystemTime(new Date(Date.now() + ENTER_FRESH_MS + 1));
      enterPullRequests("local", "enter:p");
      expect(asked.length).toBe(2);
      releases[1]!();
    } finally { setSystemTime(); restore(); }
  });

  it("keeps every connected PC's agent panes warm, not shells or PCs away", () => {
    const pane = (pane_id: string, agent: string | null) => ({ pane_id, agent, workspace_id: "w", tab_id: "t" });
    const machine = (id: string, state: string, panes: unknown[]) => ({ id, state, snapshot: { panes, agents: [], workspaces: [{ workspace_id: "w" }], tabs: [] } }) as never;
    expect(prefetchTargets([
      machine("a", "connected", [pane("a:1", "claude"), pane("a:2", null)]),
      machine("b", "offline", [pane("b:1", "claude")]),
    ])).toEqual([{ machineId: "a", paneId: "a:1" }]);
  });
});
