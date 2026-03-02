import type { SessionSummary } from "../domain/types";

export interface FolderGroup {
  key: string;
  label: string;
  sessions: SessionSummary[];
}

const UNKNOWN_FOLDER_LABEL = "unknown-folder";

const parseTimestampMs = (timestamp: string): number => {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? -1 : parsed;
};

const folderLabelFromCwd = (cwd?: string): string => {
  if (!cwd) {
    return UNKNOWN_FOLDER_LABEL;
  }

  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) {
    return UNKNOWN_FOLDER_LABEL;
  }

  const parts = normalized.split("/");
  const folderName = parts[parts.length - 1]?.trim();
  return folderName || UNKNOWN_FOLDER_LABEL;
};

const normalizeFolderKey = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  return normalized || UNKNOWN_FOLDER_LABEL;
};

export const getSessionFolderLabel = (session: SessionSummary): string => {
  const folderName = session.folderName?.trim();
  if (folderName) {
    return folderName;
  }

  return folderLabelFromCwd(session.cwd);
};

export const getSessionFolderKey = (session: SessionSummary): string =>
  normalizeFolderKey(getSessionFolderLabel(session));

export const groupSessionsByFolder = (sessions: SessionSummary[]): FolderGroup[] => {
  const groups = new Map<
    string,
    {
      key: string;
      label: string;
      sessions: SessionSummary[];
      latestUpdatedAtMs: number;
    }
  >();

  for (const session of sessions) {
    const label = getSessionFolderLabel(session);
    const key = getSessionFolderKey(session);
    const updatedAtMs = parseTimestampMs(session.updatedAt);

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        label,
        sessions: [session],
        latestUpdatedAtMs: updatedAtMs
      });
      continue;
    }

    existing.sessions.push(session);
    existing.latestUpdatedAtMs = Math.max(existing.latestUpdatedAtMs, updatedAtMs);
  }

  const grouped = [...groups.values()];

  for (const group of grouped) {
    group.sessions.sort(
      (a, b) => parseTimestampMs(b.updatedAt) - parseTimestampMs(a.updatedAt)
    );
  }

  grouped.sort((a, b) => {
    const byUpdatedAt = b.latestUpdatedAtMs - a.latestUpdatedAtMs;
    if (byUpdatedAt !== 0) {
      return byUpdatedAt;
    }

    return a.label.localeCompare(b.label);
  });

  return grouped.map(({ key, label, sessions }) => ({ key, label, sessions }));
};
