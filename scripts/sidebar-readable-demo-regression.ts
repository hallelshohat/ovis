/** Workspace titles keep their width beside long PR labels, in both row settings and themes. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { demoPullRequests } from "../site/demo/pullRequests.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const app = mkdtempSync(join(tmpdir(), "ovis-sidebar-readable-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const labels = {
  w1C: "main",
  w1D: "MAIN-103 Add an MFA column to the Human access users table",
  w1H: "MAIN-103 Add an MFA column to the Human access users table",
  w1J: "MAIN-12 MAIN-12 RD-130 Shorten slow analysis stages",
  w1K: "InvestigateAnUnbrokenWorkspaceTitleThatMustWrapInsideTheSidebar",
  w1L: "Cut integration test time in CI by five times",
};
const example = demoPullRequests("api").pull_requests[0]!;
const pullRequests = Array.from({ length: 16 }, (_, index) => ({
  ...example, number: 1754 + index, repo: "acme/infrastructure", own: false,
  url: `https://github.com/acme/infrastructure/pull/${1754 + index}`,
}));

// Rewrite only the demo transport, including its repeated roster events, never a live session.
const patch = `(() => {
  const labels = ${JSON.stringify(labels)}, prs = ${JSON.stringify(pullRequests)};
  const ownFetch = window.fetch.bind(window), OwnEvents = window.EventSource;
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const roster = (machines) => machines.map((machine) => {
    const copy = structuredClone(machine);
    for (const workspace of copy.snapshot?.workspaces ?? []) if (labels[workspace.workspace_id]) workspace.label = labels[workspace.workspace_id];
    for (const pane of copy.snapshot?.panes ?? []) if (labels[pane.workspace_id]) pane.label = labels[pane.workspace_id];
    return copy;
  });
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new OwnEvents(url, options); this.readyState = 1;
      this.inner.onmessage = (event) => {
        const value = JSON.parse(event.data); // no-smell: trusted demo fixture events, not external input.
        if (value.type === "machines") value.machines = roster(value.machines);
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close() { this.inner.close(); this.readyState = 2; }
  };
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.pathname === "/api/machines") {
      const value = await (await ownFetch(input, init)).json();
      return json({ ...value, machines: roster(value.machines) });
    }
    if (url.pathname.endsWith("/pane/pull-requests")) {
      const byPane = { ${JSON.stringify(panes.web)}: prs, ${JSON.stringify(panes.omp)}: prs, ${JSON.stringify(panes.flaky)}: [{ ...prs[0], own: true }] };
      const shown = byPane[url.searchParams.get("pane_id")] ?? [];
      return json({ gh: "ok", pull_requests: shown, events: [], linked: shown.length });
    }
    return ownFetch(input, init);
  };
})();`;

const row = ({ page, id }: { page: Page; id: string }) => page.locator(`.workspace-group[data-workspace="${id}"] > .workspace-header`);

async function checkLayout(page: Page): Promise<void> {
  const wideBadge = row({ page, id: "w1D" });
  const shortBadge = row({ page, id: "w1H" });
  assert.equal(await wideBadge.locator(".pull-badge-number").innerText(), "infrastructure#1754");
  assert.equal(await shortBadge.locator(".pull-badge-number").innerText(), "#1754");
  assert.equal(await wideBadge.locator(".pull-badge-more").innerText(), "+15");
  const width = async (id: string) => row({ page, id }).locator(".workspace-name").evaluate((el) => el.getBoundingClientRect().width);
  assert.equal(await width("w1D"), await width("w1H"), "PR labels cannot consume the title's width");
  assert.ok(await width("w1D") >= 100, "even the narrowest sidebar leaves readable title space");
  for (const [id, label] of Object.entries(labels)) {
    const header = row({ page, id });
    const title = header.locator(".workspace-name");
    assert.equal(await title.getAttribute("title"), label, "the title's own tooltip keeps the full original text");
    const metrics = await header.evaluate((el) => {
      const name = el.querySelector<HTMLElement>(".workspace-name")!;
      const meta = el.querySelector<HTMLElement>(".workspace-details");
      const box = name.getBoundingClientRect();
      return { overflow: el.scrollWidth > el.clientWidth + 1, height: box.height, line: parseFloat(getComputedStyle(name).lineHeight),
        below: !meta || meta.getBoundingClientRect().height === 0 || meta.getBoundingClientRect().top >= box.bottom - 1 };
    });
    assert.equal(metrics.overflow, false, `${id} has no horizontal overflow`);
    assert.ok(metrics.height <= metrics.line * 2 + 1, `${id} uses at most two title lines`);
    assert.ok(metrics.below, `${id} metadata stays below its title`);
  }
  const duplicate = row({ page, id: "w1J" });
  assert.equal((await duplicate.innerText()).match(/MAIN-12/g)?.length, 1, "a repeated key appears once visibly");
  assert.match(await duplicate.locator(".workspace-name").innerText(), /^RD-130/);
  assert.equal(await row({ page, id: "w1L" }).locator(".sidebar-pr").innerText(), "", "no PR leaves no badge");
  if (await page.locator(".machine-workspaces.is-two-line").count() === 0) {
    assert.equal(await row({ page, id: "w1C" }).locator(".workspace-details").isVisible(), false, "no key, PR or branch reserves no empty metadata line");
  }
  assert.equal(await page.locator('.worktree-children .workspace-group[data-workspace="w1D"]').count(), 1, "worktree nesting survives");
  assert.equal(await page.locator('.sidebar-pinned .workspace-group[data-workspace="w1J"]').count(), 1, "pinned rows use the same layout");
}

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "sidebar-readable.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./sidebar-readable.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file: string;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)) || "index.html"; } catch { return new Response("bad path", { status: 400 }); }
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const theme of ["dark", "light"] as const) for (const rows of ["one", "two"] as const) for (const size of [240, 320, 520, "phone"] as const) {
        const phone = size === "phone";
        const context = await browser.newContext({ viewport: { width: phone ? 390 : 1440, height: 1000 }, isMobile: phone, hasTouch: phone, locale: "en-US", colorScheme: theme });
        try {
          await context.addInitScript(({ theme, rows, size }) => {
            if (sessionStorage.getItem("readable-seeded")) return;
            sessionStorage.setItem("readable-seeded", "1");
            localStorage.setItem("ovis:settings", JSON.stringify({ theme, sidebarRows: rows, language: "en", sidebarAgentTree: false }));
            localStorage.setItem("ovis:agents-collapsed", "1");
            localStorage.setItem("ovis:sidebar-agent-pins", JSON.stringify(["local:workspace:w1J"]));
            if (typeof size === "number" && size !== 320) localStorage.setItem("ovis:sidebar-width", String(size));
          }, { theme, rows, size });
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.api)}`);
          if (phone) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
          await row({ page, id: "w1D" }).locator(".pull-badge-more").waitFor();
          await page.evaluate(() => document.fonts.ready);
          await page.mouse.move(-20, -20);
          if (!phone) assert.equal(await page.locator(".sidebar").evaluate((el) => el.getBoundingClientRect().width), size);
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await page.locator(".sidebar").screenshot({ path: join(evidence, `sidebar-${theme}-${rows}-${size}.png`), animations: "disabled" });
          }
          await checkLayout(page);
          if (!phone) {
            const target = row({ page, id: "w1D" });
            await target.hover();
            assert.ok(await target.getByRole("button", { name: /^More for/ }).isVisible(), "hover keeps the menu reachable");
            await target.locator(".workspace-select").focus();
            await page.keyboard.press("Enter");
            assert.equal(await target.locator(".workspace-select").getAttribute("aria-current"), "true", "keyboard selection still works");
            const edge = page.getByRole("separator", { name: "Resize sidebar", exact: true });
            await edge.focus();
            await page.keyboard.press("Home");
            await page.keyboard.press("ArrowRight");
            assert.equal(await page.evaluate(() => localStorage.getItem("ovis:sidebar-width")), "256");
            await page.reload();
            await row({ page, id: "w1D" }).locator(".pull-badge-more").waitFor();
            assert.equal(await edge.getAttribute("aria-valuenow"), "256", "width survives reload");
          }
          assert.deepEqual(errors, []);
          console.log(`PASS readable sidebar: ${theme}, ${rows}, ${size}`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
