import { describe, expect, it } from "vitest";
import { parseRpcNotification } from "../services/eventParser";
import { __TEST_ONLY__ } from "../state/useAppStore";
import { resolveVisibleMessageWindow } from "../components/chatWindow";
import { __TEST_ONLY__ as codexApiTest } from "../services/codexApi";
import type { ChatMessage } from "../domain/types";
import {
  chronologyReplayFixtureById,
  type ExpectedToolBubble
} from "./chronologyReplayFixtures";
import {
  applyChronologyReplayFixture,
  messageRoleIdOrder
} from "./chronologyReplayHarness";

const applyParsedMessage = (
  messages: ChatMessage[],
  notification: Parameters<typeof parseRpcNotification>[1]
): ChatMessage[] => {
  const parsed = parseRpcNotification("device-1", notification);
  if (!parsed) {
    return messages;
  }
  return __TEST_ONLY__.upsertMessage(
    messages,
    __TEST_ONLY__.normalizeLiveNotificationMessage(messages, parsed.message)
  );
};

const expectToolBubblesToMatch = (
  messages: ChatMessage[],
  expectedBubbles: ExpectedToolBubble[]
): void => {
  const toolMessages = messages.filter((message) => message.eventType === "tool_call");
  expect(toolMessages).toHaveLength(expectedBubbles.length);

  expectedBubbles.forEach((expectedBubble, index) => {
    const actual = toolMessages[index];
    expect(actual?.toolCall?.name).toBe(expectedBubble.name);
    if (expectedBubble.inputIncludes) {
      expect(actual.toolCall?.input).toContain(expectedBubble.inputIncludes);
    }
    if (expectedBubble.outputIncludes) {
      expect(actual.toolCall?.output).toContain(expectedBubble.outputIncludes);
    }
  });
};

describe("frontend transcript emulation", () => {
  it("keeps a realistic wrapped live tool stream ordered after the triggering prompt", () => {
    let messages: ChatMessage[] = [];

    messages = applyParsedMessage(messages, {
      method: "message/completed",
      params: {
        threadId: "thread-emulated",
        message: {
          id: "user-live",
          role: "user",
          content: "Inspect the parser ordering",
          createdAt: "2026-03-08T08:09:59.994Z"
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "message/completed",
      params: {
        threadId: "thread-emulated",
        message: {
          id: "assistant-live",
          role: "assistant",
          content: "Checking the live parser now.",
          createdAt: "2026-03-08T08:10:20.497Z"
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        threadId: "thread-emulated",
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
            call_id: "call_live_1"
          }
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        threadId: "thread-emulated",
        timestamp: "2026-03-08T08:10:20.909Z",
        msg: {
          createdAt: "2026-03-08T08:09:59.994Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_live_1",
            output: "Process exited with code 0"
          }
        }
      }
    });

    expect(messages.map((message) => `${message.role}:${message.createdAt}`)).toEqual([
      "user:2026-03-08T08:09:59.994Z",
      "assistant:2026-03-08T08:10:20.497Z",
      "tool:2026-03-08T08:10:20.498Z"
    ]);
    expect(messages[2]).toMatchObject({
      eventType: "tool_call",
      toolCall: {
        name: "exec_command",
        output: "Process exited with code 0"
      }
    });
  });

  it("keeps repeated similar assistant/tool activity from a previous turn above a new user without collapsing turns", () => {
    let messages: ChatMessage[] = [];

    messages = applyParsedMessage(messages, {
      method: "message/completed",
      params: {
        threadId: "thread-emulated",
        message: {
          id: "previous-assistant",
          role: "assistant",
          content: "Checking the parser now.",
          createdAt: "2026-03-08T08:00:00.000Z"
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        threadId: "thread-emulated",
        timestamp: "2026-03-08T08:00:01.000Z",
        msg: {
          createdAt: "2026-03-08T08:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "npm run test" }),
            call_id: "call_previous_turn"
          }
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        threadId: "thread-emulated",
        timestamp: "2026-03-08T08:00:02.000Z",
        msg: {
          createdAt: "2026-03-08T08:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_previous_turn",
            output: "Process exited with code 0"
          }
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "message/completed",
      params: {
        threadId: "thread-emulated",
        message: {
          id: "current-user",
          role: "user",
          content: "Run the check again.",
          createdAt: "2026-03-08T08:01:00.000Z"
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "message/completed",
      params: {
        threadId: "thread-emulated",
        message: {
          id: "current-assistant",
          role: "assistant",
          content: "Checking the parser now.",
          createdAt: "2026-03-08T08:01:01.000Z"
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        threadId: "thread-emulated",
        timestamp: "2026-03-08T08:01:02.000Z",
        msg: {
          createdAt: "2026-03-08T08:01:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "npm run test" }),
            call_id: "call_current_turn"
          }
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        threadId: "thread-emulated",
        timestamp: "2026-03-08T08:01:03.000Z",
        msg: {
          createdAt: "2026-03-08T08:01:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_current_turn",
            output: "Process exited with code 0"
          }
        }
      }
    });

    expect(messages.map((message) => `${message.role}:${message.id}:${message.createdAt}`)).toEqual([
      "assistant:previous-assistant:2026-03-08T08:00:00.000Z",
      "tool:call_previous_turn:2026-03-08T08:00:01.000Z",
      "user:current-user:2026-03-08T08:01:00.000Z",
      "assistant:current-assistant:2026-03-08T08:01:01.000Z",
      "tool:call_current_turn:2026-03-08T08:01:02.000Z"
    ]);
  });

  it("keeps a later assistant notification below an earlier tool even when the assistant arrives with a stale createdAt", () => {
    let messages: ChatMessage[] = [];

    messages = applyParsedMessage(messages, {
      method: "message/completed",
      params: {
        threadId: "thread-emulated",
        message: {
          id: "user-live",
          role: "user",
          content: "Inspect the parser ordering",
          createdAt: "2026-03-08T08:09:59.994Z"
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        threadId: "thread-emulated",
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
            call_id: "call_live_1"
          }
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "message/completed",
      params: {
        threadId: "thread-emulated",
        message: {
          id: "assistant-stale",
          role: "assistant",
          content: "Finished checking the parser.",
          createdAt: "2026-03-08T08:09:59.994Z"
        }
      }
    });

    expect(messages.map((message) => `${message.role}:${message.id}`)).toEqual([
      "user:user-live",
      "tool:call_live_1",
      "assistant:assistant-stale"
    ]);
    expect(messages[2].createdAt > messages[1].createdAt).toBe(true);
  });

  it("keeps normalized live ordering when a later thread/read snapshot carries the same assistant message with a stale timestamp", () => {
    let messages: ChatMessage[] = [];

    messages = applyParsedMessage(messages, {
      method: "message/completed",
      params: {
        threadId: "thread-emulated",
        message: {
          id: "user-live",
          role: "user",
          content: "Inspect the parser ordering",
          createdAt: "2026-03-08T08:09:59.994Z"
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        threadId: "thread-emulated",
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
            call_id: "call_live_1"
          }
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "message/completed",
      params: {
        threadId: "thread-emulated",
        message: {
          id: "assistant-live",
          role: "assistant",
          content: "Finished checking the parser.",
          createdAt: "2026-03-08T08:09:59.994Z"
        }
      }
    });

    const merged = __TEST_ONLY__.mergeSnapshotMessages(messages, [
      {
        id: "assistant-live",
        key: "device-1::thread-emulated",
        threadId: "thread-emulated",
        deviceId: "device-1",
        role: "assistant",
        content: "Finished checking the parser.",
        createdAt: "2026-03-08T08:09:59.994Z"
      }
    ]);

    expect(merged.map((message) => `${message.role}:${message.id}`)).toEqual([
      "tool:call_live_1",
      "assistant:assistant-live"
    ]);
    expect(merged[0].createdAt).toBe("2026-03-08T08:10:20.498Z");
    expect(merged[1].createdAt > merged[0].createdAt).toBe(true);
  });

  it("keeps a live-normalized tool bubble in place when a later snapshot reports the same tool with an older timestamp", () => {
    const liveMessages: ChatMessage[] = [];
    const toolStart = __TEST_ONLY__.normalizeLiveNotificationMessage(liveMessages, {
      id: "call-live-tool",
      key: "device-1::thread-emulated",
      threadId: "thread-emulated",
      deviceId: "device-1",
      role: "tool",
      eventType: "tool_call",
      content: "Tool: exec_command\n\nInput:\npwd",
      createdAt: "2026-03-08T08:10:20.498Z",
      toolCall: {
        name: "exec_command",
        input: "pwd",
        status: "running"
      }
    });
    liveMessages.push(toolStart);

    const merged = __TEST_ONLY__.mergeSnapshotMessages(liveMessages, [
      {
        id: "call-live-tool",
        key: "device-1::thread-emulated",
        threadId: "thread-emulated",
        deviceId: "device-1",
        role: "tool",
        eventType: "tool_call",
        content: "Tool: exec_command\n\nInput:\npwd",
        createdAt: "2026-03-08T08:09:59.994Z",
        toolCall: {
          name: "exec_command",
          input: "pwd",
          output: "Process exited with code 0",
          status: "completed"
        }
      }
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "call-live-tool",
      createdAt: "2026-03-08T08:10:20.498Z",
      toolCall: {
        name: "exec_command",
        output: "Process exited with code 0",
        status: "completed"
      }
    });
  });

  it("keeps full user-assistant-tool interleaving when thread/read snapshots lack per-message timestamps", () => {
    const initialSnapshot = codexApiTest.parseMessagesFromThread("device-1", "thread-emulated", {
      createdAt: "2026-03-08T08:00:00.000Z",
      messages: [
        { id: "user-1", role: "user", content: "First prompt" },
        { id: "user-2", role: "user", content: "Second prompt" },
        { id: "user-3", role: "user", content: "Third prompt" },
        { id: "assistant-1", role: "assistant", content: "First answer" },
        { id: "assistant-2", role: "assistant", content: "Second answer" },
        { id: "assistant-3", role: "assistant", content: "Investigating now." }
      ],
      turns: [
        {
          createdAt: "2026-03-08T08:00:00.000Z",
          messages: [
            { id: "user-1", role: "user", content: "First prompt" },
            { id: "assistant-1", role: "assistant", content: "First answer" }
          ]
        },
        {
          createdAt: "2026-03-08T08:01:00.000Z",
          messages: [
            { id: "user-2", role: "user", content: "Second prompt" },
            { id: "assistant-2", role: "assistant", content: "Second answer" }
          ]
        },
        {
          createdAt: "2026-03-08T08:02:00.000Z",
          messages: [
            { id: "user-3", role: "user", content: "Third prompt" },
            { id: "assistant-3", role: "assistant", content: "Investigating now." }
          ]
        }
      ]
    });

    let messages = __TEST_ONLY__.mergeSnapshotMessages([], initialSnapshot);

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        threadId: "thread-emulated",
        timestamp: "2026-03-08T08:02:00.500Z",
        msg: {
          createdAt: "2026-03-08T08:00:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "apply_patch",
            input: "*** Begin Patch\n*** End Patch\n",
            call_id: "call-live-patch"
          }
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "message/completed",
      params: {
        threadId: "thread-emulated",
        message: {
          id: "assistant-4",
          role: "assistant",
          content: "Patch applied, continuing.",
          createdAt: "2026-03-08T08:00:00.000Z"
        }
      }
    });

    const refreshSnapshot = codexApiTest.parseMessagesFromThread("device-1", "thread-emulated", {
      createdAt: "2026-03-08T08:00:00.000Z",
      messages: [
        { id: "user-1", role: "user", content: "First prompt" },
        { id: "user-2", role: "user", content: "Second prompt" },
        { id: "user-3", role: "user", content: "Third prompt" },
        { id: "assistant-1", role: "assistant", content: "First answer" },
        { id: "assistant-2", role: "assistant", content: "Second answer" },
        { id: "assistant-3", role: "assistant", content: "Investigating now." },
        { id: "assistant-4", role: "assistant", content: "Patch applied, continuing." }
      ],
      turns: [
        {
          createdAt: "2026-03-08T08:00:00.000Z",
          messages: [
            { id: "user-1", role: "user", content: "First prompt" },
            { id: "assistant-1", role: "assistant", content: "First answer" }
          ]
        },
        {
          createdAt: "2026-03-08T08:01:00.000Z",
          messages: [
            { id: "user-2", role: "user", content: "Second prompt" },
            { id: "assistant-2", role: "assistant", content: "Second answer" }
          ]
        },
        {
          createdAt: "2026-03-08T08:02:00.000Z",
          messages: [
            { id: "user-3", role: "user", content: "Third prompt" },
            { id: "assistant-3", role: "assistant", content: "Investigating now." },
            { id: "assistant-4", role: "assistant", content: "Patch applied, continuing." }
          ]
        }
      ]
    });

    const merged = __TEST_ONLY__.mergeSnapshotMessages(messages, refreshSnapshot);

    expect(merged.map((message) => `${message.role}:${message.id}`)).toEqual([
      "user:user-1",
      "assistant:assistant-1",
      "user:user-2",
      "assistant:assistant-2",
      "user:user-3",
      "assistant:assistant-3",
      "tool:call-live-patch",
      "assistant:assistant-4"
    ]);
  });

  it("replays the real app-server send flow without letting repeated thread/read snapshots shove old assistant items past tool calls", () => {
    let messages = __TEST_ONLY__.mergeSnapshotMessages(
      [],
      codexApiTest.parseMessagesFromThread("device-1", "thread-real", {
        createdAt: "2026-03-08T09:39:28.104Z",
        updatedAt: "2026-03-08T09:39:28.104Z",
        turns: [
          {
            id: "turn-1",
            items: [
              {
                type: "userMessage",
                id: "item-1",
                content: [
                  {
                    type: "text",
                    text: "Use exec_command to run pwd and ls src/state. Then summarize the result."
                  }
                ]
              },
              {
                type: "agentMessage",
                id: "item-2",
                text:
                  "Ledger upkeep first: I’ll read `CONTINUITY.md` to sync state, then run `pwd` and `ls src/state` and summarize both outputs.",
                phase: "commentary"
              }
            ]
          }
        ]
      })
    );

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        conversationId: "thread-real",
        timestamp: "2026-03-08T09:39:28.747Z",
        msg: {
          createdAt: "2026-03-08T09:39:28.747Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "cat CONTINUITY.md",
              workdir: "/Users/shreyansh/Projects/codex-app-v2/apps/desktop"
            }),
            call_id: "call_lUXwe05wevdjrQxbZPKROCxa"
          }
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        conversationId: "thread-real",
        timestamp: "2026-03-08T09:39:28.861Z",
        msg: {
          createdAt: "2026-03-08T09:39:28.861Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_lUXwe05wevdjrQxbZPKROCxa",
            output:
              "Chunk ID: 30fa11\nWall time: 0.0519 seconds\nProcess exited with code 0\nOutput:\nGoal (incl. success criteria): ..."
          }
        }
      }
    });

    messages = __TEST_ONLY__.mergeSnapshotMessages(
      messages,
      codexApiTest.parseMessagesFromThread("device-1", "thread-real", {
        createdAt: "2026-03-08T09:39:05.539Z",
        updatedAt: "2026-03-08T09:39:40.754Z",
        turns: [
          {
            id: "turn-1",
            items: [
              {
                type: "userMessage",
                id: "item-1",
                content: [
                  {
                    type: "text",
                    text: "Use exec_command to run pwd and ls src/state. Then summarize the result."
                  }
                ]
              },
              {
                type: "agentMessage",
                id: "item-2",
                text:
                  "Ledger upkeep first: I’ll read `CONTINUITY.md` to sync state, then run `pwd` and `ls src/state` and summarize both outputs.",
                phase: "commentary"
              },
              {
                type: "agentMessage",
                id: "item-3",
                text: "I’ve synced the ledger context and I’m running the two requested shell commands now.",
                phase: "commentary"
              }
            ]
          }
        ]
      })
    );

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        conversationId: "thread-real",
        timestamp: "2026-03-08T09:39:40.754Z",
        msg: {
          createdAt: "2026-03-08T09:39:40.754Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "pwd",
              workdir: "/Users/shreyansh/Projects/codex-app-v2/apps/desktop"
            }),
            call_id: "call_AftYIZB2ob1Ifsaiu9hHdegi"
          }
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        conversationId: "thread-real",
        timestamp: "2026-03-08T09:39:40.754Z",
        msg: {
          createdAt: "2026-03-08T09:39:40.754Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "ls src/state",
              workdir: "/Users/shreyansh/Projects/codex-app-v2/apps/desktop"
            }),
            call_id: "call_8H9dJChSEHRmBcp1CTzdcjMC"
          }
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        conversationId: "thread-real",
        timestamp: "2026-03-08T09:39:40.842Z",
        msg: {
          createdAt: "2026-03-08T09:39:40.842Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_AftYIZB2ob1Ifsaiu9hHdegi",
            output:
              "Chunk ID: f6333f\nWall time: 0.0518 seconds\nProcess exited with code 0\nOutput:\n/Users/shreyansh/Projects/codex-app-v2/apps/desktop\n"
          }
        }
      }
    });

    messages = applyParsedMessage(messages, {
      method: "codex/event",
      params: {
        conversationId: "thread-real",
        timestamp: "2026-03-08T09:39:40.842Z",
        msg: {
          createdAt: "2026-03-08T09:39:40.842Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_8H9dJChSEHRmBcp1CTzdcjMC",
            output:
              "Chunk ID: 0e0226\nWall time: 0.0507 seconds\nProcess exited with code 0\nOutput:\nsessionMerge.ts\nuseAppStore.ts\n"
          }
        }
      }
    });

    messages = __TEST_ONLY__.mergeSnapshotMessages(
      messages,
      codexApiTest.parseMessagesFromThread("device-1", "thread-real", {
        createdAt: "2026-03-08T09:39:05.539Z",
        updatedAt: "2026-03-08T09:39:50.298Z",
        turns: [
          {
            id: "turn-1",
            items: [
              {
                type: "userMessage",
                id: "item-1",
                content: [
                  {
                    type: "text",
                    text: "Use exec_command to run pwd and ls src/state. Then summarize the result."
                  }
                ]
              },
              {
                type: "agentMessage",
                id: "item-2",
                text:
                  "Ledger upkeep first: I’ll read `CONTINUITY.md` to sync state, then run `pwd` and `ls src/state` and summarize both outputs.",
                phase: "commentary"
              },
              {
                type: "agentMessage",
                id: "item-3",
                text: "I’ve synced the ledger context and I’m running the two requested shell commands now.",
                phase: "commentary"
              },
              {
                type: "agentMessage",
                id: "item-4",
                text:
                  "Ledger Snapshot: Goal: run `pwd` and `ls src/state`; Now: both commands completed; Next: none; Open Questions: none.\n\n`pwd` returned `/Users/shreyansh/Projects/codex-app-v2/apps/desktop`.\n\n`ls src/state` returned:\n- `sessionMerge.ts`\n- `useAppStore.ts`",
                phase: "final_answer"
              }
            ]
          }
        ]
      })
    );

    expect(messages.map((message) => `${message.role}:${message.id}`)).toEqual([
      "user:item-1",
      "assistant:item-2",
      "tool:call_lUXwe05wevdjrQxbZPKROCxa",
      "assistant:item-3",
      "tool:call_AftYIZB2ob1Ifsaiu9hHdegi",
      "tool:call_8H9dJChSEHRmBcp1CTzdcjMC",
      "assistant:item-4"
    ]);
  });

  it("does not surface rollout scaffold messages as fake older history in a new chat", () => {
    const prompt = "What are the top news from today from the Iran-Israel war?";
    const optimistic: ChatMessage = {
      id: "local-prompt",
      key: "device-1::thread-real",
      threadId: "thread-real",
      deviceId: "device-1",
      role: "user",
      content: prompt,
      createdAt: "2026-03-08T09:58:46.900Z"
    };

    const rolloutMessages = [
      {
        kind: "message",
        id: "wrapper",
        role: "user",
        content:
          "# AGENTS.md instructions for /Users/shreyansh/Projects/misc\n\n<environment_context>...</environment_context>",
        createdAt: "2026-03-08T09:58:46.626Z",
        order: 0,
        sourceType: "response_item"
      },
      {
        kind: "message",
        id: "prompt",
        role: "user",
        content: prompt,
        createdAt: "2026-03-08T09:58:46.626Z",
        order: 1,
        sourceType: "event_msg"
      }
    ]
      .map((record) =>
        codexApiTest.toTimelineMessageFromRolloutRecord("device-1", "thread-real", record)
      )
      .filter((message): message is ChatMessage => message !== null);

    const merged = __TEST_ONLY__.mergeRolloutEnrichmentMessages([optimistic], rolloutMessages);
    expect(merged.map((message) => `${message.role}:${message.content}`)).toEqual([
      `user:${prompt}`
    ]);

    const window = resolveVisibleMessageWindow({
      messages: merged,
      visibleMessageCount: 40,
      anchorMessageKey: "local-prompt::user::"
    });
    expect(window.hiddenMessageCount).toBe(0);
    expect(window.visibleMessages).toHaveLength(1);
  });

  it("keeps rollout tools interleaved with snapshot chat messages after a stale thread/read refresh", () => {
    const snapshotMessages: ChatMessage[] = [
      {
        id: "item-1",
        key: "device-1::thread-real",
        threadId: "thread-real",
        deviceId: "device-1",
        role: "user",
        content: "I want all prime numbers from 1 - 100. Write a python script for that",
        createdAt: "2026-03-08T10:34:48.000Z",
        timelineOrder: 0
      },
      {
        id: "item-2",
        key: "device-1::thread-real",
        threadId: "thread-real",
        deviceId: "device-1",
        role: "assistant",
        content:
          "I’m checking the workspace layout first, then I’ll add a small Python script that prints all primes from 1 to 100 and verify it runs.",
        createdAt: "2026-03-08T10:34:48.000Z",
        timelineOrder: 1
      },
      {
        id: "item-3",
        key: "device-1::thread-real",
        threadId: "thread-real",
        deviceId: "device-1",
        role: "assistant",
        content:
          "The workspace is minimal, so I’m adding a standalone script at the repo root rather than modifying existing files. After that I’ll run it once to confirm the output.",
        createdAt: "2026-03-08T10:34:48.000Z",
        timelineOrder: 2
      },
      {
        id: "item-4",
        key: "device-1::thread-real",
        threadId: "thread-real",
        deviceId: "device-1",
        role: "assistant",
        content:
          "Created `primes_1_to_100.py`. It prints all prime numbers from 1 to 100.",
        createdAt: "2026-03-08T10:34:48.000Z",
        timelineOrder: 3
      }
    ];

    const rolloutMessages: ChatMessage[] = [
      {
        id: "message-user",
        key: "device-1::thread-real",
        threadId: "thread-real",
        deviceId: "device-1",
        role: "user",
        content: "I want all prime numbers from 1 - 100. Write a python script for that",
        createdAt: "2026-03-08T10:34:26.740Z",
        timelineOrder: 0
      },
      {
        id: "message-assistant-1",
        key: "device-1::thread-real",
        threadId: "thread-real",
        deviceId: "device-1",
        role: "assistant",
        content:
          "I’m checking the workspace layout first, then I’ll add a small Python script that prints all primes from 1 to 100 and verify it runs.",
        createdAt: "2026-03-08T10:34:36.247Z",
        timelineOrder: 1
      },
      {
        id: "call-apply-patch",
        key: "device-1::thread-real",
        threadId: "thread-real",
        deviceId: "device-1",
        role: "tool",
        eventType: "tool_call",
        content:
          "Tool: apply_patch\n\nInput:\n*** Begin Patch\n*** Add File: primes_1_to_100.py",
        createdAt: "2026-03-08T10:34:37.920Z",
        timelineOrder: 2,
        toolCall: {
          name: "apply_patch",
          input: "*** Begin Patch\n*** Add File: primes_1_to_100.py",
          status: "completed"
        }
      },
      {
        id: "message-assistant-2",
        key: "device-1::thread-real",
        threadId: "thread-real",
        deviceId: "device-1",
        role: "assistant",
        content:
          "The workspace is minimal, so I’m adding a standalone script at the repo root rather than modifying existing files. After that I’ll run it once to confirm the output.",
        createdAt: "2026-03-08T10:34:41.920Z",
        timelineOrder: 3
      },
      {
        id: "call-exec-command",
        key: "device-1::thread-real",
        threadId: "thread-real",
        deviceId: "device-1",
        role: "tool",
        eventType: "tool_call",
        content: "Tool: exec_command\n\nInput:\npython3 /Users/shreyansh/Projects/misc/primes_1_to_100.py",
        createdAt: "2026-03-08T10:34:42.515Z",
        timelineOrder: 4,
        toolCall: {
          name: "exec_command",
          input: "python3 /Users/shreyansh/Projects/misc/primes_1_to_100.py",
          output:
            "[2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97]",
          status: "completed"
        }
      },
      {
        id: "message-assistant-3",
        key: "device-1::thread-real",
        threadId: "thread-real",
        deviceId: "device-1",
        role: "assistant",
        content:
          "Created `primes_1_to_100.py`. It prints all prime numbers from 1 to 100.",
        createdAt: "2026-03-08T10:34:48.130Z",
        timelineOrder: 5
      }
    ];

    const base = __TEST_ONLY__.mergeSnapshotMessages([], snapshotMessages);
    const enriched = __TEST_ONLY__.mergeRolloutEnrichmentMessages(base, rolloutMessages);
    const refreshed = __TEST_ONLY__.mergeSnapshotMessages(enriched, snapshotMessages);

    expect(refreshed.map((message) => [message.id, message.role, message.createdAt])).toEqual([
      ["item-1", "user", "2026-03-08T10:34:26.740Z"],
      ["item-2", "assistant", "2026-03-08T10:34:36.247Z"],
      ["call-apply-patch", "tool", "2026-03-08T10:34:37.920Z"],
      ["item-3", "assistant", "2026-03-08T10:34:41.920Z"],
      ["call-exec-command", "tool", "2026-03-08T10:34:42.515Z"],
      ["item-4", "assistant", "2026-03-08T10:34:48.130Z"]
    ]);
  });

  it("keeps load-older expansion working in the same emulated transcript path", () => {
    const messages: ChatMessage[] = Array.from({ length: 45 }, (_, index) => ({
      id: `assistant-${index + 1}`,
      key: "device-1::thread-emulated",
      threadId: "thread-emulated",
      deviceId: "device-1",
      role: "assistant",
      content: `message ${index + 1}`,
      createdAt: `2026-03-08T08:${String(index).padStart(2, "0")}:00.000Z`
    }));

    const initialWindow = resolveVisibleMessageWindow({
      messages,
      visibleMessageCount: 40,
      anchorMessageKey: null
    });
    const expandedWindow = resolveVisibleMessageWindow({
      messages,
      visibleMessageCount: 45,
      anchorMessageKey: "assistant-1::assistant::"
    });

    expect(initialWindow.hiddenMessageCount).toBe(5);
    expect(expandedWindow.hiddenMessageCount).toBe(0);
    expect(expandedWindow.visibleMessages).toHaveLength(45);
  });

  it("replays mixed live + snapshot + rollout convergence from the shared fixture corpus", () => {
    const fixture = chronologyReplayFixtureById["live-snapshot-rollout-tool-convergence"];
    const messages = applyChronologyReplayFixture(fixture);

    expect(messageRoleIdOrder(messages)).toEqual(fixture.expectedOrder);
    expectToolBubblesToMatch(messages, fixture.expectedToolBubbles);
  });

  it("does not collapse distinct turns when the upstream call_id is reused", () => {
    const fixture = chronologyReplayFixtureById["reused-call-id-across-turns"];
    const messages = applyChronologyReplayFixture(fixture);

    expect(messageRoleIdOrder(messages)).toEqual(fixture.expectedOrder);
    expectToolBubblesToMatch(messages, fixture.expectedToolBubbles);
  });
});
