import { describe, expect, it } from "vitest";
import {
  extractItemMessagePayload,
  extractText,
  parseRpcNotification,
  parseThreadModelNotification,
  parseThreadTokenUsageNotification
} from "../services/eventParser";
import { chronologyReplayFixtureById } from "../../../../../codex-app-electron/src/renderer/src/test/chronologyReplayFixtures";

const pickLiveNotification = (
  fixtureId: string,
  labelPrefix: string
): Parameters<typeof parseRpcNotification>[1] => {
  const fixture = chronologyReplayFixtureById[fixtureId];
  if (!fixture) {
    throw new Error(`Unknown chronology fixture: ${fixtureId}`);
  }

  const step = fixture.steps.find(
    (candidate) => candidate.source === "live" && candidate.label.startsWith(labelPrefix)
  );
  if (!step || step.source !== "live") {
    throw new Error(`Missing live step ${labelPrefix} in fixture ${fixtureId}`);
  }

  return step.notification;
};

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

  it("prefers updatedAt over createdAt for live item notifications", () => {
    const parsed = parseRpcNotification("device-8", {
      method: "item/updated",
      params: {
        threadId: "thread-order",
        item: {
          id: "reasoning-1",
          role: "system",
          type: "reasoning",
          content: "Refining source selection",
          createdAt: "2026-03-02T12:00:00.000Z",
          updatedAt: "2026-03-02T12:00:09.000Z"
        }
      }
    });

    expect(parsed).toMatchObject({
      kind: "message",
      threadId: "thread-order",
      message: {
        id: "reasoning-1::2026-03-02T12:00:09.000Z",
        eventType: "reasoning",
        createdAt: "2026-03-02T12:00:09.000Z"
      }
    });
  });

  it("creates separate reasoning snapshot ids for repeated updates to the same item", () => {
    const first = parseRpcNotification("device-9", {
      method: "item/updated",
      params: {
        threadId: "thread-reasoning-snapshots",
        item: {
          id: "reasoning-live",
          role: "system",
          type: "reasoning",
          content: "Looking for sources",
          updatedAt: "2026-03-02T12:00:01.000Z"
        }
      }
    });
    const second = parseRpcNotification("device-9", {
      method: "item/updated",
      params: {
        threadId: "thread-reasoning-snapshots",
        item: {
          id: "reasoning-live",
          role: "system",
          type: "reasoning",
          content: "Looking for sources and narrowing to primary docs",
          updatedAt: "2026-03-02T12:00:04.000Z"
        }
      }
    });

    expect(first?.message.id).toBe("reasoning-live::2026-03-02T12:00:01.000Z");
    expect(second?.message.id).toBe("reasoning-live::2026-03-02T12:00:04.000Z");
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

  it("ignores reasoning delta chunks and relies on non-delta events for timeline entries", () => {
    const parsed = parseRpcNotification("device-6", {
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

    expect(parsed).toBeNull();
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

  it("parses tool notifications into structured tool call messages", () => {
    const parsed = parseRpcNotification("device-3", {
      method: "tool/exec",
      params: {
        threadId: "thread-900",
        toolName: "exec_command",
        command: "rg --files",
        cwd: "/tmp/project",
        output: {
          chunkId: "978a4a",
          wallTime: 0.4916,
          exitCode: 0,
          originalTokenCount: 11,
          output: "0\n/tmp/clone.log\nCloning into 'llm.c'..."
        }
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
        eventType: "tool_call",
        toolCall: {
          name: "exec_command",
          input: "rg --files",
          status: "completed"
        }
      }
    });
    expect(parsed?.message.toolCall?.output).toContain("Chunk ID: 978a4a");
    expect(parsed?.message.toolCall?.output).toContain("Process exited with code 0");
  });

  it("parses codex/event wrapped function_call payloads into tool messages", () => {
    const parsed = parseRpcNotification("device-9", {
      method: "codex/event",
      params: {
        threadId: "thread-live-tool",
        timestamp: "2026-03-08T08:10:20.101Z",
        msg: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: "pwd",
            workdir: "/tmp/demo"
          }),
          call_id: "call_live_tool"
        }
      }
    });

    expect(parsed).toMatchObject({
      kind: "message",
      threadId: "thread-live-tool",
      message: {
        id: "call_live_tool",
        key: "device-9::thread-live-tool",
        role: "tool",
        eventType: "tool_call",
        toolCall: {
          name: "exec_command",
          input: '{"cmd":"pwd","workdir":"/tmp/demo"}'
        }
      }
    });
  });

  it("parses codex/event response_item envelopes using nested call ids", () => {
    const parsed = parseRpcNotification("device-9", {
      method: "codex/event",
      params: {
        threadId: "thread-live-tool",
        id: "turn-envelope-1",
        timestamp: "2026-03-08T08:10:20.202Z",
        msg: {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "write_stdin",
            arguments: JSON.stringify({
              session_id: 77083,
              chars: "\u0003"
            }),
            call_id: "call_nested_live_tool"
          }
        }
      }
    });

    expect(parsed).toMatchObject({
      kind: "message",
      threadId: "thread-live-tool",
      message: {
        id: "call_nested_live_tool",
        key: "device-9::thread-live-tool",
        role: "tool",
        eventType: "tool_call",
        toolCall: {
          name: "write_stdin",
          input: '{"session_id":77083,"chars":"\\u0003"}'
        }
      }
    });
  });

  it("parses codex/event web_search_call payloads into tool messages", () => {
    const parsed = parseRpcNotification("device-9", {
      method: "codex/event",
      params: {
        threadId: "thread-live-tool",
        timestamp: "2026-03-08T08:10:20.303Z",
        msg: {
          type: "response_item",
          payload: {
            type: "web_search_call",
            status: "completed",
            action: {
              type: "search",
              query: "Iran Israel war news March 8 2026 Reuters",
              queries: [
                "Iran Israel war news March 8 2026 Reuters",
                "Iran Israel war today March 8 2026 AP News"
              ]
            }
          }
        }
      }
    });

    expect(parsed).toMatchObject({
      kind: "message",
      threadId: "thread-live-tool",
      message: {
        key: "device-9::thread-live-tool",
        role: "tool",
        eventType: "tool_call",
        toolCall: {
          name: "web_search",
          status: "completed"
        }
      }
    });
    expect(parsed?.message.toolCall?.input).toContain(
      '"query": "Iran Israel war news March 8 2026 Reuters"'
    );
  });

  it("parses codex/event response_item envelopes when only conversationId is present on params", () => {
    const parsed = parseRpcNotification("device-9", {
      method: "codex/event",
      params: {
        conversationId: "thread-live-tool",
        id: "turn-envelope-2",
        timestamp: "2026-03-08T08:10:20.404Z",
        msg: {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "pwd"
            }),
            call_id: "call_conversation_live_tool"
          }
        }
      }
    });

    expect(parsed).toMatchObject({
      kind: "message",
      threadId: "thread-live-tool",
      message: {
        id: "call_conversation_live_tool",
        key: "device-9::thread-live-tool",
        role: "tool",
        eventType: "tool_call",
        toolCall: {
          name: "exec_command",
          input: '{"cmd":"pwd"}'
        }
      }
    });
  });

  it("prefers wrapped event timestamps over outer createdAt for live tool calls", () => {
    const parsed = parseRpcNotification("device-9", {
      method: "codex/event",
      params: {
        threadId: "thread-live-tool",
        createdAt: "2026-03-08T08:09:59.994Z",
        msg: {
          timestamp: "2026-03-08T08:10:20.498Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "pwd"
            }),
            call_id: "call_timestamped_live_tool"
          }
        }
      }
    });

    expect(parsed).toMatchObject({
      kind: "message",
      threadId: "thread-live-tool",
      message: {
        id: "call_timestamped_live_tool",
        createdAt: "2026-03-08T08:10:20.498Z",
        role: "tool",
        eventType: "tool_call",
        toolCall: {
          name: "exec_command",
          input: '{"cmd":"pwd"}'
        }
      }
    });
  });

  it("prefers top-level wrapped timestamps over stale nested createdAt values", () => {
    const parsed = parseRpcNotification("device-9", {
      method: "codex/event",
      params: {
        threadId: "thread-live-tool",
        timestamp: "2026-03-08T08:10:20.498Z",
        msg: {
          createdAt: "2026-03-08T08:09:59.994Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "pwd"
            }),
            call_id: "call_timestamped_top_level_tool"
          }
        }
      }
    });

    expect(parsed).toMatchObject({
      kind: "message",
      threadId: "thread-live-tool",
      message: {
        id: "call_timestamped_top_level_tool",
        createdAt: "2026-03-08T08:10:20.498Z",
        role: "tool",
        eventType: "tool_call"
      }
    });
  });

  it("keeps fallback tool identity stable when call_id is missing", () => {
    const baseNotification = structuredClone(
      pickLiveNotification("output-before-call-record", "tool-start:")
    ) as unknown as Record<string, unknown>;

    const params = baseNotification.params as Record<string, unknown>;
    const msg = params.msg as Record<string, unknown>;
    const payload = msg.payload as Record<string, unknown>;
    delete payload.call_id;

    const replayNotification = structuredClone(baseNotification) as Record<string, unknown>;
    (replayNotification.params as Record<string, unknown>).timestamp =
      "2026-03-08T08:20:11.000Z";

    const first = parseRpcNotification(
      "device-chronology",
      baseNotification as unknown as Parameters<typeof parseRpcNotification>[1]
    );
    const replay = parseRpcNotification(
      "device-chronology",
      replayNotification as unknown as Parameters<typeof parseRpcNotification>[1]
    );

    expect(first?.message.id).toBe(replay?.message.id);
  });

  it("falls back to nested wrapped createdAt when outer wrapped timestamp is invalid", () => {
    const notification = structuredClone(
      pickLiveNotification("live-snapshot-rollout-tool-convergence", "tool-start:")
    ) as unknown as Record<string, unknown>;

    const params = notification.params as Record<string, unknown>;
    params.timestamp = "not-a-real-timestamp";

    const parsed = parseRpcNotification(
      "device-chronology",
      notification as unknown as Parameters<typeof parseRpcNotification>[1]
    );

    expect(parsed?.message.createdAt).toBe("2026-03-08T08:09:50.000Z");
  });

  it("returns null for wrapped tool events missing all timestamp candidates", () => {
    const notification = structuredClone(
      pickLiveNotification("live-snapshot-rollout-tool-convergence", "tool-start:")
    ) as unknown as Record<string, unknown>;

    const params = notification.params as Record<string, unknown>;
    delete params.timestamp;
    const msg = params.msg as Record<string, unknown>;
    delete msg.createdAt;

    const parsed = parseRpcNotification(
      "device-chronology",
      notification as unknown as Parameters<typeof parseRpcNotification>[1]
    );

    expect(parsed).toBeNull();
  });

  it("does not treat call_id metadata as tool input for output-only wrapped payloads", () => {
    const notification = pickLiveNotification("output-before-call-record", "tool-output:");
    const parsed = parseRpcNotification("device-chronology", notification);

    expect(parsed?.message.toolCall?.input).toBeUndefined();
    expect(parsed?.message.toolCall?.output).toContain("Process exited with code 0");
  });
});

describe("parseThreadTokenUsageNotification", () => {
  it("parses thread/tokenUsage/updated with total and last usage blocks", () => {
    const parsed = parseThreadTokenUsageNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-usage-1",
        turnId: "turn-usage-1",
        tokenUsage: {
          total: {
            totalTokens: 1400,
            inputTokens: 900,
            cachedInputTokens: 300,
            outputTokens: 500,
            reasoningOutputTokens: 120
          },
          last: {
            totalTokens: 300,
            inputTokens: 180,
            cachedInputTokens: 60,
            outputTokens: 120,
            reasoningOutputTokens: 20
          },
          modelContextWindow: 200000
        }
      }
    });

    expect(parsed).toEqual({
      threadId: "thread-usage-1",
      turnId: "turn-usage-1",
      tokenUsage: {
        total: {
          totalTokens: 1400,
          inputTokens: 900,
          cachedInputTokens: 300,
          outputTokens: 500,
          reasoningOutputTokens: 120
        },
        last: {
          totalTokens: 300,
          inputTokens: 180,
          cachedInputTokens: 60,
          outputTokens: 120,
          reasoningOutputTokens: 20
        },
        modelContextWindow: 200000
      }
    });
  });

  it("parses token_usage blocks with snake_case keys", () => {
    const parsed = parseThreadTokenUsageNotification({
      method: "thread/token_usage/updated",
      params: {
        thread_id: "thread-usage-2",
        token_usage: {
          total_token_usage: {
            total_tokens: 900,
            input_tokens: 550,
            cached_input_tokens: 150,
            output_tokens: 350,
            reasoning_output_tokens: 80
          },
          last_token_usage: {
            total_tokens: 200,
            input_tokens: 110,
            cached_input_tokens: 30,
            output_tokens: 90,
            reasoning_output_tokens: 10
          },
          model_context_window: 128000
        }
      }
    });

    expect(parsed).toEqual({
      threadId: "thread-usage-2",
      tokenUsage: {
        total: {
          totalTokens: 900,
          inputTokens: 550,
          cachedInputTokens: 150,
          outputTokens: 350,
          reasoningOutputTokens: 80
        },
        last: {
          totalTokens: 200,
          inputTokens: 110,
          cachedInputTokens: 30,
          outputTokens: 90,
          reasoningOutputTokens: 10
        },
        modelContextWindow: 128000
      }
    });
  });

  it("parses token_count events using fallback thread id", () => {
    const parsed = parseThreadTokenUsageNotification(
      {
        method: "token_count",
        params: {
          info: {
            total_token_usage: {
              total_tokens: 1200,
              input_tokens: 700,
              cached_input_tokens: 210,
              output_tokens: 500,
              reasoning_output_tokens: 100
            },
            last_token_usage: {
              total_tokens: 320,
              input_tokens: 200,
              cached_input_tokens: 40,
              output_tokens: 120,
              reasoning_output_tokens: 15
            },
            model_context_window: 200000
          }
        }
      },
      "thread-fallback-1"
    );

    expect(parsed).toEqual({
      threadId: "thread-fallback-1",
      tokenUsage: {
        total: {
          totalTokens: 1200,
          inputTokens: 700,
          cachedInputTokens: 210,
          outputTokens: 500,
          reasoningOutputTokens: 100
        },
        last: {
          totalTokens: 320,
          inputTokens: 200,
          cachedInputTokens: 40,
          outputTokens: 120,
          reasoningOutputTokens: 15
        },
        modelContextWindow: 200000
      }
    });
  });

  it("parses codex/event/token_count wrapper payloads", () => {
    const parsed = parseThreadTokenUsageNotification({
      method: "codex/event/token_count",
      params: {
        id: "turn-raw-1",
        conversationId: "thread-raw-1",
        msg: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 840,
              input_tokens: 520,
              cached_input_tokens: 140,
              output_tokens: 320,
              reasoning_output_tokens: 60
            },
            last_token_usage: {
              total_tokens: 160,
              input_tokens: 90,
              cached_input_tokens: 20,
              output_tokens: 70,
              reasoning_output_tokens: 10
            },
            model_context_window: 258400
          }
        }
      }
    });

    expect(parsed).toEqual({
      threadId: "thread-raw-1",
      turnId: "turn-raw-1",
      tokenUsage: {
        total: {
          totalTokens: 840,
          inputTokens: 520,
          cachedInputTokens: 140,
          outputTokens: 320,
          reasoningOutputTokens: 60
        },
        last: {
          totalTokens: 160,
          inputTokens: 90,
          cachedInputTokens: 20,
          outputTokens: 70,
          reasoningOutputTokens: 10
        },
        modelContextWindow: 258400
      }
    });
  });

  it("parses deeply nested usage payloads with direct usage records", () => {
    const parsed = parseThreadTokenUsageNotification({
      method: "thread/tokenUsage/updated",
      params: {
        payload: {
          thread: { id: "thread-nested-1" },
          turn: { id: "turn-nested-1" },
          info: {
            total_token_usage: {
              input_tokens: 40,
              cached_input_tokens: 10,
              output_tokens: 15,
              reasoning_output_tokens: 2
            },
            last_token_usage: {
              input_tokens: 12,
              cached_input_tokens: 3,
              output_tokens: 5,
              reasoning_output_tokens: 1
            }
          }
        }
      }
    });

    expect(parsed).toEqual({
      threadId: "thread-nested-1",
      turnId: "turn-nested-1",
      tokenUsage: {
        total: {
          totalTokens: 55,
          inputTokens: 40,
          cachedInputTokens: 10,
          outputTokens: 15,
          reasoningOutputTokens: 2
        },
        last: {
          totalTokens: 17,
          inputTokens: 12,
          cachedInputTokens: 3,
          outputTokens: 5,
          reasoningOutputTokens: 1
        },
        modelContextWindow: null
      }
    });
  });

  it("parses usage from sessionConfigured initial token_count events", () => {
    const parsed = parseThreadTokenUsageNotification({
      method: "sessionConfigured",
      params: {
        sessionId: "thread-configured-1",
        initialMessages: [
          { type: "agent_message", text: "hello" },
          {
            type: "token_count",
            info: {
              total_token_usage: {
                total_tokens: 600,
                input_tokens: 350,
                cached_input_tokens: 120,
                output_tokens: 250,
                reasoning_output_tokens: 45
              },
              last_token_usage: {
                total_tokens: 120,
                input_tokens: 60,
                cached_input_tokens: 20,
                output_tokens: 60,
                reasoning_output_tokens: 8
              }
            }
          }
        ]
      }
    });

    expect(parsed).toEqual({
      threadId: "thread-configured-1",
      tokenUsage: {
        total: {
          totalTokens: 600,
          inputTokens: 350,
          cachedInputTokens: 120,
          outputTokens: 250,
          reasoningOutputTokens: 45
        },
        last: {
          totalTokens: 120,
          inputTokens: 60,
          cachedInputTokens: 20,
          outputTokens: 60,
          reasoningOutputTokens: 8
        },
        modelContextWindow: null
      }
    });
  });

  it("parses structurally valid token usage even when method is generic", () => {
    const parsed = parseThreadTokenUsageNotification({
      method: "codex/event",
      params: {
        conversationId: "thread-generic-usage-1",
        msg: {
          type: "misc_event",
          info: {
            total_token_usage: {
              total_tokens: 450,
              input_tokens: 280,
              cached_input_tokens: 90,
              output_tokens: 170,
              reasoning_output_tokens: 30
            },
            last_token_usage: {
              total_tokens: 90,
              input_tokens: 55,
              cached_input_tokens: 20,
              output_tokens: 35,
              reasoning_output_tokens: 6
            }
          }
        }
      }
    });

    expect(parsed).toEqual({
      threadId: "thread-generic-usage-1",
      tokenUsage: {
        total: {
          totalTokens: 450,
          inputTokens: 280,
          cachedInputTokens: 90,
          outputTokens: 170,
          reasoningOutputTokens: 30
        },
        last: {
          totalTokens: 90,
          inputTokens: 55,
          cachedInputTokens: 20,
          outputTokens: 35,
          reasoningOutputTokens: 6
        },
        modelContextWindow: null
      }
    });
  });
});

describe("parseThreadModelNotification", () => {
  it("parses sessionConfigured model assignment", () => {
    const parsed = parseThreadModelNotification({
      method: "sessionConfigured",
      params: {
        sessionId: "thread-model-1",
        model: "gpt-5-codex"
      }
    });

    expect(parsed).toEqual({
      threadId: "thread-model-1",
      model: "gpt-5-codex"
    });
  });

  it("parses model/rerouted destination model", () => {
    const parsed = parseThreadModelNotification({
      method: "model/rerouted",
      params: {
        threadId: "thread-model-2",
        fromModel: "gpt-5-mini",
        toModel: "gpt-5.2"
      }
    });

    expect(parsed).toEqual({
      threadId: "thread-model-2",
      model: "gpt-5.2"
    });
  });

  it("parses codex/event session_configured payloads", () => {
    const parsed = parseThreadModelNotification({
      method: "codex/event/session_configured",
      params: {
        conversationId: "thread-model-raw-1",
        msg: {
          type: "session_configured",
          session_id: "thread-model-raw-1",
          model: "gpt-5.3-codex"
        }
      }
    });

    expect(parsed).toEqual({
      threadId: "thread-model-raw-1",
      model: "gpt-5.3-codex"
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

  it("does not misclassify commentary phase items as tool calls", () => {
    const payload = extractItemMessagePayload(
      {
        phase: "commentary",
        content:
          "Ledger Snapshot: Code and tests are done; I'm collecting the exact file references."
      },
      "item/read",
      "assistant"
    );

    expect(payload).toEqual({
      content:
        "Ledger Snapshot: Code and tests are done; I'm collecting the exact file references."
    });
  });

  it("extracts structured tool call payloads with input and output", () => {
    const payload = extractItemMessagePayload(
      {
        role: "tool",
        toolName: "exec_command",
        input: {
          cmd: "grep -R \"vocab.bpe\" /tmp/llm.c"
        },
        output: {
          exitCode: 0,
          stdout: "/tmp/llm.c/README.md:18:make train_gpt2fp32cu"
        }
      },
      "item/read",
      "tool"
    );

    expect(payload).toMatchObject({
      eventType: "tool_call",
      toolCall: {
        name: "exec_command",
        input: "grep -R \"vocab.bpe\" /tmp/llm.c",
        status: "completed"
      }
    });
    expect(payload?.toolCall?.output).toContain("Process exited with code 0");
  });
});
