import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A chat's pull requests on the demo's fixtures (site/demo/pullRequests.ts), no herdr and no GitHub:
// checkout-api's chat opened and merged #1925, moved to another branch in the same worktree, then
// opened #1931 and client-sdk#88, whose failing check makes it lead. Asserts the sidebar glyph and
// +N, the header button and the inspector it shows and hides, the thread's story in order, Ask to
// fix filling the message box and sending nothing, a merge behind its confirmation, a phone's sheet,
// and that the workbench's motion stops under reduced motion. Screenshots go to UI_EVIDENCE_DIR.
const app = mkdtempSync(join(tmpdir(), "herdr-pr-inspector-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
// every request the app makes after it starts, to show Ask to fix sends nothing
const recorder = `(() => {
  const own = window.fetch.bind(window);
  window.__requests = [];
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, location.href).pathname;
    window.__requests.push(((init && init.method) || (input instanceof Request ? input.method : "GET")) + " " + path);
    if (window.__prAnswer && path.endsWith("/pane/pull-requests")) return Promise.resolve(new Response(JSON.stringify(window.__prAnswer), { headers: { "content-type": "application/json" } }));
    return own(input, init);
  };
})();`;

async function shot(page: Page, name: string): Promise<void> {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `pr-inspector-${name}.png`) });
}

async function desktop(browser: Browser, origin: string, theme: "dark" | "light"): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", colorScheme: theme });
  try {
    await context.addInitScript((value) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value })); }, theme);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(panes.api)}`);

    const row = page.locator('.workspace-group[data-workspace="w1C"] > .workspace-header .sidebar-pr');
    await row.locator(".pull-badge.is-failing").waitFor();
    // both row types draw the leading PR's number and the chat's other open PRs as +N
    for (const where of [row, page.locator(".agent-item.is-selected .agent-row-status")]) {
      assert.equal(await where.locator(".pull-badge-number").innerText(), "client-sdk#88", `${theme}: a sidebar row names the leading PR`);
      assert.equal(await where.locator(".pull-badge-more").innerText(), "+1", `${theme}: a sidebar row counts the other open PR`);
    }

    const button = page.locator(".pr-header-button");
    assert.match(await button.innerText(), /client-sdk#88\s*Checks failing/, `${theme}: the header leads with the failing PR`);
    const inspector = page.locator("#pull-requests");
    await inspector.waitFor();
    assert.equal(await button.getAttribute("aria-expanded"), "true");
    assert.equal(await inspector.getByText("Open · 2", { exact: true }).count(), 1);
    assert.equal(await inspector.getByText("Earlier in this chat", { exact: true }).count(), 1);
    await shot(page, `desktop-${theme}`);
    await button.click();
    await inspector.waitFor({ state: "detached" });
    assert.equal(await button.getAttribute("aria-expanded"), "false", `${theme}: the header button hides the inspector`);
    await button.click();
    await inspector.waitFor();

    const story = await page.locator(".pr-event").evaluateAll((rows) => rows.map((row) => (row.querySelector(".pr-event-verb")?.textContent ?? "branch") + " " + (row.querySelector(".pull-badge-number")?.textContent ?? "")));
    assert.deepEqual(story, ["Opened #1925", "Merged #1925", "branch ", "Opened #1931", "Opened client-sdk#88"], `${theme}: the thread tells the PRs' story in order`);

    await page.evaluate(() => { (window as unknown as { __requests: string[] }).__requests.length = 0; });
    await inspector.getByRole("button", { name: "Ask Claude to fix", exact: true }).click();
    const box = page.locator(".composer-text").first();
    assert.match(await box.inputValue(), /^These checks failed on client-sdk#88 \(Send Idempotency-Key from the SDK\): Integration and browser\./, `${theme}: Ask to fix fills the message box`);
    assert.ok(await box.evaluate((node) => node === document.activeElement), `${theme}: the message box takes the focus`);
    const sent = await page.evaluate(() => (window as unknown as { __requests: string[] }).__requests.filter((request) => request.startsWith("POST ")));
    assert.deepEqual(sent, [], `${theme}: nothing is sent until the person sends it`);
    await box.fill("");

    // the changelog's #1940 waits for a review with green checks: it can be merged, behind a confirmation
    await page.locator(".agent-row").filter({ hasText: "Draft the changelog" }).click();
    await page.locator(".pr-header-button").filter({ hasText: "#1940" }).waitFor();
    await inspector.getByRole("button", { name: "Squash and merge", exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await confirm.waitFor();
    assert.match(await confirm.innerText(), /Merge #1940\?/);
    await confirm.getByRole("button", { name: "Squash and merge", exact: true }).click();
    await page.locator(".pr-header-button .pull-badge.is-merged").waitFor();
    await confirm.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.closest("[role=dialog], [role=alertdialog]") ?? null), null, `${theme}: a done merge leaves no dialog holding the focus`);
    assert.equal(await inspector.getByText("Earlier in this chat", { exact: true }).count(), 1, `${theme}: a merged PR moves under Earlier in this chat`);
    await shot(page, `merged-${theme}`);
    assert.deepEqual(errors, []);
    console.log(`PASS desktop ${theme}: sidebar number and +1, header button and inspector, the thread's story, Ask to fix fills the box, merge after a confirmation`);
  } finally { await context.close(); }
}

async function phone(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US", colorScheme: "dark" });
  try {
    await context.addInitScript(() => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })); });
    const page = await context.newPage();
    await page.goto(`${origin}/?pane=${encodeURIComponent(panes.api)}`);
    const button = page.locator(".pr-header-button");
    await button.waitFor();
    assert.equal(await button.locator(".pull-badge-word").isVisible(), false, "a phone's header keeps the title: the state word goes");
    await button.tap();
    const sheet = page.locator(".modal.pr-sheet");
    await sheet.waitFor();
    // where it rests once it has risen
    await sheet.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
    const box = await sheet.boundingBox();
    assert.ok(box && Math.abs(box.y + box.height - 844) <= 1, "on a phone the pull requests rise as a bottom sheet");
    await shot(page, "phone-sheet");
    console.log("PASS phone: the header's PR button opens a bottom sheet");
  } finally { await context.close(); }
}

async function ghMissing(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  try {
    await context.addInitScript(() => {
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      // this PC has no gh: the chat wrote one PR link it cannot read
      (window as unknown as { __prAnswer: unknown }).__prAnswer = { gh: "missing", linked: 1, events: [], pull_requests: [] };
    });
    const page = await context.newPage();
    await page.goto(`${origin}/?pane=${encodeURIComponent(panes.api)}`);
    const button = page.locator(".pr-header-button.is-unread");
    await button.waitFor();
    assert.equal(await button.getAttribute("aria-label"), "Pull requests: GitHub CLI not found");
    const inspector = page.locator("#pull-requests");
    if (await inspector.count() === 0) await button.click();
    await inspector.getByText("GitHub CLI not found", { exact: true }).waitFor();
    assert.ok(await inspector.getByText("Install gh on this PC to see this chat's pull requests.", { exact: true }).isVisible());
    await shot(page, "gh-missing");
    console.log("PASS gh missing: the header's quiet button opens the inspector, which says why");
  } finally { await context.close(); }
}

async function reducedMotion(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  try {
    await context.addInitScript(() => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })); });
    const page = await context.newPage();
    await page.goto(`${origin}/?pane=${encodeURIComponent(panes.api)}`);
    await page.locator("#pull-requests").waitFor();
    await page.locator(".machine-new-row").click();
    await page.locator(".new-session-modal").waitFor();
    const moving = await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === "running" && !(animation instanceof CSSAnimation && /pulse|breathe|spin/.test(animation.animationName))).length);
    if (moving !== 0) console.log(await page.evaluate(() => document.getAnimations().map((a) => `${a instanceof CSSAnimation ? a.animationName : a instanceof CSSTransition ? a.transitionProperty : "web"} ${a.playState} ${(a.effect as KeyframeEffect | null)?.target?.className}`)));
    assert.equal(moving, 0, "reduced motion: the side sheet, the inspector and the badges do not move");
    console.log("PASS reduced motion: nothing slides, pops or fades");
  } finally { await context.close(); }
}

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "recorder.js"), recorder);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./recorder.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    let file: string;
    try { file = decodeURIComponent(path.slice(1)); } catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const theme of ["dark", "light"] as const) await desktop(browser, origin, theme);
      await phone(browser, origin);
      await ghMissing(browser, origin);
      await reducedMotion(browser, origin);
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
