import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceInfo } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { WorkspaceTokens } from "./Sidebar.tsx";

Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-US"] });

const workspace: WorkspaceInfo = {
  workspace_id: "w1", active_tab_id: "w1:t1", number: 1, label: "web-dashboard",
  focused: false, agent_status: "blocked", pane_count: 1, tab_count: 1,
};

const render = (tokens?: Record<string, unknown>) => renderToStaticMarkup(createElement(SettingsProvider, {
  children: createElement(WorkspaceTokens, { workspace: tokens ? { ...workspace, tokens } : workspace }),
}));

describe("a workspace's metadata tokens", () => {
  it("draws board then progress, with the board's tone", () => {
    const html = render({ progress: "40% 32m", board: "👀 approval · Approve to merge? Review: Pass" });
    expect(html).toContain('data-token="board" data-tone="pending">👀 approval · Approve to merge? Review: Pass</span>');
    expect(html).toContain(' · <span class="workspace-token" data-token="progress" data-tone="neutral">40% 32m</span>');
    expect(html.indexOf('data-token="board"')).toBeLessThan(html.indexOf('data-token="progress"'));
  });

  it("draws nothing without displayable tokens", () => {
    expect(render()).toBe("");
    expect(render({})).toBe("");
    expect(render({ pr: "● #7" })).toBe("");
  });

  it("draws a value as text", () => {
    const html = render({ note: "<b>x</b>" });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>");
  });
});
