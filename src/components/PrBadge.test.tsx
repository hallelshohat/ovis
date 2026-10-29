import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceInfo } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PrBadge } from "./Sidebar.tsx";

Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-US"] });

const render = (tokens: Record<string, string>, props: { compact?: boolean; nested?: boolean } = {}) => renderToStaticMarkup(createElement(SettingsProvider, {
  children: createElement(PrBadge, { workspace: { workspace_id: "w1", tokens } as unknown as WorkspaceInfo, ...props }),
}));

describe("a worktree's pull request badge", () => {
  it("says each state in words in its tooltip", () => {
    const cases: [Record<string, string>, string][] = [
      [{ pr: "● #7", pr_checks: "✓ 4/4", pr_review: "approved" }, "Ready to merge"],
      [{ pr: "● #7", pr_review: "review req" }, "Waiting for review"],
      [{ pr: "● #7", pr_review: "changes req" }, "Changes requested"],
      [{ pr: "◐ #7", pr_checks: "… 3/14" }, "Checks running"],
      [{ pr: "⊗ #7", pr_checks: "✗ 2/14" }, "Checks failed"],
      [{ pr: "◌ #7 DRAFT" }, "Draft"],
      [{ pr: "◆ #7 MERGED" }, "Merged"],
      [{ pr: "⊘ #7 CLOSED" }, "Closed"],
    ];
    for (const [tokens, word] of cases) expect(render(tokens, { compact: true })).toContain(`<strong>${word}</strong>`);
  });

  it("adds the checks, the review and the open threads on a second line, and says it all to assistive tech", () => {
    const html = render({ pr: "● #7", pr_checks: "✓ 4/5", pr_review: "review req", pr_threads: "2 threads" });
    expect(html).toContain("<span>Checks ✓ 4/5 · review req · 2 threads</span>");
    expect(html).toContain('aria-label="Pull request #7, open: Waiting for review · Checks ✓ 4/5 · review req · 2 threads"');
    expect(html).not.toContain("title=");
  });

  it("keeps a badge without a page yet reachable by keyboard, and leaves out an empty second line", () => {
    const html = render({ pr: "◆ #7 MERGED" });
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('popover="manual"');
    expect(html).not.toContain(" · ");
  });

  it("keeps the words in a nested badge for assistive tech", () => {
    expect(render({ pr: "◌ #7 DRAFT" }, { nested: true })).toContain('<span class="visually-hidden">Pull request #7, draft: Draft</span>');
  });
});
