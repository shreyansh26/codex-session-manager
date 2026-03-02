import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../domain/types";
import {
  getSessionFolderKey,
  getSessionFolderLabel,
  groupSessionsByFolder
} from "../components/sidebarGrouping";

const buildSession = (
  key: string,
  partial: Partial<SessionSummary> = {}
): SessionSummary => ({
  key,
  threadId: key,
  deviceId: "device-local",
  deviceLabel: "Local Device",
  deviceAddress: "local",
  title: `Session ${key}`,
  preview: "Preview",
  updatedAt: "2026-03-01T10:00:00.000Z",
  ...partial
});

describe("sidebarGrouping", () => {
  it("groups sessions by folderName and normalizes folder keys", () => {
    const sessions = [
      buildSession("one", {
        folderName: "repo",
        updatedAt: "2026-03-01T10:00:00.000Z"
      }),
      buildSession("two", {
        folderName: " Repo ",
        updatedAt: "2026-03-01T11:00:00.000Z"
      })
    ];

    const groups = groupSessionsByFolder(sessions);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("repo");
    expect(groups[0]?.key).toBe("repo");
    expect(groups[0]?.sessions.map((session) => session.key)).toEqual(["two", "one"]);
  });

  it("falls back to cwd basename when folderName is missing", () => {
    const session = buildSession("cwd-session", {
      folderName: undefined,
      cwd: "/Users/shreyansh/projects/codex-app-v2"
    });

    expect(getSessionFolderLabel(session)).toBe("codex-app-v2");
    expect(getSessionFolderKey(session)).toBe("codex-app-v2");
  });

  it("uses unknown-folder fallback when folder metadata is unavailable", () => {
    const sessions = [buildSession("unknown", { folderName: undefined, cwd: undefined })];

    const groups = groupSessionsByFolder(sessions);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("unknown-folder");
    expect(groups[0]?.key).toBe("unknown-folder");
  });

  it("orders folder groups by latest contained updatedAt", () => {
    const sessions = [
      buildSession("backend-older", {
        folderName: "backend",
        updatedAt: "2026-03-01T08:00:00.000Z"
      }),
      buildSession("frontend-newer", {
        folderName: "frontend",
        updatedAt: "2026-03-01T11:30:00.000Z"
      }),
      buildSession("backend-newer", {
        folderName: "backend",
        updatedAt: "2026-03-01T10:00:00.000Z"
      })
    ];

    const groups = groupSessionsByFolder(sessions);

    expect(groups.map((group) => group.label)).toEqual(["frontend", "backend"]);
    expect(groups[1]?.sessions.map((session) => session.key)).toEqual([
      "backend-newer",
      "backend-older"
    ]);
  });
});
