import { describe, expect, it } from "bun:test";
import { GitPullRequest } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyState } from "./EmptyState.tsx";

describe("an empty state", () => {
  it("says one sentence as a status, and draws a button only with an action", () => {
    const quiet = renderToStaticMarkup(createElement(EmptyState, { icon: GitPullRequest, title: "No pull requests yet" }));
    expect(quiet).toContain('role="status"');
    expect(quiet).toContain('<p class="empty-state-title">No pull requests yet</p>');
    expect(quiet).not.toContain("<button");
    const acting = renderToStaticMarkup(createElement(EmptyState, { icon: GitPullRequest, title: "Couldn't load", detail: "The PC is away.", action: { label: "Try again", onClick: () => {} } }));
    expect(acting).toContain('<p class="empty-state-detail">The PC is away.</p>');
    expect(acting).toContain('<button type="button" class="btn">Try again</button>');
  });
});
