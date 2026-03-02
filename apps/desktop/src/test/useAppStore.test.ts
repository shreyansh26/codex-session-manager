import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../domain/types";
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
});
