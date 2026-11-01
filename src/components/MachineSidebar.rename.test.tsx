import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { AppActions } from "../lib/actions.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { MachineSidebar } from "./MachineSidebar.tsx";

// Two PCs with no roster yet: each group draws its header and "No saved sessions", nothing that asks a server.
const pc = (id: string, name: string, kind: Machine["kind"], herdr = false): Machine =>
  ({ id, name, kind, enabled: true, state: "disconnected", snapshot: null, error: null, ...(herdr ? { herdr_profile_id: "profile" } : {}) } as Machine);
const machines = [pc("local", "workstation", "local"), pc("herdr:profile", "lab", "ssh", true)];
// a stand-in node: the menu asks its anchor where it is, the dialog focuses and selects its field
const node = { isConnected: true, focus() {}, select() {}, querySelector: () => null, closest: () => null, contains: () => true, getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 20, right: 200, width: 200, height: 20 }), getClientRects: () => [{}] };

describe("a remote PC renamed from its header's right-click menu", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let requests: { url: string; method: string; body: unknown }[];
  let answer: () => Response;

  beforeEach(() => {
    requests = [];
    answer = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "fetch", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init: RequestInit = {}) => {
      requests.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
      return answer();
    } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      innerWidth: 1440, innerHeight: 900,
      location: { href: "http://localhost/", origin: "http://localhost", pathname: "/" },
      history: { state: null, pushState() {}, replaceState() {}, back() {} },
      localStorage: globalThis.localStorage,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      // portals use the test renderer's host container, not a DOM renderer
      body: { nodeType: 1, children: [], createNodeMock: () => node },
      activeElement: null,
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function mount(watching = false) {
    const actions = { openSettings() {} } as unknown as AppActions;
    await act(async () => {
      renderer = create(<SettingsProvider>
        <MachineSidebar machines={machines} watching={watching} selectedMachineId="local" selectedPaneId={null} activity={{} as never} actions={actions}
          onSelect={() => {}} onNew={() => {}} onSetup={() => {}} onUsageLogin={() => {}} />
      </SettingsProvider>, { createNodeMock: () => node });
    });
    const mounted = renderer!;
    const header = (name: string): ReactTestInstance => mounted.root.find((found) => found.type === "section" && found.props["aria-label"] === `PC ${name}`).find((found) => found.type === "header");
    const rightClick = async (name: string) => {
      let prevented = false;
      await act(async () => { header(name).props.onContextMenu({ preventDefault: () => { prevented = true; }, currentTarget: node, clientX: 40, clientY: 12 }); });
      return prevented;
    };
    const menuItems = () => mounted.root.findAll((found) => found.type === "button" && found.props.role === "menuitem");
    const dialog = () => mounted.root.findAll((found) => found.type === "div" && found.props.role === "dialog" && found.props["aria-modal"] === "true");
    return { mounted, rightClick, menuItems, dialog };
  }

  it("offers Rename PC on a remote PC, and the dialog renames it through the server", async () => {
    const { mounted, rightClick, menuItems, dialog } = await mount();
    expect(await rightClick("lab")).toBe(true);
    expect(menuItems().map((item) => item.findByType("span").children.join(""))).toContain("Rename PC…");
    await act(async () => { menuItems()[0]!.props.onClick(); });
    expect(dialog()).toHaveLength(1);
    const input = mounted.root.find((found) => found.type === "input" && found.props.maxLength === 100 && found.props.value === "lab");
    await act(async () => { input.props.onChange({ target: { value: "  Lab box " } }); });
    const form = dialog()[0]!.findByType("form");
    await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
    expect(requests).toEqual([{ url: "/api/machines/herdr:profile", method: "PATCH", body: { name: "Lab box" } }]);
    expect(dialog()).toHaveLength(0);
  });

  it("keeps the dialog open with the server's refusal in it", async () => {
    answer = () => new Response(JSON.stringify({ error: { code: "machine_request_failed", message: "herdr could not rename this machine." } }), { status: 400, headers: { "content-type": "application/json" } });
    const { mounted, rightClick, menuItems, dialog } = await mount();
    await rightClick("lab");
    await act(async () => { menuItems()[0]!.props.onClick(); });
    const input = mounted.root.find((found) => found.type === "input" && found.props.value === "lab");
    await act(async () => { input.props.onChange({ target: { value: "Lab box" } }); });
    await act(async () => { await dialog()[0]!.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(dialog()).toHaveLength(1);
    expect(mounted.root.find((found) => found.props.role === "alert" && found.props.className === "confirm-error").children.join("")).toContain("could not rename");
  });

  it("leaves the Host's and a watching device's right-click to the browser", async () => {
    const own = await mount();
    expect(await own.rightClick("workstation")).toBe(false);
    expect(own.menuItems()).toHaveLength(0);
    await act(async () => { renderer?.unmount(); });
    const watching = await mount(true);
    expect(await watching.rightClick("lab")).toBe(false);
    expect(watching.menuItems()).toHaveLength(0);
  });
});
