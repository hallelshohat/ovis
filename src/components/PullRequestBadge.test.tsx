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
    expect(html).toContain('<span class="visually-hidden">Checks failing</span>');
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
    expect(render({ pr: pr({ review: "review_required" }), size: "full" })).toContain(">Review requested</span>");
  });
});
