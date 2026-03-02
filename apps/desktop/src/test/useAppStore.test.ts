import { describe, expect, it } from "vitest";
import type { ChatMessage, ThreadTokenUsageState } from "../domain/types";
import { __TEST_ONLY__ } from "../state/useAppStore";

const buildMessage = (partial: Partial<ChatMessage>): ChatMessage => ({
  id: "message-id",
  key: "device-1::thread-1",
  threadId: "thread-1",
  deviceId: "device-1",
  role: "user",
  content: "hello",
  createdAt: "2026-03-02T12:00:00.000Z",
  ...partial
});

describe("useAppStore message upsert behavior", () => {
  it("replaces optimistic user message when server acknowledgement arrives", () => {
    const optimistic = buildMessage({
      id: "local-a1",
      content: "Which model are you",
      createdAt: "2026-03-02T12:00:00.000Z"
    });
    const acknowledged = buildMessage({
      id: "srv-1",
      content: "Which model are you",
      createdAt: "2026-03-02T12:00:01.000Z"
    });

    const next = __TEST_ONLY__.upsertMessage([optimistic], acknowledged);

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: "srv-1",
      content: "Which model are you"
    });
  });

  it("does not collapse two optimistic messages with identical text", () => {
    const first = buildMessage({
      id: "local-a1",
      content: "same prompt",
      createdAt: "2026-03-02T12:00:00.000Z"
    });
    const second = buildMessage({
      id: "local-a2",
      content: "same prompt",
      createdAt: "2026-03-02T12:00:02.000Z"
    });

    const next = __TEST_ONLY__.upsertMessage([first], second);

    expect(next).toHaveLength(2);
    expect(next.map((message) => message.id)).toEqual(["local-a1", "local-a2"]);
  });

  it("keeps separate reasoning entries when ids differ", () => {
    const first = buildMessage({
      id: "reasoning-a",
      role: "system",
      eventType: "reasoning",
      content: "Preparing to fetch latest news",
      createdAt: "2026-03-02T12:00:00.000Z"
    });
    const second = buildMessage({
      id: "reasoning-b",
      role: "system",
      eventType: "reasoning",
      content: "Preparing to fetch latest news from multiple sources",
      createdAt: "2026-03-02T12:00:18.000Z"
    });

    const next = __TEST_ONLY__.upsertMessage([first], second);

    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({
      id: "reasoning-a",
      eventType: "reasoning",
      content: "Preparing to fetch latest news"
    });
    expect(next[1]).toMatchObject({
      id: "reasoning-b",
      eventType: "reasoning",
      content: "Preparing to fetch latest news from multiple sources"
    });
  });

  it("keeps separate reasoning entries across non-user roles when ids differ", () => {
    const first = buildMessage({
      id: "reasoning-system",
      role: "system",
      eventType: "reasoning",
      content: "Planning latest tech news search",
      createdAt: "2026-03-02T12:00:00.000Z"
    });
    const second = buildMessage({
      id: "reasoning-assistant",
      role: "assistant",
      eventType: "reasoning",
      content: "Planning latest tech news search with multiple sources",
      createdAt: "2026-03-02T12:00:06.000Z"
    });

    const next = __TEST_ONLY__.upsertMessage([first], second);

    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({
      id: "reasoning-system",
      eventType: "reasoning",
      content: "Planning latest tech news search"
    });
    expect(next[1]).toMatchObject({
      id: "reasoning-assistant",
      eventType: "reasoning",
      content: "Planning latest tech news search with multiple sources"
    });
  });

  it("keeps distinct reasoning snapshots while merging thread refresh payloads", () => {
    const merged = __TEST_ONLY__.mergeThreadMessages([], [
      buildMessage({
        id: "reasoning-1",
        role: "system",
        eventType: "reasoning",
        content: "Planning latest headlines",
        createdAt: "2026-03-02T12:00:00.000Z"
      }),
      buildMessage({
        id: "reasoning-2",
        role: "system",
        eventType: "reasoning",
        content: "Planning latest headlines across multiple sources",
        createdAt: "2026-03-02T12:00:05.000Z"
      }),
      buildMessage({
        id: "assistant-1",
        role: "assistant",
        content: "Here are the headlines.",
        createdAt: "2026-03-02T12:00:10.000Z"
      })
    ]);

    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({
      id: "reasoning-1",
      eventType: "reasoning",
      content: "Planning latest headlines"
    });
    expect(merged[1]).toMatchObject({
      id: "reasoning-2",
      eventType: "reasoning",
      content: "Planning latest headlines across multiple sources"
    });
    expect(merged[2]).toMatchObject({
      id: "assistant-1",
      role: "assistant"
    });
  });
});

describe("useAppStore cost helpers", () => {
  const usage: ThreadTokenUsageState = {
    threadId: "thread-1",
    turnId: "turn-1",
    updatedAt: "2026-03-02T12:00:00.000Z",
    total: {
      totalTokens: 1500,
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 500,
      reasoningOutputTokens: 100
    },
    last: {
      totalTokens: 300,
      inputTokens: 200,
      cachedInputTokens: 50,
      outputTokens: 100,
      reasoningOutputTokens: 20
    }
  };

  it("computes cost for known model mapping", () => {
    const cost = __TEST_ONLY__.computeSessionCostUsd("gpt-5", usage);
    expect(cost).toBeCloseTo(0.006025, 9);
  });

  it("returns null for unknown model pricing", () => {
    const cost = __TEST_ONLY__.computeSessionCostUsd("unknown-model-123", usage);
    expect(cost).toBeNull();
  });

  it("accumulates cost from last usage and dedupes repeated usage event", () => {
    const first = __TEST_ONLY__.accumulateSessionCostFromLast({
      currentCostUsd: null,
      model: "gpt-5",
      tokenUsage: usage,
      lastAppliedEventKey: undefined
    });

    expect(first.nextCostUsd).toBeCloseTo(0.00119375, 9);
    expect(first.nextAppliedEventKey).toBe(
      __TEST_ONLY__.makeUsageDeltaEventKey(usage.turnId, usage.last)
    );

    const duplicate = __TEST_ONLY__.accumulateSessionCostFromLast({
      currentCostUsd: first.nextCostUsd,
      model: "gpt-5",
      tokenUsage: usage,
      lastAppliedEventKey: first.nextAppliedEventKey
    });

    expect(duplicate.nextCostUsd).toBeCloseTo(first.nextCostUsd ?? 0, 9);
    expect(duplicate.nextAppliedEventKey).toBe(first.nextAppliedEventKey);
  });
});
