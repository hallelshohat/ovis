import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// The herdr-projects board's actions in a task space's row menu (server/board-routes.ts), on the demo
// roster: a fake board in the page answers /api/board/* with a task for each linked worktree (a done
// one and a working one), and archiving one closes its space as the board does. Desktop right-click
// and the phone's ⋯ sheet each archive a task, see the board's message with Undo, and undo it.
// No live session or board is read. Screenshots go to UI_EVIDENCE_DIR.
const app = mkdtempSync(join(tmpdir(), "board-task-actions-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const patch = `(() => {
  const demoFetch = window.fetch;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  let tasks = null;
  const closed = new Map();
  window.__board = { calls: [] };
  const load = async () => {
    if (tasks) return;
    const { snapshot } = await (await demoFetch("/api/session")).json();
    tasks = snapshot.workspaces.filter((workspace) => workspace.worktree?.is_linked_worktree).map((workspace, index) => ({
      id: workspace.worktree.repo_name + "/" + (index + 1), title: workspace.label, workspace: workspace.workspace_id,
      state: index === 0 ? "done" : "working", stage: index === 0 ? "done" : "working", archived: false,
    }));
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith("/api/board/")) return demoFetch(input, init);
    await load();
    if (url.pathname === "/api/board/tasks") return json({ tasks: tasks.filter((task) => !task.archived).map(({ id, title, state, stage }) => ({ id, title, state, stage })) });
    const body = JSON.parse(init.body);
    window.__board.calls.push(body);
    const task = tasks.find((candidate) => candidate.id === body.id);
    if (!task) return json({ error: { code: "board_refused", message: "No task " + body.id } }, 422);
    if (body.action === "archive") {
      task.archived = true;
      await demoFetch("/api/workspace/close", { method: "POST", body: JSON.stringify({ workspace_id: task.workspace }) });
      return json({ message: task.id + ": archived." });
    }
    if (body.action === "restore") { task.archived = false; return json({ message: task.id + ": restored." }); }
    return json({ message: task.id + ": " + body.action });
  };
})();`;

const workspaceRow = (page: Page, label: string) => page.locator(".workspace-group").filter({ has: page.locator(".workspace-select", { hasText: label }) }).first();

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "board.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./board.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    let file: string;
    try { file = decodeURIComponent(path.slice(1)); } catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const phone of [false, true]) {
        const context = await browser.newContext(phone
          ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US", colorScheme: "dark" }
          : { viewport: { width: 1280, height: 860 }, locale: "en-US", colorScheme: "dark" });
        try {
          await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })));
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/`);
          if (phone) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
          const name = phone ? "phone" : "desktop";
          const tasks = await page.evaluate(async () => (await (await fetch("/api/board/tasks")).json()).tasks as { id: string; title: string }[]);
          assert.ok(tasks.length >= 2, "the demo has two linked worktrees to stand for tasks");
          const done = tasks[0]!, working = tasks[1]!;

          // a sheet slides: a shot waits until it stands still
          const settle = () => page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((animation) => animation.finished.catch(() => undefined)))
            // and two frames, so the shot is of the page as it now stands
            .then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
          const sheetGone = () => phone ? page.locator(".row-sheet").waitFor({ state: "detached" }) : Promise.resolve();
          // a desktop's menu items, or a phone's sheet buttons
          const item = (label: string) => phone ? page.locator(".row-sheet-item", { hasText: label }) : page.getByRole("menuitem", { name: label });
          // a working task offers Stop; a done one only Archive and Remove
          const openMenu = async (label: string) => {
            const row = workspaceRow(page, label);
            if (phone) await row.locator(".row-menu-toggle").first().click();
            else await row.locator(".workspace-header").first().click({ button: "right" });
            await item("Archive task").waitFor();
            await settle();
          };
          await openMenu(working.title);
          assert.equal(await item("Stop agent").count(), 1, "a working task can be stopped");
          if (phone) await page.locator(".row-sheet-cancel").click(); else await page.keyboard.press("Escape");
          await item("Archive task").waitFor({ state: "detached" });
          await sheetGone();

          await openMenu(done.title);
          assert.equal(await item("Stop agent").count(), 0, "a done task has no agent to stop");
          assert.equal(await item("Remove task…").count(), 1);
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await item("Remove task…").scrollIntoViewIfNeeded();
            await page.screenshot({ path: join(evidence, `board-archive-${name}-menu.png`) });
          }
          await item("Archive task").click();
          const note = page.locator(".sidebar-board-note");
          await note.waitFor();
          assert.equal(await note.locator(".sidebar-board-note-text").textContent(), `${done.id}: archived.`, "the board's own message");
          await workspaceRow(page, done.title).waitFor({ state: "detached" });
          await sheetGone();
          await settle();
          if (evidence) {
            // headless Chrome keeps painting a phone sheet's closing slide for a moment after it leaves the DOM,
            // where neither a query nor getAnimations() sees it: the shot waits the slide out in the page's own time
            if (phone) { const start = await page.evaluate(() => performance.now()); await page.waitForFunction((from) => performance.now() > from + 1500, start); }
            await page.screenshot({ path: join(evidence, `board-archive-${name}-done.png`) });
          }

          await note.getByRole("button", { name: "Undo" }).click();
          await page.waitForFunction(() => document.querySelector(".sidebar-board-note-text")?.textContent?.endsWith(": restored."));
          const calls = await page.evaluate(() => (window as unknown as { __board: { calls: unknown[] } }).__board.calls);
          assert.deepEqual(calls, [{ action: "archive", id: done.id }, { action: "restore", id: done.id }]);

          // Remove asks first, naming the task and saying unmerged work is kept
          await openMenu(working.title);
          await item("Remove task…").click();
          const dialog = page.getByRole("alertdialog");
          assert.equal(await dialog.locator(".modal-title").textContent(), `Remove task ${working.id} “${working.title}”?`);
          assert.match(await dialog.locator(".confirm-body").textContent() ?? "", /not merged is kept/);
          await settle();
          if (evidence && phone) await page.screenshot({ path: join(evidence, "board-remove-phone-confirm.png") });
          await dialog.getByRole("button", { name: "Cancel" }).click();
          await dialog.waitFor({ state: "detached" });
          assert.deepEqual(errors, []);
          console.log(`${name}: archive, undo and remove's question pass`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
