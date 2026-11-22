import { nonblank, type SidebarAgent } from "../../shared/agent-roster.ts";
import type { AgentStatus, HerdrPane, TabInfo } from "../../shared/protocol.ts";
import { customTabLabel, tabLabel } from "./tabName.ts";
import { paneStatus, rollupStatus, type KnownStatus } from "./status.ts";

export { sidebarAgents, type SidebarAgent } from "../../shared/agent-roster.ts";

/** A shell beside an agent is not unfinished agent work; shell-only groups keep their pane state. */
export function rollupAgentStatus({ panes, agentRows, statusOf = paneStatus }: {
  panes: readonly HerdrPane[];
  agentRows: readonly SidebarAgent[];
  statusOf?: (pane: HerdrPane) => AgentStatus | undefined;
}): KnownStatus {
  const agentIds = new Set(agentRows.map(({ pane }) => pane.pane_id));
  const agents = panes.filter((pane) => agentIds.has(pane.pane_id));
  const own = agents.length > 0 ? agents : panes;
  const status = rollupStatus(own.map(paneStatus));
  if (status !== "done") return status;
  // Reading a finish changes its mark, not whether that agent completed its work.
  return own.some((pane) => statusOf(pane) === "done") ? "done" : "idle";
}

export function paneMark(entry: SidebarAgent | undefined): string | null {
  if (!entry) return null;
  return entry.canonicalAgent ?? entry.agentLabel ?? "";
}

export function titleOnlyNamesAgent(title: string, names: readonly (string | null | undefined)[]): boolean {
  const plain = (text: string): string => text.replace(/^[^\p{L}\p{N}]+/u, "").trim().toLowerCase();
  const said = plain(title);
  return said !== "" && names.some((name) => typeof name === "string" && plain(name) === said);
}

export function workspaceAgentLabels(agents: readonly SidebarAgent[]): Map<string, string[]> {
  const byWorkspace = new Map<string, string[]>();
  for (const { workspace, agentLabel, canonicalAgent } of agents) {
    const label = agentLabel ?? canonicalAgent;
    if (!label) continue;
    const labels = byWorkspace.get(workspace.workspace_id) ?? [];
    if (!labels.includes(label)) labels.push(label);
    byWorkspace.set(workspace.workspace_id, labels);
  }
  return byWorkspace;
}

/**
 * The tab an agent row names, as herdr's agents panel does: only when its workspace has two or
 * more tabs or the tab was renamed. A tab is judged by its place in the row, not its number:
 * herdr relabels the tab that moves up when the one before it closes, and keeps its number.
 */
export function agentTabName(tab: TabInfo | null | undefined, workspaceTabs: readonly TabInfo[], t: Parameters<typeof tabLabel>[1]): string | null {
  if (!tab) return null;
  const place = workspaceTabs.findIndex((candidate) => candidate.tab_id === tab.tab_id) + 1 || tab.number;
  return workspaceTabs.length > 1 || customTabLabel(tab, place) ? tabLabel(tab, t, place) : null;
}

export interface AgentContextParts {
  agentLabel: string | null;
  title: string;
  markAgent: string | null;
  /** null with a single PC: herdr does not name a lone machine either */
  machineName: string | null;
  workspaceLabel: string;
  tabName: string | null;
}

export function agentContext({ agentLabel, title, markAgent, machineName, workspaceLabel, tabName }: AgentContextParts): string[] {
  const agent = nonblank(agentLabel);
  const tab = nonblank(tabName);
  return [
    agent && agent !== title.trim() && agent.toLowerCase() !== markAgent?.toLowerCase() ? agent : null,
    nonblank(machineName),
    workspaceLabel,
    tab && tab !== workspaceLabel ? tab : null,
  ].filter((part): part is string => Boolean(part));
}
