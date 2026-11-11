/**
 * The PCs' order in the sidebar, the Agents list, the command palette and Settings: the shared
 * `machineOrder` setting (lib/settings.ts), so every device of this server shows the PCs alike.
 * It lists PC ids; a PC it does not name (one added since) follows them in the roster's order,
 * the Host first, then the PCs as the server lists them. A move writes the whole roster's order,
 * hidden PCs included, so a PC shown again comes back in its place.
 */

import { useCallback, useMemo, type RefObject } from "react";
import { useShownMachines } from "./hiddenMachines.ts";

interface HasId { id: string }

/** at most this many ids are kept; more are a hand-edited record */
export const MACHINE_ORDER_MAX = 64;

export type DropSide = "before" | "after";

/** The roster in the saved order: the ids it names first, as it names them, then the rest as the roster lists them. */
export function orderMachines<T extends HasId>(machines: readonly T[], order: readonly string[]): T[] {
  if (order.length === 0) return [...machines];
  const rank = new Map(order.map((id, index) => [id, index]));
  const listed = machines.filter((machine) => rank.has(machine.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...listed, ...machines.filter((machine) => !rank.has(machine.id))];
}

/**
 * The order after `id` is dropped `side` of `targetId`, over `ids` (every PC of the roster, in the
 * order shown). Null when nothing moves: an unknown PC, a drop on itself, or a drop where it already is.
 */
export function placeMachine(ids: readonly string[], id: string, targetId: string, side: DropSide): string[] | null {
  if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return null;
  const rest = ids.filter((known) => known !== id);
  const at = rest.indexOf(targetId) + (side === "after" ? 1 : 0);
  const next = [...rest.slice(0, at), id, ...rest.slice(at)];
  return next.every((known, index) => known === ids[index]) ? null : next.slice(0, MACHINE_ORDER_MAX);
}

/**
 * The order after `id` moves one place up (-1) or down (1) among the PCs `shown`, over `ids` (every
 * PC of the roster, in the order shown): it passes its shown neighbour, and a hidden PC between them
 * stays where it is. Null at either end.
 */
export function stepMachine(ids: readonly string[], shown: readonly string[], id: string, direction: -1 | 1): string[] | null {
  const neighbour = shown[shown.indexOf(id) + direction];
  if (!shown.includes(id) || neighbour === undefined) return null;
  return placeMachine(ids, id, neighbour, direction === 1 ? "after" : "before");
}

/**
 * The roster in the saved order (`ordered`: Settings lists every PC so), the PCs this device shows of
 * it (`shown`: lib/hiddenMachines.ts useShownMachines), and `move`, which saves an order a drag or a
 * button made (none: nothing moved).
 */
export function useOrderedMachines<T extends HasId>({ machines, order, save, ...shownOptions }: {
  machines: readonly T[];
  order: readonly string[];
  save: (order: string[]) => void;
  selectedMachineRef: RefObject<string>;
  selectTargetRef: RefObject<(machineId: string, paneId: string | null) => void>;
  picks: RefObject<number>;
  restored: boolean;
}): { ordered: T[]; shown: T[]; move: (next: string[] | null) => void } {
  const ordered = useMemo(() => orderMachines(machines, order), [machines, order]);
  const shown = useShownMachines({ machines: ordered, ...shownOptions });
  const move = useCallback((next: string[] | null) => { if (next !== null) save(next); }, [save]);
  return { ordered, shown, move };
}

/** Which half of a PC's group the pointer is over: its top half drops before it, its bottom half after. */
export function dropSide(pointerY: number, top: number, height: number): DropSide {
  return pointerY < top + height / 2 ? "before" : "after";
}
