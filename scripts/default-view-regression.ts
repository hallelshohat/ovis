import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { herdrRpc, paneSplit, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";

export async function checkDefaultView(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ovis-view-"));
  const workspaces: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const panes: string[] = [];
    for (const name of ["one", "two"]) {
      const cwd = join(root, name);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `ovis-test-view-${name}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
      await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent: "claude", state: "idle" });
    }
    const [one, two] = panes as [string, string];
    await context.addInitScript((pane) => {
      if (localStorage.getItem("ovis:settings") !== null) return;
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`ovis:view:local:${pane}`, "terminal");
    }, two);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const lens = page.locator(".view-switch button[aria-pressed='true']");
    const chatLens = lens.and(page.getByTitle(/^Chat transcript/));
    const terminalLens = lens.and(page.getByTitle(/^Live terminal/));
    const viewChoices = page.getByRole("group", { name: "Panes open in", exact: true });
    await page.goto(`${origin}/?pane=${encodeURIComponent(one)}`);
    await page.locator(".conn-live").waitFor();
    await chatLens.waitFor();

    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Chat");
    await viewChoices.getByRole("button", { name: "Terminal", exact: true }).click();
    await page.keyboard.press("Escape");
    await terminalLens.waitFor();
    assert.equal(await page.evaluate((pane) => localStorage.getItem(`ovis:view:local:${pane}`), two), null, "what a pane remembered gives way to the choice");

    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Chat");
    await viewChoices.getByRole("button", { name: "Chat", exact: true }).click();
    await page.keyboard.press("Escape");
    await chatLens.waitFor();
    await page.locator(`.pane-select[title^="${two} —"]`).click();
    await chatLens.waitFor();
    await page.getByTitle(/^Live terminal \(.+\)$/).click();
    await page.locator(`.pane-select[title^="${one} —"]`).click();
    await page.locator(`.pane-select[title^="${two} —"]`).click();
    await terminalLens.waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS one choice in Settings opens every agent pane in the chat");

    const shell = (await paneSplit(one, "right", false)).pane_id;
    await page.locator(`.pane-select[title^="${one} —"]`).click();
    const frame = page.locator(`.pane-frame[data-layout-pane="${shell}"]`);
    await frame.locator(".pane-frame-body").click({ position: { x: 40, y: 40 } });
    await page.locator(`.pane-frame.is-current[data-layout-pane="${shell}"]`).waitFor();
    await terminalLens.waitFor();
    await herdrRpc("pane.report_agent", { pane_id: shell, source: "manual", agent: "claude", state: "working" });
    await page.locator('.app-header .tab-strip-tab[aria-selected="true"] .agent-mark.claude').waitFor({ timeout: 10_000 });
    assert.match((await lens.getAttribute("title")) ?? "", /^Live terminal/, "an agent starting in the open shell leaves it on its terminal");
    assert.deepEqual(errors, []);
    console.log("PASS a shell in use keeps its terminal when an agent starts in it");
  } finally {
    await context.close();
    for (const workspace of workspaces) await workspaceClose(workspace).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
