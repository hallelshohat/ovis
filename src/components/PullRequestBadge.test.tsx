import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PullRequest } from "../../shared/pull-requests.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PullRequestBadge } from "./PullRequestBadge.tsx";

Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-US"] });

const pr = (over: Partial<PullRequest>): PullRequest => ({
  url: "https://github.com/acme/api/pull/1936", number: 1936, repo: "acme/api", own: true, title: "Fix the flaky retry test",
  state: "open", checks: "passing", review: "none", check_runs: [], head: "fix", base: "main", additions: 1, deletions: 0,
  created_at: "", merged_at: null, closed_at: null, updated_at: "", ...over,
});
const render = (props: Parameters<typeof PullRequestBadge>[0]) => renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PullRequestBadge, props) }));

describe("a pull request badge", () => {
  it("draws a failing own PR by number, its word kept for assistive tech", () => {
    const html = render({ pr: pr({ checks: "failing" }) });
    expect(html).toContain('class="pull-badge is-failing"');
    expect(html).toContain('<span class="pull-badge-number">#1936</span>');
    expect(html).toContain('<span class="visually-hidden">Checks failed</span>');
  });

  it("says the state word in full, names another repository, and counts the others", () => {
    const html = render({ pr: pr({ own: false, repo: "acme/client-sdk", number: 88, url: "https://github.com/acme/client-sdk/pull/88", state: "merged" }), size: "full", more: 1 });
    expect(html).toContain("is-merged");
    expect(html).toContain(">client-sdk#88</span>");
    expect(html).toContain('<span class="pull-badge-word">Merged</span>');
    expect(html).toContain('aria-label="1 more open">+1</span>');
  });

  it("calls an open PR with nothing waiting ready to merge", () => {
    expect(render({ pr: pr({}), size: "full" })).toContain(">Ready to merge</span>");
    expect(render({ pr: pr({ review: "review_required" }), size: "full" })).toContain(">Waiting for review</span>");
  });

  it("says each state in words in its tooltip", () => {
    const cases: [Partial<PullRequest>, string][] = [
      [{ checks: "failing" }, "Checks failed"],
      [{ review: "changes_requested" }, "Changes requested"],
      [{ review: "review_required" }, "Waiting for review"],
      [{ checks: "pending" }, "Checks running"],
      [{}, "Ready to merge"],
      [{ state: "draft" }, "Draft"],
      [{ state: "merged" }, "Merged"],
      [{ state: "closed" }, "Closed"],
    ];
    for (const [over, word] of cases) expect(render({ pr: pr(over) })).toContain(`<strong>${word}</strong>`);
  });

  it("adds the title and how many checks passed under the word, and drops the native title", () => {
    const run = (state: "passing" | "failing") => ({ name: "ci", state, url: null });
    const html = render({ pr: pr({ checks: "failing", check_runs: [run("passing"), run("passing"), run("passing"), run("passing"), run("failing")] }) });
    expect(html).toContain("<span>#1936 Fix the flaky retry test</span>");
    expect(html).toContain("<span>Checks 4/5 passed</span>");
    expect(html).not.toContain("title=\"#");
    expect(render({ pr: pr({}) })).not.toContain("passed</span>");
  });
});
