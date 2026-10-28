/**
 * Where a chat's pull request events (opened, merged, closed, a branch switch) sit among its turns:
 * before the first turn that began after the event, and after the last turn when none did. An event
 * with no known time is left out: it has no place in the story.
 */
import type { PrEvent, PullRequest } from "../../shared/pull-requests.ts";

export interface PrEventRowData { before: number; key: string; event: PrEvent; pr: PullRequest | null }

export function prEventRows(events: readonly PrEvent[], turnTimes: readonly (string | null)[], prs: readonly PullRequest[]): PrEventRowData[] {
  const times = turnTimes.map((at) => (at === null ? null : Date.parse(at)));
  return events.flatMap((event): PrEventRowData[] => {
    const at = Date.parse(event.at);
    if (Number.isNaN(at)) return [];
    const after = times.findIndex((time) => time !== null && time > at);
    const key = event.kind === "branch" ? `pr:branch:${event.from}>${event.to}:${event.at}` : `pr:${event.kind}:${event.url}:${event.at}`;
    return [{ before: after < 0 ? times.length : after, key, event, pr: event.kind === "branch" ? null : prs.find((pr) => pr.url === event.url) ?? null }];
  });
}
