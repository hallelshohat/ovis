import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// The herdr-projects board's actions (server/board-routes.ts, components/BoardTasks.tsx) on the demo
// roster. A fake board in the page answers /api/board/* as the server does: a task per linked worktree,
// found by its checkout (two of them share a title), one at its plan, one asking for a permission, and
// one whose space is gone; an approve offered for a step the task has left is refused (409). Archiving
// closes the task's space as the board does. Desktop right-click and the phone's ⋯ sheet each check the
// row menus, archive a task with the board's message and Undo, and the PC's Board tasks dialog lists
// and archives the task with no space. No live session or board is read. Screenshots go to UI_EVIDENCE_DIR.
const app = mkdtempSync(join(tmpdir(), "board-task-actions-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const patch = `(() => {
  const demoFetch = window.fetch;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  let tasks = null;
  // hold(): the next actions wait for release(), as a slow board's archive or remove does
  let held = null;
  window.__board = { calls: [], tasks: () => tasks, set(id, fields) { Object.assign(tasks.find((task) => task.id === id), fields); },
    hold() { let release; held = new Promise((resolve) => { release = resolve; }); window.__board.release = () => { held = null; release(); }; } };
  const load = async () => {
    if (tasks) return;
    const { snapshot } = await (await demoFetch("/api/session")).json();
    const linked = snapshot.workspaces.filter((workspace) => workspace.worktree?.is_linked_worktree);
    const steps = [["done", "done", ""], ["working", "working", ""], ["idle", "plan", ""], ["blocked", "asks", "permission"]];
    tasks = linked.slice(0, 4).map((workspace, index) => ({
      id: workspace.worktree.repo_name + "/" + (index + 1),
      // the first two share a title: only their checkouts tell them apart
      title: index < 2 ? "export-guard" : workspace.label,
      workspace: workspace.workspace_id, worktree: workspace.worktree.checkout_path,
      state: steps[index][0], stage: steps[index][1], kind: steps[index][2], archived: false,
    }));
    tasks.push({ id: linked[0].worktree.repo_name + "/9", title: "Old research", workspace: null, worktree: null, state: "done", stage: "done", kind: "", archived: false });
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith("/api/board/")) return demoFetch(input, init);
    await load();
    if (url.pathname === "/api/board/tasks") return json({ tasks: tasks.filter((task) => !task.archived).map(({ id, title, state, stage, kind, worktree }) => ({ id, title, state, stage, kind, worktree })) });
    const body = JSON.parse(init.body);
    window.__board.calls.push(body);
    if (held) await held;
    if (body.action === "archive-done") return json({ message: "archived the done tasks" });
    const task = tasks.find((candidate) => candidate.id === body.id);
    if (!task) return json({ error: { code: "board_refused", message: "No task " + body.id } }, 422);
    if (body.action === "approve" && (task.stage !== body.expect?.stage || task.kind !== body.expect?.kind)) {
      return json({ error: { code: "board_task_moved", message: task.id + " is no longer where it was shown (now: " + task.stage + "). Look at it again before approving." } }, 409);
    }
    if (body.action === "archive") {
      task.archived = true;
      if (task.workspace) await demoFetch("/api/workspace/close", { method: "POST", body: JSON.stringify({ workspace_id: task.workspace }) });
      return json({ message: task.id + ": archived." });
    }
    if (body.action === "restore") { task.archived = false; return json({ message: task.id + ": restored." }); }
    if (body.action === "clear") {
      task.archived = true;
      if (task.workspace) await demoFetch("/api/workspace/close", { method: "POST", body: JSON.stringify({ workspace_id: task.workspace }) });
      return json({ message: task.id + ": removed" });
    }
    return json({ message: task.id + ": " + body.action });
  };
})();`;

interface FakeTask { id: string; title: string; workspace: string | null; stage: string }
type Board = { calls: Record<string, unknown>[]; tasks(): FakeTask[]; set(id: string, fields: object): void; hold(): void; release(): void };
const workspaceRow = (page: Page, workspace: string) => page.locator(`.workspace-group[data-workspace="${workspace}"]`);

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
          const tasks = await page.evaluate(async () => {
            await fetch("/api/board/tasks");
            return (window as unknown as { __board: Board }).__board.tasks();
          });
          assert.ok(tasks.length === 5, "four linked worktrees and a task without a space");
          const [done, working, plan, asks, spaceless] = tasks as [FakeTask, FakeTask, FakeTask, FakeTask, FakeTask];
          const calls = () => page.evaluate(() => (window as unknown as { __board: Board }).__board.calls);

          // a sheet slides: a shot waits until it stands still
          const settle = () => page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((animation) => animation.finished.catch(() => undefined)))
            // and two frames, so the shot is of the page as it now stands
            .then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
          // headless Chrome keeps painting a phone sheet's closing slide for a moment after it leaves the DOM,
          // where neither a query nor getAnimations() sees it: a shot waits the slide out in the page's own time
          const slideOut = async () => { if (phone) { const start = await page.evaluate(() => performance.now()); await page.waitForFunction((from) => performance.now() > from + 1500, start); } };
          const sheetGone = () => phone ? page.locator(".row-sheet").waitFor({ state: "detached" }) : Promise.resolve();
          // a desktop's menu items, or a phone's sheet buttons
          const item = (label: string) => phone ? page.locator(".row-sheet-item", { hasText: label }) : page.getByRole("menuitem", { name: label });
          const openMenu = async (task: FakeTask) => {
            const header = workspaceRow(page, task.workspace!).locator("> .workspace-header");
            if (phone) await header.locator(".row-menu-toggle").click();
            else await header.click({ button: "right" });
            await item("Archive task").waitFor();
            await settle();
          };
          const closeMenu = async () => {
            if (phone) await page.locator(".row-sheet-cancel").click(); else await page.keyboard.press("Escape");
            await item("Archive task").waitFor({ state: "detached" });
            await sheetGone();
          };
          const note = page.locator(".machine-workspaces .board-note");

          // two tasks share a title: each space's menu acts on its own task, found by its checkout
          await openMenu(working);
          assert.equal(await item("Stop agent").count(), 1, "the working task's own menu");
          await item("Stop agent").click();
          await note.waitFor();
          assert.deepEqual((await calls()).at(-1), { action: "stop", id: working.id }, "the space's own task, not the first with its title");
          await sheetGone();
          await openMenu(done);
          assert.equal(await item("Stop agent").count(), 0, "the done task's menu has no agent to stop");
          await closeMenu();

          // a plan's yes offered, then the task moves on to its merge: the stale yes is refused, never a merge
          await openMenu(plan);
          await page.evaluate((id) => (window as unknown as { __board: Board }).__board.set(id, { stage: "approval" }), plan.id);
          await item("Approve plan").click();
          await page.waitForFunction(() => document.querySelector(".machine-workspaces .board-note.is-failed")?.textContent?.includes("no longer where it was shown"));
          assert.deepEqual((await calls()).at(-1), { action: "approve", id: plan.id, expect: { stage: "plan", kind: "" } });
          assert.equal(await page.getByRole("alertdialog").count(), 0);
          await sheetGone();
          // opened again, the menu says what approve now does, and asks first
          await openMenu(plan);
          assert.equal(await item("Approve plan").count(), 0);
          await item("Approve and merge…").click();
          await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
          await page.getByRole("alertdialog").waitFor({ state: "detached" });

          // a permission the agent waits for is allowed from its menu
          await openMenu(asks);
          await item("Allow request").click();
          await page.waitForFunction(() => document.querySelector(".machine-workspaces .board-note-text")?.textContent?.endsWith(": approve"));
          assert.deepEqual((await calls()).at(-1), { action: "approve", id: asks.id, expect: { stage: "asks", kind: "permission" } });
          await sheetGone();

          // archive the done task from its menu: the board's message, its space closes, Undo restores it
          await openMenu(done);
          assert.equal(await item("Remove task…").count(), 1);
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await item("Remove task…").scrollIntoViewIfNeeded();
            await page.screenshot({ path: join(evidence, `board-archive-${name}-menu.png`) });
          }
          // the board takes its time: the row greys out with what is under way, and the rest goes on
          await page.evaluate(() => (window as unknown as { __board: Board }).__board.hold());
          await item("Archive task").click();
          const archiving = workspaceRow(page, done.workspace!);
          await archiving.locator(".workspace-board-pending", { hasText: "Archiving…" }).waitFor();
          assert.equal(await archiving.getAttribute("aria-busy"), "true");
          assert.equal(await archiving.locator("> .workspace-header").evaluate((header) => (header as HTMLElement).inert), true, "its row cannot be acted on meanwhile");
          await sheetGone();
          await settle();
          await slideOut();
          if (evidence) await page.screenshot({ path: join(evidence, `board-archive-${name}-pending.png`) });
          // another space's menu still opens while the board works
          await openMenu(working);
          await closeMenu();
          await page.evaluate(() => (window as unknown as { __board: Board }).__board.release());
          await page.waitForFunction((id) => document.querySelector(".machine-workspaces .board-note-text")?.textContent === `${id}: archived.`, done.id);
          await workspaceRow(page, done.workspace!).waitFor({ state: "detached" });
          assert.equal(await workspaceRow(page, working.workspace!).count(), 1, "the other task with that title keeps its space");
          await sheetGone();
          await settle();
          await slideOut();
          if (evidence) await page.screenshot({ path: join(evidence, `board-archive-${name}-done.png`) });
          await note.getByRole("button", { name: "Undo" }).click();
          await page.waitForFunction(() => document.querySelector(".machine-workspaces .board-note-text")?.textContent?.endsWith(": restored."));
          assert.deepEqual((await calls()).slice(-2), [{ action: "archive", id: done.id }, { action: "restore", id: done.id }]);

          // Remove asks first, naming the task and saying unmerged work is kept
          await openMenu(working);
          await item("Remove task…").click();
          const question = page.getByRole("alertdialog");
          assert.equal(await question.locator(".modal-title").textContent(), `Remove task ${working.id} “${working.title}”?`);
          assert.match(await question.locator(".confirm-body").textContent() ?? "", /not merged is kept/);
          await settle();
          await slideOut();
          if (evidence && phone) await page.screenshot({ path: join(evidence, "board-remove-phone-confirm.png") });
          await question.getByRole("button", { name: "Cancel" }).click();
          await question.waitFor({ state: "detached" });

          // the PC's Board tasks: every task, also one whose space is gone, and the done ones at once
          await page.getByRole("button", { name: "Board tasks on workstation" }).click();
          const dialog = page.getByRole("dialog", { name: "Board tasks on workstation" });
          const entry = dialog.locator(`.board-task[data-task="${spaceless.id}"]`);
          await entry.waitFor();
          assert.equal(await dialog.locator(".board-task").count(), 5, "every task on the board");
          assert.equal(await dialog.getByRole("button", { name: "Archive done tasks in every repo (2)" }).count(), 1);
          await settle();
          await slideOut();
          if (evidence) await page.screenshot({ path: join(evidence, `board-tasks-${name}-dialog.png`) });
          await entry.getByRole("button", { name: "Archive task" }).click();
          await entry.waitFor({ state: "detached" });
          await page.waitForFunction((id) => document.querySelector(".board-tasks-modal .board-note-text")?.textContent === `${id}: archived.`, spaceless.id);
          assert.deepEqual((await calls()).at(-1), { action: "archive", id: spaceless.id });
          await settle();
          if (evidence) await page.screenshot({ path: join(evidence, `board-tasks-${name}-archived.png`) });
          await dialog.getByRole("button", { name: "Undo" }).click();
          await entry.waitFor();
          await dialog.getByRole("button", { name: "Archive done tasks in every repo (2)" }).click();
          assert.deepEqual((await calls()).at(-1), { action: "archive-done" });
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "detached" });

          // a remove: the question closes as soon as it is answered, and the row says Removing… until the board is done
          await page.evaluate(() => (window as unknown as { __board: Board }).__board.hold());
          await openMenu(working);
          await item("Remove task…").click();
          await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
          await page.getByRole("alertdialog").waitFor({ state: "detached" });
          await workspaceRow(page, working.workspace!).locator(".workspace-board-pending", { hasText: "Removing…" }).waitFor();
          await page.evaluate(() => (window as unknown as { __board: Board }).__board.release());
          await workspaceRow(page, working.workspace!).waitFor({ state: "detached" });
          assert.deepEqual((await calls()).at(-1), { action: "clear", id: working.id });
          assert.deepEqual(errors, []);
          console.log(`${name}: row menus, stale approve, permission, archive with Undo while pending, remove's question, Board tasks and a remove in the background pass`);
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
