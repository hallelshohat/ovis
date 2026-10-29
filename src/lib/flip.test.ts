import { describe, expect, it } from "bun:test";
import { flipDeltas } from "./flip.ts";

describe("list reorder motion", () => {
  it("moves only the rows that stayed and changed place, from where they were", () => {
    const before = new Map([["a", 0], ["b", 40], ["c", 80]]);
    const after = new Map([["b", 0], ["a", 40], ["c", 80], ["d", 120]]);
    expect([...flipDeltas(before, after)]).toEqual([["b", 40], ["a", -40]]);
  });

  it("leaves a list that did not move alone", () => {
    const rows = new Map([["a", 0], ["b", 40.4]]);
    expect(flipDeltas(rows, new Map([["a", 0], ["b", 40]])).size).toBe(0);
  });
});
