import { describe, expect, it } from "vitest";
import {
  extractItemMessagePayload,
  extractText,
  parseRpcNotification
} from "../services/eventParser";

describe("parseRpcNotification", () => {
  it("parses item/completed notification into chat message", () => {
    const parsed = parseRpcNotification("device-2", {
      method: "item/completed",
      params: {
        threadId: "thread-456",
        item: {
          id: "item-1",
          type: "assistantMessage",
          content: [{ text: "Hello from assistant" }],
          completedAt: "2026-03-01T12:00:00.000Z"
        }
      }
    });

    expect(parsed).toEqual({
      kind: "message",
      threadId: "thread-456",
      message: {
        id: "item-1",
        key: "device-2::thread-456",
        threadId: "thread-456",
        deviceId: "device-2",
        role: "assistant",
        content: "Hello from assistant",
        createdAt: "2026-03-01T12:00:00.000Z"
      }
    });
  });

  it("parses message/completed notification into chat message", () => {
    const parsed = parseRpcNotification("device-2", {
      method: "message/completed",
      params: {
        threadId: "thread-777",
        message: {
          id: "msg-1",
          role: "assistant",
          content: "Done.",
          createdAt: "2026-03-01T12:01:00.000Z"
        }
      }
    });

    expect(parsed).toEqual({
      kind: "message",
      threadId: "thread-777",
      message: {
        id: "msg-1",
        key: "device-2::thread-777",
        threadId: "thread-777",
        deviceId: "device-2",
        role: "assistant",
        content: "Done.",
        createdAt: "2026-03-01T12:01:00.000Z"
      }
    });
  });

  it("extracts image attachments from message notifications", () => {
    const parsed = parseRpcNotification("device-5", {
      method: "message/completed",
      params: {
        threadId: "thread-img",
        message: {
          id: "msg-img-1",
          role: "user",
          content: [
            { type: "input_text", text: "What is in this image?" },
            { type: "input_image", image_url: "data:image/png;base64,abc123" }
          ],
          createdAt: "2026-03-01T12:03:00.000Z"
        }
      }
    });

    expect(parsed).toMatchObject({
      kind: "message",
      threadId: "thread-img",
      message: {
        id: "msg-img-1",
        role: "user",
        content: "What is in this image?",
        images: [{ url: "data:image/png;base64,abc123" }]
      }
    });
  });

  it("uses a stable id for delta-style stream updates within the same turn", () => {
    const first = parseRpcNotification("device-6", {
      method: "item/delta",
      params: {
        threadId: "thread-stream",
        turnId: "turn-1",
        item: {
          role: "system",
          type: "reasoning",
          delta: "Hel"
        }
      }
    });

    const second = parseRpcNotification("device-6", {
      method: "item/delta",
      params: {
        threadId: "thread-stream",
        turnId: "turn-1",
        item: {
          role: "system",
          type: "reasoning",
          delta: "lo"
        }
      }
    });

    expect(first?.kind).toBe("message");
    expect(second?.kind).toBe("message");
    expect(first?.message.id).toBe(second?.message.id);
    expect(first?.message.eventType).toBe("reasoning");
    expect(second?.message.eventType).toBe("reasoning");
  });

  it("ignores non-reasoning assistant delta chunks to avoid duplicate final responses", () => {
    const parsed = parseRpcNotification("device-7", {
      method: "item/delta",
      params: {
        threadId: "thread-assistant-delta",
        turnId: "turn-2",
        item: {
          role: "assistant",
          type: "assistant_message",
          delta: "partial assistant output"
        }
      }
    });

    expect(parsed).toBeNull();
  });

  it("does not misclassify message status payload as turn event", () => {
    const parsed = parseRpcNotification("device-4", {
      method: "message/completed",
      params: {
        threadId: "thread-901",
        status: "completed",
        message: {
          id: "msg-2",
          role: "assistant",
          content: "Final answer",
          createdAt: "2026-03-01T12:02:00.000Z"
        }
      }
    });

    expect(parsed).toEqual({
      kind: "message",
      threadId: "thread-901",
      message: {
        id: "msg-2",
        key: "device-4::thread-901",
        threadId: "thread-901",
        deviceId: "device-4",
        role: "assistant",
        content: "Final answer",
        createdAt: "2026-03-01T12:02:00.000Z"
      }
    });
  });

  it("returns null for unsupported events", () => {
    const parsed = parseRpcNotification("device-1", {
      method: "unknown/event",
      params: {
        threadId: "thread-789"
      }
    });

    expect(parsed).toBeNull();
  });

  it("parses activity notifications into activity messages", () => {
    const parsed = parseRpcNotification("device-3", {
      method: "tool/exec",
      params: {
        threadId: "thread-900",
        command: "rg --files",
        cwd: "/tmp/project"
      }
    });

    expect(parsed).toMatchObject({
      kind: "message",
      threadId: "thread-900",
      message: {
        key: "device-3::thread-900",
        threadId: "thread-900",
        deviceId: "device-3",
        role: "tool",
        eventType: "activity"
      }
    });
  });
});

describe("extractText", () => {
  it("extracts text from nested arrays and objects", () => {
    const text = extractText({
      content: [
        { text: "line one" },
        { parts: [{ text: "line two" }] }
      ]
    });

    expect(text).toBe("line one\nline two");
  });
});

describe("extractItemMessagePayload", () => {
  it("does not mark plain message/read items as activity", () => {
    const payload = extractItemMessagePayload(
      {
        role: "user",
        content: "Hello"
      },
      "message/read",
      "user"
    );

    expect(payload).toEqual({
      content: "Hello"
    });
  });
});
