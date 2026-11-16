import { expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { match } from "ts-pattern";
import { z } from "zod";
import * as codex from "./codex.ts";
import { codexToolActivityConflict } from "./codex-tool-match.ts";
import { resetCodexHistoryScans } from "./codex-history-scan.ts";
import { forgetTranscriptState } from "./conversation.ts";
import { createServer } from "./index.ts";

it("keeps cold Chat and health responsive while a large competing history warms, then reuses its prefix", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-history-latency-"));
  const home = join(root, "codex"), path = join(home, "sessions", "own.jsonl"), peer = join(root, "peer.jsonl");
  mkdirSync(join(home, "sessions"), { recursive: true });
  const answer = "The selected conversation remains correctly identified while unrelated histories are scanned in bounded background work.";
  writeFileSync(path, [
    { type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000001", cwd: root } },
    { type: "event_msg", payload: { type: "agent_message", message: answer } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const filler = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Unrelated archive: abcdefghijklmnopqrstuvwxyz 0123456789. ".repeat(18_000) } }) + "\n";
  writeFileSync(peer, "");
  for (let record = 0; record < 256; record++) appendFileSync(peer, filler);
  appendFileSync(peer, JSON.stringify({ type: "response_item", payload: {
    type: "function_call_output", call_id: "unrelated", output: "x".repeat(9 * 1024 * 1024),
  } }) + "\n");
  const screen = [
    "• Ran bun run verify --project /work/integration",
    "  └ Verification receipts: integration suite completed successfully with thirty seven isolated workers and zero leaked processes.",
    "", "• Ran git diff --stat -- src/verification",
    "  └ src/verification/pool.ts | 128 lines changed; scheduler cleanup and worker ownership assertions all passed independently.",
    "", "• Working (8m 29s • esc to interrupt)", "› ", "GPT-6-Astra high · /work", "? for shortcuts",
  ].join("\n");
  const socketBefore = process.env["HERDR_SOCKET"];
  const socketPath = join(root, "herdr.sock");
  const pane = { pane_id: "fixture", cwd: root, agent: "codex", agent_status: "working" };
  const rpc = z.object({ id: z.string(), method: z.string() });
  const daemon = Bun.listen<{ text: string }>({ unix: socketPath, socket: {
    open(socket) { socket.data = { text: "" }; },
    data(socket, bytes) {
      socket.data.text += bytes.toString();
      if (!socket.data.text.includes("\n")) return;
      const request = rpc.safeParse(JSON.parse(socket.data.text.split("\n")[0]!));
      if (!request.success) { socket.end(); return; }
      if (request.data.method === "events.subscribe") return;
      const result = match(request.data.method)
        .with("session.snapshot", () => ({ snapshot: { panes: [pane], agents: [], workspaces: [], tabs: [], layouts: [] } }))
        .with("agent.get", () => ({ agent: pane }))
        .with("pane.get", () => ({ pane }))
        .with("pane.process_info", () => ({ process_info: { foreground_processes: [{ pid: 2147483647, argv: ["codex"] }] } }))
        .with("pane.read", () => ({ read: { text: screen } }))
        .otherwise(() => ({})); // no-smell: RPC methods are open-ended; other initialization calls need no data.
      socket.end(JSON.stringify({ id: request.data.id, result }) + "\n");
    },
  } });
  // Discovery is already covered by the native binding contracts. The costly conflict scan,
  // HTTP pending response, transcript parser and retry below are the production implementations.
  let recheckReads = -1;
  const resolver = spyOn(codex, "codexTranscriptPath").mockImplementation(async () => {
    if (recheckReads >= 0 && ++recheckReads === 2) { recheckReads = -1; return null; }
    return await codexToolActivityConflict({ screen, segments: [{ path: peer, end: statSync(peer).size }] }) ? null : path;
  });
  let app: ReturnType<typeof createServer> | undefined;
  try {
    process.env["HERDR_SOCKET"] = socketPath;
    forgetTranscriptState();
    app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome: home, herdrProfiles: async () => [], registerBridge: false, tailscaleOwner: null });
    const base = `http://127.0.0.1:${app.port}`, url = `${base}/api/pane/conversation?pane_id=fixture&prompts=10`;
    const started = performance.now();
    const cold = await fetch(url);
    const coldMs = performance.now() - started;
    console.log(JSON.stringify({ case: "cold history", bytes: statSync(peer).size, status: cold.status, milliseconds: coldMs }));
    expect(cold.status).toBe(503);
    expect(cold.headers.get("cache-control")).toContain("no-store");
    expect(coldMs).toBeLessThan(500);
    expect(await cold.json()).toMatchObject({ error: { code: "conversation_read_pending" } });

    const ping = performance.now();
    const health = await fetch(`${base}/api/health?scope=bridge`);
    const healthMs = performance.now() - ping;
    expect(health.ok).toBe(true);
    expect(healthMs).toBeLessThan(500);
    await health.arrayBuffer();
    let ready: Response | undefined;
    while (performance.now() - started < 15_000) {
      const response = await fetch(url);
      if (response.status === 200) { ready = response; break; }
      expect(response.status).toBe(503);
      await response.arrayBuffer();
      await setImmediate();
    }
    expect(ready).toBeDefined();
    const body = z.object({ source: z.literal("codex-transcript"), history_id: z.string(), turns: z.array(z.object({ parts: z.array(z.object({ kind: z.string(), text: z.string().optional() })) })) }).safeParse(await ready!.json());
    expect(body.success).toBe(true);
    if (!body.success) throw new Error("invalid Chat fixture response");
    expect(body.data.turns.flatMap((turn) => turn.parts).some((part) => part.text === answer)).toBe(true);
    const readyMs = performance.now() - started;
    const repeat = performance.now();
    const warm = await fetch(url);
    const warmMs = performance.now() - repeat;
    expect(warm.status).toBe(200);
    expect(warmMs).toBeLessThan(500);
    await warm.arrayBuffer();
    appendFileSync(peer, filler);
    const appended = performance.now();
    const growing = await fetch(url);
    const appendMs = performance.now() - appended;
    expect(growing.status).toBe(200);
    expect(appendMs).toBeLessThan(500);
    await growing.arrayBuffer();
    const shown = `${url}&history_id=${encodeURIComponent(body.data.history_id)}`;
    recheckReads = 0;
    const lostRecheck = await fetch(shown);
    expect(lostRecheck.status).toBe(503);
    expect(await lostRecheck.json()).toMatchObject({ error: { code: "conversation_read_pending" } });
    const retriedRecheck = await fetch(shown);
    expect(retriedRecheck.status).toBe(200);
    expect(await retriedRecheck.json()).toMatchObject({ history_id: body.data.history_id, turns: body.data.turns });
    appendFileSync(peer, '{"type":"event_msg","payload":{"type":"agent_message","message":"');
    for (let attempt = 0; attempt < 3; attempt++) {
      const partial = await fetch(shown);
      expect(partial.status).toBe(503);
      expect(await partial.json()).toMatchObject({ error: { code: "conversation_read_pending" } });
    }
    appendFileSync(peer, 'Unrelated completed append."}}\n');
    const recovered = await fetch(shown);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ history_id: body.data.history_id, turns: body.data.turns });
    console.log(JSON.stringify({ case: "history latency", coldMs, healthMs, readyMs, warmMs, appendMs }));
  } finally {
    app?.stop();
    resolver.mockRestore();
    await resetCodexHistoryScans();
    daemon.stop(true);
    if (socketBefore === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = socketBefore;
    forgetTranscriptState();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
