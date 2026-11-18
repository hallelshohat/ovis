/** Native history discovery -> real herdr -> HTTP -> Chat while a replay writer keeps working. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { z } from "zod";
import { createServer } from "../server/index.ts";
import { hasCodexToolActivity } from "../server/codex-tool-match.ts";
import { herdrRpc, paneRead, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { shellQuote } from "../server/machine-security.ts";
import { chromePath } from "./chrome-path.ts";
import { appFaces } from "./app-faces.ts";

await checkCodexPendingRecovery();

async function checkCodexPendingRecovery(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "codex-pending-"));
  const home = join(root, "codex"), progressPath = join(root, "progress.json");
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
  const paths = ids.map((id) => join(home, "sessions", `rollout-${id}.jsonl`));
  const progressSchema = z.object({ sequence: z.number(), time: z.number() });
  const progress = () => {
    const parsed = progressSchema.safeParse(JSON.parse(readFileSync(progressPath, "utf8")));
    assert(parsed.success, "writer published its progress");
    return parsed.data;
  };
  const evidence = process.env.UI_EVIDENCE_DIR;
  let workspaceId: string | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let writer: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;
  try {
    mkdirSync(join(home, "sessions"), { recursive: true });
    mkdirSync(join(home, "thread-writer-locks"));
    mkdirSync(join(root, "bin"));
    if (evidence) mkdirSync(evidence, { recursive: true });
    const db = new Database(join(home, "state_5.sqlite"));
    try {
      db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT)");
      for (const [index, id] of ids.entries()) {
        const cwd = index === 0 ? root : join(root, `peer-${index}`);
        db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli')").run(id, paths[index]!, cwd);
        writeFileSync(paths[index]!, JSON.stringify({ type: "session_meta", payload: { id, cwd, source: "cli" } }) + "\n");
      }
    } finally { db.close(); }
    const archive = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Ran 1 test across 1 file. " + "Unrelated archive && true: abcdefghijklmnopqrstuvwxyz 0123456789. ".repeat(18_000) } }) + "\n";
    for (const peer of paths.slice(1)) for (let record = 0; record < 256; record++) appendFileSync(peer, archive);
    writeFileSync(join(root, "writer.py"), replayWriter());
    writer = Bun.spawn(["python3", join(root, "writer.py"), root, ...ids], { stdout: "pipe", stderr: "inherit" });
    const reader = writer.stdout.getReader();
    try {
      const ready = await reader.read();
      assert(!ready.done && new TextDecoder().decode(ready.value).includes("READY"), "native writer acquired its locks");
    } finally { reader.releaseLock(); }
    const terminal = join(root, "terminal.cjs");
    writeFileSync(terminal, `const fs = require("node:fs"); const screen = process.argv[2]; process.stdin.resume(); setInterval(() => process.stdout.write("\\x1b[2J\\x1b[H" + fs.readFileSync(screen, "utf8")), 100);`);
    const created = await workspaceCreate({ cwd: root, label: "Codex pending recovery replay" });
    workspaceId = created.workspace.workspace_id;
    const paneId = created.root_pane.pane_id;
    const node = Bun.which("node");
    assert(node);
    const command = `CODEX_HOME=${shellQuote(home)} bash -c ${shellQuote(`exec -a ${shellQuote(join(root, "bin/codex"))} ${shellQuote(node)} ${shellQuote(terminal)} ${shellQuote(join(root, "screen.txt"))}`)}`;
    await herdrRpc("pane.send_text", { pane_id: paneId, text: command + "\n" });
    const deadline = Date.now() + 10_000;
    while (!(await paneRead({ paneId, source: "recent", lines: 100, stripAnsi: true })).text.includes("recovery_probe")) {
      if (Date.now() > deadline) throw new Error("replay terminal did not start");
      await Bun.sleep(25);
    }
    const screen = (await paneRead({ paneId, source: "recent", lines: 100, stripAnsi: true })).text;
    assert(hasCodexToolActivity(screen), `fixture has two identifying tool previews: ${screen}`);
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "working" });
    server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome: home, tailscaleOwner: null, registerBridge: false });
    browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US", serviceWorkers: "block" });
    page.setDefaultTimeout(30_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript((id) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`ovis:view:${id}`, "chat");
    }, paneId);
    const requests: { status: number; request: string | null; sequence: number; ownBytes: number; time: number }[] = [];
    page.on("response", response => {
      const url = new URL(response.url());
      if (url.pathname !== "/api/pane/conversation" || url.searchParams.get("pane_id") !== paneId) return;
      requests.push({ status: response.status(), request: response.headers()["x-request-id"] ?? null, sequence: progress().sequence, ownBytes: statSync(paths[0]!).size, time: Date.now() });
      console.log(JSON.stringify(requests.at(-1)));
    });
    const url = `http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}`;
    const conversation = (status: number) => page.waitForResponse(response => new URL(response.url()).pathname === "/api/pane/conversation" && response.status() === status);
    let history: string | undefined;
    const view = page.locator('.chat-view[role="log"]');
    for (const phase of ["cold", "live"] as const) {
      let retained: { top: number; rows: string[] } | undefined;
      if (phase === "live") {
        const viewport = await view.boundingBox();
        assert(viewport);
        await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
        await page.mouse.wheel(0, -720);
        await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
        await appFaces(page);
        retained = { top: await view.evaluate(el => el.scrollTop), rows: await view.locator("[data-chat-row]").allTextContents() };
        assert(retained.rows.length > 0);
      }
      const pending = conversation(503);
      if (phase === "cold") await page.goto(url);
      else writeFileSync(join(root, "load-peer"), "load");
      await pending;
      const before = progress();
      const composer = page.locator(".composer-text");
      await composer.fill("Keep this draft while native history catches up");
      await appFaces(page);
      assert.equal(await page.locator(".chat-failure").count(), 0, "a native pending response keeps Chat readable");
      if (retained) {
        assert.deepEqual(await view.locator("[data-chat-row]").allTextContents(), retained.rows, "native pending keeps the displayed rows");
        assert(Math.abs(await view.evaluate(el => el.scrollTop) - retained.top) <= 1, "native pending keeps the reading position");
      }
      assert.equal(await page.locator(".chat-frame[data-pane-content]").count(), 0, "pending cannot mark the history read");
      const response = await conversation(200);
      const schema = z.object({ source: z.literal("codex-transcript"), history_id: z.string(), turns: z.array(z.object({ parts: z.array(z.object({ kind: z.string() })) })) });
      const payload = await response.json();
      if (evidence) writeFileSync(join(evidence, `native-pending-${phase}.json`), JSON.stringify(payload));
      const parsed = schema.safeParse(payload);
      assert(parsed.success, `native discovery returned a conversation: ${JSON.stringify(parsed.error?.issues)}`);
      assert(parsed.data.turns.some(turn => turn.parts.some(part => part.kind === "tool")));
      history ??= parsed.data.history_id;
      assert.equal(parsed.data.history_id, history, "discovery retains the same conversation");
      assert(progress().sequence > before.sequence, "tool completions continued between pending and recovery");
      await page.getByText("Loading conversation…", { exact: true }).waitFor({ state: "hidden" });
      assert.equal(await composer.inputValue(), "Keep this draft while native history catches up");
      assert.equal(await page.locator(".chat-failure").count(), 0);
      if (retained) assert(Math.abs(await view.evaluate(el => el.scrollTop) - retained.top) <= 1, "recovery keeps the reading position");
      const recoveredAt = progress().sequence;
      await conversation(200);
      assert(progress().sequence > recoveredAt, "work continues after recovery");
      if (evidence) await page.screenshot({ path: join(evidence, `native-pending-${phase}.png`) });
      console.log(`PASS ${phase} native pending recovery while writer advanced ${before.sequence} -> ${progress().sequence}`);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ requests, peerBytes: paths.slice(1).map(path => statSync(path).size) }));
    if (evidence) writeFileSync(join(evidence, "native-pending-requests.json"), JSON.stringify(requests, null, 2));
  } finally {
    await browser?.close();
    server?.stop();
    if (workspaceId) await workspaceClose(workspaceId);
    writer?.kill();
    await writer?.exited;
    rmSync(root, { recursive: true, force: true });
  }
}

function replayWriter(): string { return String.raw`import fcntl, json, os, sys, time
root, own, peer, later = sys.argv[1:]
home = os.path.join(root, 'codex')
locks = []
def hold(identity):
    handle = open(os.path.join(home, 'thread-writer-locks', identity + '.lock'), 'a+')
    fcntl.flock(handle, fcntl.LOCK_EX)
    locks.append(handle)
def append(identity, payload):
    with open(os.path.join(home, 'sessions', 'rollout-' + identity + '.jsonl'), 'a') as out:
        out.write(json.dumps({'type': 'event_msg', 'timestamp': '2026-11-16T10:00:00Z', 'payload': payload}) + '\n')
def completed(sequence):
    command = 'printf recovery_probe && true'
    output = 'Probe' + str(sequence) + ' abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 verified\nRan 1 test across 1 file.'
    append(own, {'type': 'item_completed', 'item': {'type': 'CommandExecution', 'id': 'probe-' + str(sequence), 'command': ['/bin/sh', '-c', command], 'cwd': root, 'parsed_cmd': [], 'status': 'completed', 'aggregated_output': output, 'exit_code': 0}})
    append(own, {'type': 'token_count', 'sequence': sequence})
    return '• Ran ' + command + '\n  └ ' + output.replace('\n', '\n    ')
hold(own)
hold(peer)
for turn in range(30):
    append(own, {'type': 'task_started', 'turn_id': 'history-' + str(turn)})
    append(own, {'type': 'user_message', 'message': 'Earlier verification task ' + str(turn)})
    for call in range(40): completed(-1200 + turn * 40 + call)
    append(own, {'type': 'agent_message', 'message': 'Earlier verification finished ' + str(turn)})
    append(own, {'type': 'task_complete', 'turn_id': 'history-' + str(turn)})
append(own, {'type': 'task_started', 'turn_id': 'live'})
append(own, {'type': 'user_message', 'message': 'Keep checking the native recovery while work continues.'})
frames = [completed(0), completed(1)]
sequence = 1
loaded_later = False
started = time.monotonic()
while time.monotonic() - started < 90:
    sequence += 1
    frames = [frames[-1], completed(sequence)]
    if not loaded_later and os.path.exists(os.path.join(root, 'load-peer')):
        hold(later)
        loaded_later = True
    append(peer, {'type': 'token_count', 'sequence': sequence})
    if loaded_later: append(later, {'type': 'token_count', 'sequence': sequence})
    for name, text in [('screen.txt', '\n\n'.join(frames) + '\n\n• Working (8m 29s • esc to interrupt)\n› \nGPT-6-Astra high · /fixture\n? for shortcuts\n'), ('progress.json', json.dumps({'sequence': sequence, 'time': time.time()}))]:
        with open(os.path.join(root, name + '.new'), 'w') as out: out.write(text)
        os.replace(os.path.join(root, name + '.new'), os.path.join(root, name))
    if sequence == 2: print('READY', flush=True)
    time.sleep(0.25)
`; }
