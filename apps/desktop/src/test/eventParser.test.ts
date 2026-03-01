import { describe, expect, it } from "vitest";
import {
  extractItemMessagePayload,
  extractText,
  parseRpcNotification
} from "../services/eventParser";

describe("parseRpcNotification", () => {
  it("parses turn/completed notification", () => {
    const parsed = parseRpcNotification("device-1", {
      method: "turn/completed",
      params: {
        threadId: "thread-123"
      }
    });

    expect(parsed).toEqual({
      kind: "turn",
      threadId: "thread-123",
      status: "completed"
    });
  });

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
