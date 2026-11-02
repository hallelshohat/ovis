import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { BackgroundTaskOutput, emptyOutput, mergeOutput, OUTPUT_KEEP_CHARS, OUTPUT_POLL_MS } from "./BackgroundTaskOutput.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import type { PaneBackgroundOutput } from "../../shared/protocol.ts";

const view = (running: boolean) => createElement(SettingsProvider, { children: createElement(BackgroundTaskOutput, { paneId: "w1:p1", taskId: "b1", running }) });

const read = (text: string, start: number, extra: Partial<PaneBackgroundOutput> = {}) => ({ text, start, offset: start + text.length, reset: false, gone: false, ...extra });

describe("mergeOutput", () => {
  test("appends what was read since, and a reset read replaces it", () => {
    const first = mergeOutput(emptyOutput(), read("one\n", 0, { reset: true }));
    expect(first).toEqual({ text: "one\n", offset: 4, dropped: false, gone: false });
    const second = mergeOutput(first, read("two\n", 4));
    expect(second.text).toBe("one\ntwo\n");
    expect(mergeOutput(second, read("new\n", 0, { reset: true })).text).toBe("new\n");
  });

  test("says the start is left out when the first read was a tail", () => {
    expect(mergeOutput(emptyOutput(), read("tail\n", 900, { reset: true })).dropped).toBe(true);
  });

  test("keeps a bounded buffer, cut at a line's start", () => {
    const line = `${"x".repeat(99)}\n`;
    let buffer = emptyOutput();
    for (let at = 0; at < (OUTPUT_KEEP_CHARS / 100) + 50; at++) buffer = mergeOutput(buffer, read(line, at * 100));
    expect(buffer.text.length).toBeLessThanOrEqual(OUTPUT_KEEP_CHARS);
    expect(buffer.text.startsWith("x")).toBe(true);
    expect(buffer.dropped).toBe(true);
  });

  test("keeps what it has when the output is gone", () => {
    const kept = mergeOutput(emptyOutput(), read("a\n", 0));
    expect(mergeOutput(kept, read("", 2, { gone: true }))).toMatchObject({ text: "a\n", gone: true });
  });
});

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ ...listen, matches: false }) },
    document: { ...listen, visibilityState: "visible", documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  });
  jest.useFakeTimers();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  jest.useRealTimers();
  jest.restoreAllMocks();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

/** the output the PC answers with, grown between reads; every query it was asked */
function serve(chunks: string[]) {
  const asked: string[] = [];
  let written = "";
  jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://x");
    asked.push(url.search);
    if (chunks.length > 0) written += chunks.shift();
    const raw = url.searchParams.get("offset");
    const from = raw === null ? 0 : Number(raw);
    return Response.json({ task_id: "b1", text: written.slice(from), start: from, offset: written.length, size: written.length, reset: raw === null, gone: false, server_time: "" } satisfies PaneBackgroundOutput);
  }, globalThis.fetch));
  return asked;
}

const text = (): string => renderer!.root.findAll((node) => node.props.className === "bg-output-line").map((line) => line.children.flatMap((span) => typeof span === "string" ? [span] : span.children.filter((child) => typeof child === "string")).join("")).join("");

test("streams a running task's output, reading on from where it stopped, in its colours", async () => {
  const asked = serve(["\x1b[32mok\x1b[0m one\n", "two\n"]);
  await act(async () => { renderer = create(view(true)); });
  expect(text()).toBe("ok one\n");
  expect(renderer!.root.findAll((node) => node.props.className === "ansi-fg-2").length).toBe(1);
  await act(async () => { jest.advanceTimersByTime(OUTPUT_POLL_MS); });
  expect(text()).toBe("ok one\ntwo\n");
  expect(asked[0]).not.toContain("offset");
  expect(asked[1]).toContain("offset=");
});

test("stops reading once the task has ended", async () => {
  const asked = serve(["done\n"]);
  await act(async () => { renderer = create(view(false)); });
  await act(async () => { jest.advanceTimersByTime(OUTPUT_POLL_MS * 5); });
  expect(asked).toHaveLength(1);
  expect(text()).toBe("done\n");
});
