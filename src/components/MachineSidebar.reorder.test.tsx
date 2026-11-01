import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { AppActions } from "../lib/actions.ts";
import type { DropSide } from "../lib/machineOrder.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { MachineSidebar } from "./MachineSidebar.tsx";

// Two PCs with no roster yet: each group draws its header and "No saved sessions", nothing that asks a server.
const pc = (id: string, name: string, kind: Machine["kind"]): Machine => ({ id, name, kind, enabled: true, state: "disconnected", snapshot: null, error: null } as Machine);
const machines = [pc("local", "workstation", "local"), pc("lab", "lab", "ssh")];

/** a drag's data as the browser hands it to each handler; `types` is all a dragover may read */
function transfer(types: string[], data: Record<string, string> = {}) {
  const held = { ...data };
  return {
    types, effectAllowed: "", dropEffect: "",
    setData(type: string, value: string) { held[type] = value; if (!types.includes(type)) types.push(type); },
    getData: (type: string) => held[type] ?? "",
  };
}
const box = { top: 100, height: 40, left: 0, width: 200, bottom: 140, right: 200 };

describe("a PC dragged by its header in the sidebar", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let coarse = false;

  beforeEach(() => {
    coarse = false;
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      matchMedia: (query: string) => ({ matches: query === "(pointer: coarse)" ? coarse : false, addEventListener() {}, removeEventListener() {} }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      location: { href: "http://localhost/" },
      localStorage: globalThis.localStorage,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      body: { nodeType: 1, children: [] },
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
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

  async function mount(onMove?: (id: string, targetId: string, side: DropSide) => void) {
    const actions = { openSettings() {} } as unknown as AppActions;
    await act(async () => {
      renderer = create(<SettingsProvider>
        <MachineSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} activity={{} as never} actions={actions}
          onSelect={() => {}} onNew={() => {}} onSetup={() => {}} onUsageLogin={() => {}} onMove={onMove} />
      </SettingsProvider>, { createNodeMock: () => ({ getBoundingClientRect: () => box, contains: () => false, focus() {} }) });
    });
    const mounted = renderer!;
    const group = (name: string): ReactTestInstance => mounted.root.find((node) => node.type === "section" && node.props["aria-label"] === `PC ${name}`);
    const header = (name: string): ReactTestInstance => group(name).find((node) => node.type === "header");
    return { group, header };
  }

  it("drops a PC after the one whose bottom half it is let go over, with a line there while it is held", async () => {
    const moves: [string, string, DropSide][] = [];
    const { group, header } = await mount((...move) => moves.push(move));
    expect(header("workstation").props.draggable).toBe(true);
    const data = transfer([]);
    const target = { getBoundingClientRect: () => box, contains: () => false };
    await act(async () => { header("workstation").props.onDragStart({ dataTransfer: data, target: "header", currentTarget: "header" }); });
    expect(group("workstation").props.className).toContain("is-dragging");
    let prevented = false;
    await act(async () => { group("lab").props.onDragOver({ dataTransfer: data, clientY: 135, currentTarget: target, preventDefault: () => { prevented = true; } }); });
    expect(prevented).toBe(true);
    expect(group("lab").props["data-drop"]).toBe("after");
    await act(async () => { group("lab").props.onDrop({ dataTransfer: data, clientY: 135, currentTarget: target, preventDefault() {} }); });
    expect(moves).toEqual([["local", "lab", "after"]]);
    expect(group("lab").props["data-drop"]).toBeUndefined();
    expect(group("workstation").props.className).not.toContain("is-dragging");
  });

  it("leaves a workspace's or a pane's drag over a PC to the rows under it", async () => {
    const moves: unknown[] = [];
    const { group } = await mount((...move) => moves.push(move));
    const data = transfer(["application/x-herdr-workspace"], { "application/x-herdr-workspace": "{}" });
    let prevented = false;
    const target = { getBoundingClientRect: () => box, contains: () => false };
    await act(async () => { group("lab").props.onDragOver({ dataTransfer: data, clientY: 105, currentTarget: target, preventDefault: () => { prevented = true; } }); });
    await act(async () => { group("lab").props.onDrop({ dataTransfer: data, clientY: 105, currentTarget: target, preventDefault: () => { prevented = true; } }); });
    expect(prevented).toBe(false);
    expect(moves).toEqual([]);
  });

  it("is not draggable for a watching device, nor on a touch screen", async () => {
    const watching = await mount(undefined);
    expect(watching.header("workstation").props.draggable).toBe(false);
    await act(async () => { renderer?.unmount(); });
    coarse = true;
    const touch = await mount(() => {});
    expect(touch.header("lab").props.draggable).toBe(false);
  });
});
