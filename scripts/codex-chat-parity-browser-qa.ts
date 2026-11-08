/** Recorded Codex 0.167.0 -> real server -> Chat, in an owned fixture pane. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { shellQuote } from "../server/machine-security.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "codex-parity-"));
const fixture = (name: string) => readFileSync(join(import.meta.dir, "../server/fixtures/codex-chat-parity", name), "utf8");
const lines = fixture("0.167.0.jsonl").trimEnd().split("\n");
const retry = lines.findIndex((line) => line.includes("The missing codex-code-mode-host is now installed"));
const start = lines.slice(0, retry).map((line, index) => line.includes('"type":"task_started"') ? index : -1).filter((index) => index >= 0).at(-1)!;
const steering = lines.findIndex((line) => line.includes("OVS24_CURRENT_STEER:"));
assert(start >= 0 && steering > start, "recording includes the real retry and steering");
const codexHome = join(root, "codex");
const rollout = join(codexHome, "sessions", "rollout.jsonl");
const screen = join(root, "screen.txt");
const evidence = process.env["UI_EVIDENCE_DIR"];
let workspaceId: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const header = JSON.stringify({ type: "session_meta", payload: { id: "01a1ba42-c8a1-73f0-a727-5b7ad14ddc2f", cwd: root } });
  const persist = (end: number) => writeFileSync(rollout, [header, ...lines.slice(start, end)].join("\n") + "\n");
  persist(steering);
  writeFileSync(screen, fixture("0.167.0-steering.txt"));
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, updated_at INTEGER)");
  db.query("INSERT INTO threads VALUES (?, ?, 0, NULL, 1)").run(rollout, root);
  db.close();
  mkdirSync(join(root, "bin"));
  const executable = join(root, "bin/codex");
  writeFileSync(executable, '#!/bin/sh\nexec 3<"$1"\nprintf "\\033[2J\\033[H"\ncat "$2"\nwhile IFS= read -r line; do printf "\\033[2J\\033[H"; cat "$2"; done\n');
  chmodSync(executable, 0o755);
  const created = await workspaceCreate({ cwd: root, label: "Codex parity recording" });
  workspaceId = created.workspace.workspace_id;
  const paneId = created.root_pane.pane_id;
  const showScreen = async (text: string) => {
    writeFileSync(screen, text);
    await herdrRpc("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
  };
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `${shellQuote(executable)} ${shellQuote(rollout)} ${shellQuote(screen)}\n` });
  const deadline = Date.now() + 10_000;
  while ((await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.agent !== "codex") {
    if (Date.now() > deadline) throw new Error("fixture Codex was not detected");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "working" });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome, tailscaleOwner: null });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((id) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`ovis:view:${id}`, "chat");
  }, paneId);
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}`);
  const log = page.locator(`.pane-frame[data-layout-pane="${paneId}"]`).getByRole("log");
  await log.getByText("Steering · current turn", { exact: true }).waitFor();
  const steerText = "OVS24_CURRENT_STEER: include indigo in the final reply. Keep waiting for release167.";
  assert.equal(await log.getByText(steerText, { exact: true }).count(), 1);
  await log.locator(".chat-diff-add").filter({ hasText: "+gamma=4" }).waitFor({ state: "attached" });
  assert.match(await log.innerText(), /OVS24_CURRENT_STDERR/);
  assert.match(await log.innerText(), /exit 9/);
  assert.equal(await log.locator('.work-block-head[aria-expanded="false"]').count(), 0, "native work remains visible");
  assert.equal(await log.locator('.work-row-line > .work-row-head[aria-expanded="true"]').count(), 0, "native and pending tool arguments start collapsed while their results remain visible");
  assert.equal(await log.locator(".chat-turn-duration").count(), 0, "steering does not end its native task");
  const capture = async (name: string) => {
    if (!evidence) return;
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, `${name}.png`), animations: "disabled" });
  };
  await capture("steering-pending");
  const edit = log.locator(".work-row").filter({ has: page.locator(".chat-diff-add").filter({ hasText: "+gamma=4" }) });
  for (const expanded of [true, false]) {
    await edit.locator(".work-row-head").click();
    assert.equal(await edit.locator(".work-row-head").getAttribute("aria-expanded"), String(expanded));
    assert.equal(await edit.locator(".chat-diff-add").filter({ hasText: "+gamma=4" }).count(), 1, "toggling arguments keeps one visible diff");
  }
  await page.locator(".composer-text").focus();
  await log.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  console.log("PASS recorded reads, edits, outputs, exit status and pending steering");

  // Variations of the recording cover message contents and a second unsent terminal draft.
  const bullets = fixture("0.167.0-steering.txt").replace(/  ↳ OVS24_CURRENT_STEER:[^\n]+/, "  ↳ OVS24_BULLETS:\n    • alpha\n    • beta");
  for (const [name, frame] of [["pending-bullets", bullets], ["pending-draft", bullets.replace("› Ask Codex to do anything", "› Another unsent draft\n  with a second line").replace("Working (29s", "Working (30s")]]) {
    await showScreen(frame!);
    const pending = log.locator(".chat-turn-waiting").filter({ hasText: "OVS24_BULLETS:" });
    await pending.waitFor();
    await page.locator(".chat-codex-status").filter({ hasText: name === "pending-draft" ? "Working (30s" : "Working (29s" }).waitFor();
    assert.match(await pending.innerText(), /• alpha/);
    assert.match(await pending.innerText(), /• beta/);
    assert.equal(await log.locator(".chat-turn-waiting").count(), 1);
    await capture(name!);
  }
  console.log("PASS pending bullet lists and an additional native draft");

  // The native queue is live terminal state; changing it does not invent a transcript message.
  await showScreen(fixture("0.167.0-queued.txt"));
  try { await log.getByText("Queued · next turn", { exact: true }).waitFor(); }
  catch (error) {
    console.error(await (await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`)).text());
    console.error(await herdrRpc("pane.read", { pane_id: paneId, source: "detection", format: "text" }));
    await capture("queue-failed");
    throw error;
  }
  await capture("native-queued");
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), delivered = Promise.withResolvers<void>();
  let delayed = false;
  await page.route("**/api/pane/prompt?**", async (route) => {
    if (delayed) { await route.continue(); return; }
    delayed = true;
    const response = await route.fetch();
    held.resolve();
    await release.promise;
    await route.fulfill({ response });
    delivered.resolve();
  });
  await held.promise;
  try {
    persist(lines.length);
    await showScreen(fixture("0.167.0-plan.txt"));
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "idle" });
    await log.getByText("turquoise", { exact: true }).waitFor();
  } finally { release.resolve(); }
  await delivered.promise;
  assert.equal(await log.getByText(steerText, { exact: true }).count(), 1);
  assert.equal(await log.locator(".chat-turn-waiting").count(), 0);
  assert.equal(await log.getByRole("heading", { name: "Two-step plan: Validate notes.txt", exact: true }).count(), 1);
  await page.getByText("Implement this plan?", { exact: true }).first().waitFor();
  assert.equal(await log.locator(".chat-turn-waiting").count(), 0, "a late pending response cannot resurrect the accepted message");
  await capture("consumed-and-plan");
  console.log("PASS steering consumption, queued reply and native plan prompt");

  writeFileSync(rollout, [header, ...lines.slice(start), fixture("0.167.0-mixed-image.jsonl")].join("\n") + "\n");
  await showScreen("› Ask Codex to do anything\nGPT-6-Luna medium · /workspace/codex-parity\n");
  await page.getByText("Implement this plan?", { exact: true }).first().waitFor({ state: "hidden" });
  await log.getByText("DONE_IMAGE", { exact: true }).waitFor();
  const viewed = log.locator(".work-row-head").filter({ hasText: "Viewed image" });
  await viewed.waitFor();
  assert.equal(await viewed.count(), 1);
  assert.match(await viewed.innerText(), /probe\.png/);
  assert.equal(await log.locator(".chat-tool-output pre").filter({ hasText: /^IMAGE_COMMAND$/ }).count(), 1);
  const picture = log.locator(".chat-tool-images img");
  await picture.waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>(".chat-tool-images img");
    return image !== null && image.complete && image.naturalWidth === 192;
  });
  assert.equal(await picture.count(), 1, "the exec wrapper retains one loaded image beside its native command and image-view action");
  const imageRow = log.locator(".work-row").filter({ has: page.locator(".chat-tool-images img") });
  const imageHead = imageRow.locator(".work-row-head");
  const rawInput = imageRow.locator(".work-row-detail > pre.chat-tool-io");
  assert.equal(await imageHead.getAttribute("aria-expanded"), "false");
  assert.equal(await rawInput.count(), 0, "the wrapper's JavaScript is hidden by default");
  await imageHead.click();
  await rawInput.waitFor();
  assert.match(await rawInput.innerText(), /tools\.view_image/);
  await imageHead.click();
  assert.equal(await rawInput.count(), 0);
  assert.equal(await picture.isVisible(), true, "closing arguments keeps the returned image visible");
  assert.equal(await log.locator(".chat-tool-output pre").filter({ hasText: /^IMAGE_COMMAND$/ }).isVisible(), true);
  await picture.scrollIntoViewIfNeeded();
  await capture("mixed-image");
  console.log("PASS recorded mixed command/image output and native Viewed image action");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await capture("mobile");
  assert.deepEqual(errors, []);
  console.log("PASS mobile layout and no browser errors");
} finally {
  await browser?.close();
  server?.stop(true);
  if (workspaceId) await workspaceClose(workspaceId);
  rmSync(root, { recursive: true, force: true });
}
