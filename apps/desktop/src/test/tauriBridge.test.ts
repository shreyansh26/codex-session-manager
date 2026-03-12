import { afterEach, describe, expect, it } from "vitest";
import { __TEST_ONLY__, debugPersistArtifact } from "../services/tauriBridge";

afterEach(() => {
  __TEST_ONLY__.clearDemoArtifacts();
});

describe("tauriBridge debug persistence", () => {
  it("stores persisted artifacts in demo mode for capture-path tests", async () => {
    const path = await debugPersistArtifact(
      "reopened-session-demo.json",
      JSON.stringify({ ok: true }, null, 2)
    );

    expect(path).toBe("/tmp/codex-session-monitor-debug/reopened-session-demo.json");
    expect(__TEST_ONLY__.getDemoArtifact("reopened-session-demo.json")).toContain('"ok": true');
  });
});
