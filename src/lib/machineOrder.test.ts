import { describe, expect, test } from "bun:test";
import { dropSide, MACHINE_ORDER_MAX, orderMachines, placeMachine, stepMachine } from "./machineOrder.ts";

const pcs = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (machines: { id: string }[]) => machines.map((machine) => machine.id);

describe("orderMachines", () => {
  test("no saved order keeps the roster's", () => {
    expect(ids(orderMachines(pcs("local", "a", "b"), []))).toEqual(["local", "a", "b"]);
  });

  test("the saved order comes first, the Host included, and a PC it does not name follows in roster order", () => {
    expect(ids(orderMachines(pcs("local", "a", "b", "c"), ["b", "local"]))).toEqual(["b", "local", "a", "c"]);
  });

  test("an id no PC has any more is skipped", () => {
    expect(ids(orderMachines(pcs("local", "a"), ["gone", "a", "local"]))).toEqual(["a", "local"]);
  });
});

describe("placeMachine", () => {
  test("drops a PC before or after another", () => {
    expect(placeMachine(["local", "a", "b"], "b", "local", "before")).toEqual(["b", "local", "a"]);
    expect(placeMachine(["local", "a", "b"], "local", "b", "after")).toEqual(["a", "b", "local"]);
    expect(placeMachine(["local", "a", "b"], "local", "a", "after")).toEqual(["a", "local", "b"]);
  });

  test("a drop that changes nothing is none", () => {
    expect(placeMachine(["local", "a", "b"], "a", "a", "before")).toBeNull();
    expect(placeMachine(["local", "a", "b"], "a", "b", "before")).toBeNull();
    expect(placeMachine(["local", "a", "b"], "a", "local", "after")).toBeNull();
    expect(placeMachine(["local", "a"], "gone", "a", "before")).toBeNull();
    expect(placeMachine(["local", "a"], "a", "gone", "before")).toBeNull();
  });

  test("the order kept is bounded", () => {
    const many = Array.from({ length: MACHINE_ORDER_MAX + 5 }, (_, index) => `pc${index}`);
    expect(placeMachine(many, "pc1", "pc0", "before")).toHaveLength(MACHINE_ORDER_MAX);
  });
});

describe("stepMachine", () => {
  test("moves past the shown neighbour, leaving a hidden PC between them in place", () => {
    // "h" is hidden on this device
    expect(stepMachine(["local", "h", "a"], ["local", "a"], "a", -1)).toEqual(["a", "local", "h"]);
    expect(stepMachine(["local", "h", "a"], ["local", "a"], "local", 1)).toEqual(["h", "a", "local"]);
  });

  test("none at either end", () => {
    expect(stepMachine(["local", "a"], ["local", "a"], "local", -1)).toBeNull();
    expect(stepMachine(["local", "a"], ["local", "a"], "a", 1)).toBeNull();
    expect(stepMachine(["local", "a"], ["local"], "a", -1)).toBeNull();
  });
});

test("dropSide: the top half drops before, the bottom half after", () => {
  expect(dropSide(10, 0, 40)).toBe("before");
  expect(dropSide(30, 0, 40)).toBe("after");
});
