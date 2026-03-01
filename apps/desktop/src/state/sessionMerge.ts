import type { SessionSummary } from "../domain/types";

export const mergeSessions = (
  current: SessionSummary[],
  incoming: SessionSummary[]
): SessionSummary[] => {
  const merged = new Map<string, SessionSummary>();

  for (const session of current) {
    merged.set(session.key, session);
  }

  for (const session of incoming) {
    const previous = merged.get(session.key);
    merged.set(session.key, {
      ...previous,
      ...session
    });
  }

  return [...merged.values()].sort((a, b) => {
    const aMs = parseTimestampMs(a.updatedAt);
    const bMs = parseTimestampMs(b.updatedAt);
    if (aMs !== bMs) {
      return bMs - aMs;
    }
    return a.title.localeCompare(b.title);
  });
};

const parseTimestampMs = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? -1 : parsed;
};
