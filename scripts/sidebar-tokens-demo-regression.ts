import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// The demo roster with what herdr plugins report on its panes (#1209): the Quota plugin's usage and
// a summary on checkout-api's Claude, a task's progress on web-dashboard's Codex, a plugin's line for
// the OMP agent (display_agent), and markup that must stay text. Only this disposable demo fixture is
// rewritten; no live session is read. The machine events then say herdr's `[ui.sidebar.agents]`
// rows, as server/herdr-sidebar.ts reads them, and a later roster brings a new value. A roster the
// page reads carries the same as one pushed to it: the page reads it again every 30 seconds, and a
// read without them would take them off the rows until the next push.
const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-tokens-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const LONG = "reviewing the authentication middleware and the session refresh path before the release branch is cut";
const APPROVAL = "👀 approval · Approve to merge? Review: Pass";
const BOARD_WORKSPACE = 'li.workspace[data-workspace="w1D"]';
const WORKSPACE_TOKENS = `${BOARD_WORKSPACE} > .workspace-tokens`;
const patch = `(() => {
  const EventSourceDemo = window.EventSource;
  const reports = {
    "w1C:p1": { tokens: { quota: "5h 95% · Wk 67%", summary: ${JSON.stringify(LONG)} } },
    "w1D:p1": { tokens: { progress: "40% 12m", note: "<b>not markup</b>" } },
    [${JSON.stringify(panes.omp)}]: { display_agent: "needs a login · 8m ago" },
  };
  const workspaceReports = { w1D: { tokens: { board: ${JSON.stringify(APPROVAL)}, progress: "40% 32m" } } };
  const roster = (machines) => machines.map((machine) => {
    const copy = structuredClone(machine);
    for (const list of [copy.snapshot?.panes ?? [], copy.snapshot?.agents ?? []]) for (const entry of list) Object.assign(entry, structuredClone(reports[entry.pane_id] ?? {}));
    for (const entry of copy.snapshot?.workspaces ?? []) Object.assign(entry, structuredClone(workspaceReports[entry.workspace_id] ?? {}));
    return copy;
  });
  const sources = new Set();
  let last = [];
  const fetchDemo = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const answer = await fetchDemo(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.pathname !== "/api/machines" || method.toUpperCase() !== "GET" || !answer.ok) return answer;
    const body = await answer.clone().json();
    if (!Array.isArray(body.machines)) return answer;
    last = body.machines;
    return new Response(JSON.stringify({ ...body, machines: roster(body.machines) }), { status: answer.status, headers: answer.headers });
  };
  window.__tokens = {
    // a roster with a pane's tokens changed, as the server sends after herdr's pane.updated
    report(paneId, tokens) { reports[paneId] = { ...reports[paneId], tokens }; for (const source of sources) source.tell({ type: "machines", machines: roster(last) }); },
    reportWorkspace(id, tokens) { workspaceReports[id] = { tokens }; for (const source of sources) source.tell({ type: "machines", machines: roster(last) }); },
    // a roster with what a waiting agent says it waits for (OSC 7501's message)
    says(paneId, agent_message) { reports[paneId] = { ...reports[paneId], agent_message }; for (const source of sources) source.tell({ type: "machines", machines: roster(last) }); },
    // herdr's agent rows, as the server tells them
    rows(agents) { for (const source of sources) source.tell({ type: "herdr-sidebar", agents }); },
  };
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1; sources.add(this);
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; message.machines = roster(message.machines); }
        this.tell(message);
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    tell(message) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) })); }
    close() { this.inner.close(); this.readyState = 2; sources.delete(this); }
  };
})();`;

const row = (page: Page, pane: string) => page.locator(`.agent-list .agent-item[data-pane="${pane}"]`);
const tokensOf = (page: Page, pane: string) => row(page, pane).locator(".agent-tokens");
const box = async (page: Page, pane: string, selector: string) => (await row(page, pane).locator(selector).boundingBox())!;

async function checkWorkspaceTokens({ page, phone, capture }: { page: Page; phone: boolean; capture: boolean }) {
  const line = page.locator(WORKSPACE_TOKENS);
  const board = line.locator('[data-token="board"]');
  await line.waitFor();
  assert.equal(await line.textContent(), `${APPROVAL} · 40% 32m`);
  await assertTokenColor({ token: board, variable: "--indicator-working" });
  const emptyWorkspace = page.locator('li.workspace[data-workspace="w1E"]');
  assert.equal(await emptyWorkspace.count(), 1);
  assert.equal(await emptyWorkspace.locator(".workspace-tokens").count(), 0);
  const header = await page.locator(`${BOARD_WORKSPACE} > .workspace-header`).boundingBox();
  const tokenBox = await line.boundingBox();
  assert.ok(header && tokenBox && tokenBox.y >= header.y + header.height, "tokens sit under the workspace header");

  if (evidence && capture) {
    await line.scrollIntoViewIfNeeded();
    await page.locator(".sidebar-shell").screenshot({ path: join(evidence, `workspace-tokens-${phone ? "phone" : "desktop"}.png`) });
  }

  await reportWorkspace({ page, tokens: { board: "✗ failed · tests" } });
  await page.waitForFunction((selector) => document.querySelector(selector)?.textContent === "✗ failed · tests", WORKSPACE_TOKENS);
  await assertTokenColor({ token: board, variable: "--indicator-blocked" });

  await reportWorkspace({ page, tokens: { note: "<b>x</b>" } });
  await page.waitForFunction((selector) => document.querySelector(selector)?.textContent === "<b>x</b>", WORKSPACE_TOKENS);
  assert.equal(await line.locator("b").count(), 0, "workspace tokens are text");

  await reportWorkspace({ page, tokens: {} });
  await line.waitFor({ state: "detached" });
}

async function reportWorkspace({ page, tokens }: { page: Page; tokens: Record<string, string> }) {
  await page.evaluate((values) => {
    (window as Window & { __tokens: { reportWorkspace(id: string, tokens: Record<string, string>): void } }).__tokens.reportWorkspace("w1D", values);
  }, tokens);
}

async function assertTokenColor({ token, variable }: { token: Locator; variable: string }) {
  const { color, expected } = await token.evaluate((element, name) => {
    const sample = document.createElement("span");
    sample.style.color = `var(${name})`;
    element.append(sample);
    const colors = { color: getComputedStyle(element).color, expected: getComputedStyle(sample).color };
    sample.remove();
    return colors;
  }, variable);
  assert.equal(color, expected, `the board token uses ${variable}`);
}

/** the open sheet once it has come to rest: whether its title, its first action and Cancel can be tapped, and whether the long text scrolls in its own box */
async function sheetReach(page: Page, scroller: string): Promise<{ title: boolean; pin: boolean; cancel: boolean; scrolls: boolean }> {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((animation) => animation.finished)));
  return page.evaluate((selector) => {
    const hittable = (target: string): boolean => {
      const element = document.querySelector(target);
      if (!element) return false;
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return box.top >= 0 && box.bottom <= innerHeight && !!hit && element.contains(hit);
    };
    const long = document.querySelector(selector)!;
    return { title: hittable(".row-sheet .row-menu-target-name"), pin: hittable(".row-sheet .row-sheet-item"), cancel: hittable(".row-sheet .row-sheet-cancel"), scrolls: long.scrollHeight > long.clientHeight };
  }, scroller);
}

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "sidebar-tokens.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./sidebar-tokens.js"></script><script type="module"'));
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
      for (const phone of [false, true]) for (const rows of ["one", "two"] as const) {
        const theme = rows === "one" ? "dark" : "light";
        const context = await browser.newContext(phone
          ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US", colorScheme: theme }
          : { viewport: { width: 1280, height: 900 }, locale: "en-US", colorScheme: theme });
        try {
          await context.addInitScript(([value, sidebarRows]) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value, sidebarRows })), [theme, rows] as const);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.shell)}`);
          if (phone) {
            await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
            // the phone's drawer starts with Agents folded
            const toggle = page.locator(".agent-section-toggle");
            if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
          }
          const label = `${phone ? "phone" : "desktop"} ${rows === "one" ? "One line" : "Two lines"}`;

          // no herdr rows told yet: every token, by name, as text
          await tokensOf(page, panes.api).waitFor();
          assert.equal(await tokensOf(page, panes.api).textContent(), `5h 95% · Wk 67% · ${LONG}`, "every token of the pane, by name");
          assert.equal(await tokensOf(page, panes.web).textContent(), "<b>not markup</b> · 40% 12m", "a value is text, never markup");
          assert.equal(await row(page, panes.web).locator(".agent-tokens b").count(), 0);
          assert.equal(await row(page, panes.shell).locator(".agent-tokens").count(), 0, "a pane without tokens draws no line");
          assert.match(await row(page, panes.omp).locator(".agent-context").textContent() ?? "", /^needs a login · 8m ago · /, "a plugin's line for the agent leads the place");

          // the line sits under the title and the place, small and cut, its whole text in the tooltip
          const title = await box(page, panes.api, ".agent-title"), place = await box(page, panes.api, ".agent-context"), tokens = await box(page, panes.api, ".agent-tokens");
          // a touch screen's One line row draws no place (#3505): it stays in the row for a screen reader, clipped to a dot
          const placeDrawn = !(phone && rows === "one");
          if (!placeDrawn) assert.ok(place.width <= 1 && place.height <= 1, `a phone's One line row draws no place (${place.width}x${place.height})`);
          else if (rows === "one") assert.ok(Math.abs(title.y + title.height - (place.y + place.height)) < 3, "One line keeps the place beside the title");
          else assert.ok(place.y >= title.y + title.height - 1, "Two lines keeps the place under the title");
          const above = placeDrawn ? place : title;
          assert.ok(tokens.y >= above.y + above.height - 1, `the tokens have their own line, under the ${placeDrawn ? "place" : "title"}`);
          assert.ok(await tokensOf(page, panes.api).evaluate((element) => element.scrollWidth > element.clientWidth), "a long value is cut");
          assert.match(await row(page, panes.api).locator(".agent-select").getAttribute("title") ?? "", new RegExp(LONG), "the tooltip says it whole");
          const sizes = await row(page, panes.api).evaluate((item) => ({
            title: parseFloat(getComputedStyle(item.querySelector(".agent-title")!).fontSize),
            tokens: parseFloat(getComputedStyle(item.querySelector(".agent-tokens")!).fontSize),
            place: getComputedStyle(item.querySelector(".agent-context")!).color,
            color: getComputedStyle(item.querySelector(".agent-tokens")!).color,
          }));
          assert.ok(sizes.tokens < sizes.title, "smaller than the title");
          assert.equal(sizes.color, sizes.place, "dim as the place");
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await page.locator(".agents-sidebar").screenshot({ path: join(evidence, `tokens-${phone ? "phone" : "desktop"}-${rows}-line.png`) });
          }

          // a phone's ⋯ sheet says the cut text whole
          if (phone) {
            await row(page, panes.api).locator(".row-menu-toggle").click();
            const detail = page.locator(".row-sheet .row-sheet-detail");
            assert.equal(await detail.textContent(), `5h 95% · Wk 67% · ${LONG}`, "the sheet says every token whole");
            assert.ok(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "the sheet wraps instead of cutting");
            if (evidence && rows === "one") await page.locator(".row-sheet").screenshot({ path: join(evidence, "tokens-phone-sheet.png") });
            // a value that changes while the sheet is open changes in it too (#1349)
            await page.evaluate((pane) => (window as unknown as { __tokens: { report(paneId: string, tokens: object): void } }).__tokens.report(pane, { quota: "5h 40% \u00b7 Wk 70%" }), panes.api);
            await page.waitForFunction(() => document.querySelector(".row-sheet .row-sheet-detail")?.textContent === "5h 40% \u00b7 Wk 70%");
            await page.locator(".row-sheet-cancel").click();
            await page.locator(".row-sheet").waitFor({ state: "detached" });

            // dozens of long values scroll inside the sheet's head: the title, the pin action and Cancel stay in reach (#1349)
            const many = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`t${String(i).padStart(2, "0")}`, `value ${i} ${"lorem ipsum dolor sit amet ".repeat(11).trim()}`]));
            await page.evaluate(([pane, tokens]) => (window as unknown as { __tokens: { report(paneId: string, tokens: object): void } }).__tokens.report(pane, tokens), [panes.api, many] as const);
            await page.waitForFunction((pane) => document.querySelector(`.agent-list .agent-item[data-pane="${pane}"] .agent-tokens`)?.textContent?.startsWith("value 0 "), panes.api);
            await row(page, panes.api).locator(".row-menu-toggle").click();
            await detail.waitFor();
            assert.deepEqual(await sheetReach(page, ".row-sheet .row-sheet-detail"), { title: true, pin: true, cancel: true, scrolls: true }, "long tokens scroll in the sheet and leave its title and actions in reach");
            if (evidence && rows === "one") await page.screenshot({ path: join(evidence, "tokens-phone-sheet-many.png") });
            await page.locator(".row-sheet-cancel").click();
            await page.locator(".row-sheet").waitFor({ state: "detached" });
            await page.evaluate(([pane, summary]) => (window as unknown as { __tokens: { report(paneId: string, tokens: object): void } }).__tokens.report(pane, { quota: "5h 95% \u00b7 Wk 67%", summary }), [panes.api, LONG] as const);

            // what a waiting agent says it waits for is its own words, of any length: the sheet says them whole, and a
            // long one scrolls in the head as the tokens do, with the title, the actions and Cancel still in reach (#3505)
            const reason = "the migration renames a column the billing export still reads, so say whether to keep the old name too. ".repeat(30).trim();
            await page.evaluate(([pane, message]) => (window as unknown as { __tokens: { says(paneId: string, message: string): void } }).__tokens.says(pane, message), [panes.web, reason] as const);
            await row(page, panes.web).locator(".row-menu-toggle").click();
            const waitsFor = page.locator(".row-sheet .row-sheet-alert");
            await waitsFor.waitFor();
            assert.equal(await waitsFor.textContent(), reason, "the sheet says what the agent waits for, whole");
            const reasonReach = await sheetReach(page, ".row-sheet .row-sheet-alert");
            if (evidence && rows === "one") await page.screenshot({ path: join(evidence, "tokens-phone-sheet-long-reason.png") });
            assert.deepEqual(reasonReach, { title: true, pin: true, cancel: true, scrolls: true }, "a long waiting reason scrolls in the sheet and leaves its title and actions in reach");
            await page.locator(".row-sheet-cancel").click();
            await page.locator(".row-sheet").waitFor({ state: "detached" });
            await page.evaluate((pane) => (window as unknown as { __tokens: { says(paneId: string, message: string): void } }).__tokens.says(pane, ""), panes.web);
          }

          // herdr's rows told: only the tokens they name, in their order, a hide rule kept
          await page.evaluate(() => (window as unknown as { __tokens: { rows(agents: unknown): void } }).__tokens.rows({
            rows: [{ name: "progress" }, { name: "quota", rules: [{ starts_with: "0%", hide: true }] }],
            by_agent: {},
          }));
          await page.waitForFunction((pane) => document.querySelector(`.agent-list .agent-item[data-pane="${pane}"] .agent-tokens`)?.textContent === "5h 95% · Wk 67%", panes.api);
          assert.equal(await tokensOf(page, panes.web).textContent(), "40% 12m", "progress, and not the token the rows leave out");
          // a new value comes with the roster, as after herdr's pane.updated; one a rule hides takes the line away
          await page.evaluate((pane) => (window as unknown as { __tokens: { report(paneId: string, tokens: object): void } }).__tokens.report(pane, { quota: "5h 40% · Wk 70%" }), panes.api);
          await page.waitForFunction((pane) => document.querySelector(`.agent-list .agent-item[data-pane="${pane}"] .agent-tokens`)?.textContent === "5h 40% · Wk 70%", panes.api);
          await page.evaluate((pane) => (window as unknown as { __tokens: { report(paneId: string, tokens: object): void } }).__tokens.report(pane, { quota: "0% left" }), panes.api);
          await page.waitForFunction((pane) => document.querySelector(`.agent-list .agent-item[data-pane="${pane}"] .agent-tokens`) === null, panes.api);
          if (evidence && !phone && rows === "one") await page.locator(".agents-sidebar").screenshot({ path: join(evidence, "tokens-desktop-herdr-rows.png") });
          await checkWorkspaceTokens({ page, phone, capture: rows === "one" });
          assert.deepEqual(errors, []);
          console.log(`PASS ${label}: pane tokens follow herdr's rows and workspace tokens draw under the workspace name; both change live`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
