import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { byAttention, type PanePullRequests, type PullRequest } from "../../shared/pull-requests.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { fixRequest, PrHeaderButton, PrSheet, PullRequestPanel } from "./PullRequestPanel.tsx";

Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-US"] });

const pr = (number: number, over: Partial<PullRequest>): PullRequest => ({
  url: `https://github.com/acme/api/pull/${number}`, number, repo: "acme/api", own: true, title: `PR ${number}`,
  state: "open", checks: "passing", review: "none", check_runs: [], head: "feat", base: "main", additions: 4, deletions: 1,
  created_at: "2026-10-28T13:00:00Z", merged_at: null, closed_at: null, updated_at: "2026-10-28T13:00:00Z", ...over,
});
const failing = pr(88, { own: false, repo: "acme/client-sdk", url: "https://github.com/acme/client-sdk/pull/88", title: "Send Idempotency-Key from the SDK", checks: "failing", check_runs: [{ name: "Fast checks", state: "passing", url: null }, { name: "Integration and browser", state: "failing", url: null }] });
const scenario: PanePullRequests = { gh: "ok", linked: 0, events: [], pull_requests: [pr(1925, { state: "merged", merged_at: "2026-10-28T13:41:00Z" }), pr(1931, { checks: "pending" }), failing].sort(byAttention) };
const render = (data: PanePullRequests) => renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PullRequestPanel, { data, machineId: "local", paneId: "w1C:p1", agentName: "Claude" }) }));

describe("the pull request panel", () => {
  it("leads with the PR that needs the person, then the open rest, then the ended ones", () => {
    const html = render(scenario);
    expect(html).toContain(">Open · 2</span>");
    expect(html).toContain(">Needs attention first</span>");
    expect(html.indexOf("client-sdk#88")).toBeLessThan(html.indexOf("#1931"));
    expect(html.indexOf("#1931")).toBeLessThan(html.indexOf("Earlier in this chat</span>"));
    expect(html.indexOf("Earlier in this chat</span>")).toBeLessThan(html.indexOf("#1925"));
    expect(html).toContain('class="pr-card is-lead is-failing"');
    expect(html).toContain(">Ask Claude to fix</button>");
    expect(html).not.toContain("Squash and merge");
  });

  it("offers a merge only on an open lead with green checks", () => {
    const html = render({ gh: "ok", linked: 0, events: [], pull_requests: [pr(1931, { review: "approved", check_runs: [{ name: "Fast checks", state: "passing", url: null }] })] });
    expect(html).toContain(">Squash and merge</button>");
    expect(html).toContain("Approved");
  });

  it("says why there are none when gh cannot answer", () => {
    const html = render({ gh: "missing", linked: 1, events: [], pull_requests: [] });
    expect(html).toContain("GitHub CLI not found");
    expect(html).not.toContain("pr-card");
  });

  it("asks to fix the failing checks by name, for the person to send", () => {
    expect(fixRequest(failing)).toBe("These checks failed on client-sdk#88 (Send Idempotency-Key from the SDK): Integration and browser. Please fix them and push the branch.");
  });

  it("gives a way in to why when the chat wrote links gh cannot read, and stays quiet otherwise", () => {
    const button = (data: PanePullRequests) => renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PrHeaderButton, { data, expanded: false, controls: "pull-requests", onToggle: () => {} }) }));
    const unread = button({ gh: "missing", linked: 2, events: [], pull_requests: [] });
    expect(unread).toContain('class="pr-header-button is-unread"');
    expect(unread).toContain('aria-label="Pull requests: GitHub CLI not found"');
    expect(button({ gh: "missing", linked: 0, events: [], pull_requests: [] })).toBe("");
    expect(button({ gh: "ok", linked: 0, events: [], pull_requests: [] })).toBe("");
  });

  it("gives the sheet the id the header button controls", () => {
    const html = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PrSheet, { data: scenario, machineId: "local", paneId: "w1C:p1", agentName: "Claude", onClose: () => {} }) }));
    expect(html).toContain('id="pull-requests" class="modal pr-sheet"');
  });
});
