/** Full demo UI with native synthetic history; --baseline records old code, --throttled adds 1.5 Mbps/80 ms networking. */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { forgetTranscriptState, transcriptPage } from "../server/conversation.ts";
import { compressResponse } from "../server/compress.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

interface LoadingSample {
  opened: number;
  placeholder: number | null;
  composer: number | null;
  response: number | null;
  latest: number | null;
  settled: number | null;
  blankFrames: number;
  firstMessage: string | null;
  longTasks: number[];
}

declare global {
  interface Window {
    loadingQa: {
      sample: LoadingSample;
      held: boolean;
      release: () => void;
      expected: string;
      reads: number;
    };
  }
}

await checkChatLoading();

async function checkChatLoading(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ovis-chat-loading-"));
  const app = join(root, "app");
  const path = join(root, "long.jsonl");
  const shortPath = join(root, "short.jsonl");
  const evidence = process.env.UI_EVIDENCE_DIR;
  const baseline = process.argv.includes("--baseline");
  const throttled = process.argv.includes("--throttled");
  const measurements: object[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    if (evidence) mkdirSync(evidence, { recursive: true });
    writeFileSync(path, Array.from({ length: 1000 }, (_, index) => exchange(index)).join(""));
    writeFileSync(shortPath, exchange(0));
    await buildDemoApp(app);
    const index = join(app, "index.html");
    const html = readFileSync(index, "utf8");
    writeFileSync(index, html.replace(/<script type="module"/, () => `<script>window.loadingNativeFetch = window.fetch.bind(window)</script><script src="./demo-transport.js"></script><script>(${installProbe.toString()})(${JSON.stringify(panes.omp)})</script><script type="module"`));
    let parseMs = 0, responseBytes = 0, wireBytes = 0, cold = true, short = false, working = false;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/pane/conversation") {
        if (cold) { forgetTranscriptState(); cold = false; }
        const start = performance.now();
        const before = url.searchParams.get("before"), from = url.searchParams.get("from"), since = url.searchParams.get("since");
        const prompts = url.searchParams.has("prompts") ? Number(url.searchParams.get("prompts")) : undefined;
        assert.ok(prompts === undefined || Number.isInteger(prompts) && prompts > 0);
        const answer = transcriptPage("omp-transcript", short ? shortPath : path, {
          ...(before === null ? {} : { before }), ...(from === null ? {} : { from }), ...(since === null ? {} : { since }),
          ...(prompts === undefined ? {} : { prompts }),
        });
        parseMs = performance.now() - start;
        const body = JSON.stringify({ ...answer, activity: working ? "working" : "idle" });
        responseBytes = Buffer.byteLength(body);
        const response = await compressResponse(request, new Response(body, { headers: { "content-type": "application/json", etag: `"${answer.version}:${working}"` } }));
        assert.ok(response);
        wireBytes = (await response.clone().arrayBuffer()).byteLength;
        return response;
      }
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (file.includes("..") || file.includes("\\")) return new Response(null, { status: 400 });
      return new Response(Bun.file(join(app, file)));
    } });
    browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    const url = `http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.omp)}`;
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, locale: "en-US", reducedMotion: "reduce" });
      let releaseChunk = () => {};
      try {
        await context.addInitScript((pane) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
          localStorage.setItem(`ovis:view:${pane}`, "chat");
        }, panes.omp);
        const page = await context.newPage();
        const chunkPattern = /\/assets\/ChatTimeline-[^/]+\.js$/;
        if (!throttled) {
          const chunkGate = new Promise<void>(resolve => { releaseChunk = resolve; });
          await page.route(chunkPattern, async route => { await chunkGate; await route.continue(); });
        }
        if (throttled) {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Network.enable");
          await cdp.send("Network.emulateNetworkConditionsByRule", { matchedNetworkConditions: [{ urlPattern: `http://127.0.0.1:${server.port}/api/pane/conversation*`, latency: 80, downloadThroughput: 187_500, uploadThroughput: 93_750 }] });
        }
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(url + "&hold=1", { waitUntil: "domcontentloaded" });
        const composer = page.getByRole("textbox", { name: "Message", exact: true });
        await composer.fill("Draft while the conversation loads");
        const before = await composer.boundingBox();
        assert.ok(before);
        await page.getByText("Loading conversation…", { exact: true }).waitFor();
        if (evidence) await page.screenshot({ path: join(evidence, `loading-${viewport.width}.png`) });
        const skeleton = page.locator(".chat-loading-placeholder");
        if (!baseline) {
          assert.equal(await skeleton.count(), 1, "one immediate skeleton while the read is held");
          assert.equal(await skeleton.locator(".skeleton").first().evaluate(el => getComputedStyle(el).animationName), "none", "respects reduced motion");
          assert.equal(await page.locator('[role="status"]').filter({ hasText: "Loading conversation…" }).count(), 1);
        }
        await page.evaluate(() => window.loadingQa.release());
        await page.waitForFunction(() => window.loadingQa.sample.response !== null);
        if (!baseline && !throttled) assert.equal(await skeleton.count(), 1, "the placeholder also covers the pending timeline chunk");
        releaseChunk();
        await latestVisible(page);
        await page.unroute(chunkPattern);
        const after = await composer.boundingBox();
        assert.ok(after);
        for (const axis of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(after[axis] - before[axis]) <= 1, `composer ${axis} stays fixed`);
        assert.equal(await composer.inputValue(), "Draft while the conversation loads");
        assert.equal(await composer.evaluate(el => el === document.activeElement), true);
        if (evidence) await page.screenshot({ path: join(evidence, `loaded-${viewport.width}.png`) });
        const controlled = await page.evaluate(() => window.loadingQa.sample);
        measurements.push({ width: viewport.width, case: "held read", ...controlled, parseMs, responseBytes, wireBytes });

        for (const cache of ["cold", "warm"] as const) for (let run = 0; run < 5; run++) {
          cold = cache === "cold";
          await page.goto(url);
          await latestVisible(page);
          const sample = await page.evaluate(() => window.loadingQa.sample);
          if (!baseline) {
            assert.ok(sample.firstMessage?.includes("Answer 999"), "first visible message is from the latest exchange");
            assert.equal(sample.blankFrames, 0, "no blank frame between the placeholder and messages");
          }
          measurements.push({ width: viewport.width, case: cache, run, ...sample, parseMs, responseBytes, wireBytes });
        }

        // A native append is visible while the agent is still working; the draft stays usable.
        working = true;
        appendFileSync(path, exchange(1000 + viewport.width));
        await page.goto(url + "&hold=1");
        await composer.fill("Draft during live work");
        await page.evaluate((expected) => { window.loadingQa.expected = expected; window.loadingQa.release(); }, `Answer ${1000 + viewport.width}`);
        await latestVisible(page);
        await page.getByText("Working…", { exact: true }).first().waitFor();
        assert.equal(await composer.inputValue(), "Draft during live work");
        if (evidence) await page.screenshot({ path: join(evidence, `working-${viewport.width}.png`) });
        await page.goto(url + `&expected=Answer%20${1000 + viewport.width}`);
        await latestVisible(page);
        measurements.push({ width: viewport.width, case: "working", ...await page.evaluate(() => window.loadingQa.sample), parseMs, responseBytes, wireBytes });
        working = false;
        writeFileSync(path, Array.from({ length: 1000 }, (_, i) => exchange(i)).join(""));
        forgetTranscriptState();

        short = true;
        await page.goto(url + "&hold=1");
        await page.evaluate(() => { window.loadingQa.expected = "Answer 0"; window.loadingQa.release(); });
        await latestVisible(page);
        assert.equal(await page.locator(".chat-loading-placeholder").count(), 0);
        await page.goto(url + "&expected=Answer%200");
        await latestVisible(page);
        measurements.push({ width: viewport.width, case: "short", ...await page.evaluate(() => window.loadingQa.sample), parseMs, responseBytes, wireBytes });
        short = false;
        if (!baseline) {
          const conversationRoute = "**/api/pane/conversation?*";
          await page.route(conversationRoute, route => route.fulfill({ status: 504, json: { error: { code: "timeout", message: "Synthetic slow read" } } }));
          await page.goto(url);
          await page.getByText("Waiting for the PC…", { exact: true }).waitFor();
          assert.equal(await page.locator(".chat-loading-placeholder").count(), 1, "a slow first read keeps its skeleton");
          await page.unroute(conversationRoute);
          await page.route(conversationRoute, route => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Synthetic read failure" } } }));
          await page.goto(url);
          await page.getByRole("button", { name: "Try again", exact: true }).click({ trial: true });
          assert.equal(await page.locator(".chat-loading-placeholder").count(), 0, "a failed read exposes its retry");
          await page.unroute(conversationRoute);
          await page.getByRole("button", { name: "Try again", exact: true }).click();
          await latestVisible(page);
        }
        assert.deepEqual(errors, [], "no browser errors");
        console.log(`PASS chat loading, composer stability, latest-first rendering, short and working chats at ${viewport.width}px`);
      } finally { releaseChunk(); await context.close(); }
    }
    if (evidence) writeFileSync(join(evidence, "timings.json"), JSON.stringify(measurements, null, 2));
    console.log(`Recorded ${measurements.length} loading samples${evidence ? ` in ${join(evidence, "timings.json")}` : ""}`);
  } finally {
    await browser?.close();
    server?.stop(true);
    forgetTranscriptState();
    rmSync(root, { recursive: true, force: true });
  }
}

function exchange(index: number): string {
  const entry = (message: object) => JSON.stringify({ type: "message", message }) + "\n";
  const output = Array.from({ length: 700 }, (_, line) => `fictional/module-${index}.ts:${line}: const item${line} = { id: ${index * 700 + line}, ready: true };`).join("\n");
  return entry({ role: "user", content: `Question ${index}: inspect this fictional change.` })
    + entry({ role: "assistant", content: [{ type: "toolCall", id: `tool-${index}`, name: "Read", arguments: { path: "example.ts" } }] })
    + entry({ role: "toolResult", toolCallId: `tool-${index}`, content: output })
    + entry({ role: "assistant", content: [{ type: "text", text: `Answer ${index}\n\nThe fictional change is ready. ${"This paragraph exercises wrapping on desktop and phone. ".repeat(3)}` }], stopReason: "stop" });
}

async function latestVisible(page: Page): Promise<unknown> {
  try {
    return await page.waitForFunction(() => window.loadingQa.sample.settled !== null, undefined, { timeout: 20_000 });
  } catch (error) {
    console.error(await page.evaluate(() => ({ sample: window.loadingQa.sample, text: document.querySelector(".chat-view")?.textContent, gap: (() => { const el = document.querySelector(".chat-view"); return el ? el.scrollHeight - el.clientHeight - el.scrollTop : null; })() })));
    throw error;
  }
}

/** Serialized into the fixture before the app mounts. The only network read is the owned server. */
function installProbe(pane: string): void {
  const demo = window.fetch;
  const native = Reflect.get(window, "loadingNativeFetch");
  if (typeof native !== "function") throw new Error("Missing fixture fetch");
  let release = () => {};
  let gate = Promise.resolve();
  const fresh = (): LoadingSample => ({ opened: 0, placeholder: null, composer: null, response: null, latest: null, settled: null, blankFrames: 0, firstMessage: null, longTasks: [] });
  const qa = window.loadingQa = {
    sample: fresh(), held: new URLSearchParams(location.search).has("hold"), reads: 0, expected: new URLSearchParams(location.search).get("expected") ?? "Answer 999",
    release: () => { qa.held = false; release(); },
  };
  if (qa.held) gate = new Promise<void>(resolve => { release = resolve; });
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname !== "/api/pane/conversation" || url.searchParams.get("pane_id") !== pane) return demo(input, init);
    qa.reads++;
    if (qa.held) await gate;
    const response: Response = await native(url.href, init);
    qa.sample.response ??= performance.now() - qa.sample.opened;
    return response;
  }, { preconnect: demo.preconnect });
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) qa.sample.longTasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
  let stable = 0;
  const frame = () => {
    const view = document.querySelector<HTMLElement>(".chat-view");
    if (view) {
      const sample = qa.sample;
      sample.opened ||= performance.now();
      const now = performance.now() - sample.opened;
      const placeholder = document.querySelector(".chat-loading-placeholder");
      if (placeholder) sample.placeholder ??= now;
      const composer = document.querySelector<HTMLTextAreaElement>(".composer-text");
      if (composer && !composer.disabled) sample.composer ??= now;
      const box = view.getBoundingClientRect();
      const rows = [...view.querySelectorAll<HTMLElement>("[data-chat-row]")].filter(row => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > box.top && rect.top < box.bottom && getComputedStyle(row).visibility !== "hidden";
      });
      if (rows.length > 0) sample.firstMessage ??= rows.map(row => row.textContent).join("\n");
      if (sample.latest === null && rows.length === 0 && placeholder === null) sample.blankFrames++;
      if (rows.some(row => row.textContent?.includes(qa.expected))) {
        sample.latest ??= now;
        if (view.scrollHeight - view.scrollTop - view.clientHeight <= 1) {
          if (++stable >= 2) sample.settled ??= now;
        } else stable = 0;
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
