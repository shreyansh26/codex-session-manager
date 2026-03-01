import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../domain/types";
import { mergeSessions } from "../state/sessionMerge";

const buildSession = (
  key: string,
  partial: Partial<SessionSummary> = {}
): SessionSummary => ({
  key,
  threadId: key,
  deviceId: "device-local",
  deviceLabel: "Local Device",
  deviceAddress: "127.0.0.1",
  title: `Session ${key}`,
  preview: "Preview",
  updatedAt: "2026-03-01T10:00:00.000Z",
  ...partial
});

describe("mergeSessions", () => {
  it("updates existing sessions and inserts new ones sorted by updatedAt", () => {
    const current = [
      buildSession("a", {
        title: "Old A",
        updatedAt: "2026-03-01T08:00:00.000Z"
      }),
      buildSession("b", {
        title: "Old B",
        updatedAt: "2026-03-01T09:00:00.000Z"
      })
    ];

    const incoming = [
      buildSession("a", {
        title: "New A",
        preview: "Updated",
        updatedAt: "2026-03-01T11:00:00.000Z"
      }),
      buildSession("c", {
        title: "New C",
        updatedAt: "2026-03-01T10:30:00.000Z"
      })
    ];

    const merged = mergeSessions(current, incoming);

    expect(merged.map((session) => session.key)).toEqual(["a", "c", "b"]);
    expect(merged.find((session) => session.key === "a")?.title).toBe("New A");
    expect(merged.find((session) => session.key === "a")?.preview).toBe("Updated");
  });

  it("keeps existing sessions when incoming is empty", () => {
    const current = [
      buildSession("one", { updatedAt: "2026-03-01T11:00:00.000Z" }),
      buildSession("two", { updatedAt: "2026-03-01T10:00:00.000Z" })
    ];

    const merged = mergeSessions(current, []);

    expect(merged).toEqual(current);
  });
});
