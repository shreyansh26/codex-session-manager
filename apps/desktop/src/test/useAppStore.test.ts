import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  ComposerPreference,
  ThreadTokenUsageState
} from "../domain/types";
import { __TEST_ONLY__ } from "../state/useAppStore";
import {
  chronologyReplayFixtureById,
  type ExpectedToolBubble
} from "../../../../../codex-app-electron/src/renderer/src/test/chronologyReplayFixtures";
import {
  applyChronologyReplayFixture,
  messageRoleIdOrder
} from "./chronologyReplayHarness";

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
      content: "Which model are you",
      createdAt: "2026-03-02T12:00:00.000Z"
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
        id: "reasoning-1::2026-03-02T12:00:00.000Z",
        role: "system",
        eventType: "reasoning",
        content: "Planning latest headlines",
        createdAt: "2026-03-02T12:00:00.000Z"
      }),
      buildMessage({
        id: "reasoning-1::2026-03-02T12:00:05.000Z",
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
      id: "reasoning-1::2026-03-02T12:00:00.000Z",
      eventType: "reasoning",
      content: "Planning latest headlines"
    });
    expect(merged[1]).toMatchObject({
      id: "reasoning-1::2026-03-02T12:00:05.000Z",
      eventType: "reasoning",
      content: "Planning latest headlines across multiple sources"
    });
    expect(merged[2]).toMatchObject({
      id: "assistant-1",
      role: "assistant"
    });
  });

  it("merges tool output into an existing tool call bubble", () => {
    const started = buildMessage({
      id: "tool-1",
      role: "tool",
      eventType: "tool_call",
      content: "Tool: exec_command\n\nInput:\nrg --files",
      createdAt: "2026-03-02T12:00:00.000Z",
      toolCall: {
        name: "exec_command",
        input: "rg --files",
        status: "running"
      }
    });
    const completed = buildMessage({
      id: "tool-1",
      role: "tool",
      eventType: "tool_call",
      content:
        "Tool: exec_command\n\nInput:\nrg --files\n\nOutput:\nProcess exited with code 0",
      createdAt: "2026-03-02T12:00:03.000Z",
      toolCall: {
        name: "exec_command",
        input: "rg --files",
        output: "Process exited with code 0",
        status: "completed"
      }
    });

    const next = __TEST_ONLY__.upsertMessage([started], completed);

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: "tool-1",
      eventType: "tool_call",
      createdAt: "2026-03-02T12:00:00.000Z",
      toolCall: {
        name: "exec_command",
        input: "rg --files",
        output: "Process exited with code 0",
        status: "completed"
      }
    });
  });

  it("does not merge repeated tool calls from different turns when ids differ", () => {
    const previousTurnTool = buildMessage({
      id: "tool-previous",
      role: "tool",
      eventType: "tool_call",
      content:
        "Tool: exec_command\n\nInput:\nnpm run test\n\nOutput:\nProcess exited with code 0",
      createdAt: "2026-03-02T12:00:00.000Z",
      toolCall: {
        name: "exec_command",
        input: "npm run test",
        output: "Process exited with code 0",
        status: "completed"
      }
    });
    const currentTurnTool = buildMessage({
      id: "tool-current",
      role: "tool",
      eventType: "tool_call",
      content:
        "Tool: exec_command\n\nInput:\nnpm run test\n\nOutput:\nProcess exited with code 0",
      createdAt: "2026-03-02T12:01:00.000Z",
      toolCall: {
        name: "exec_command",
        input: "npm run test",
        output: "Process exited with code 0",
        status: "completed"
      }
    });

    const next = __TEST_ONLY__.upsertMessage([previousTurnTool], currentTurnTool);

    expect(next.map((message) => message.id)).toEqual(["tool-previous", "tool-current"]);
  });

  it("does not merge repeated assistant messages from different turns when ids differ", () => {
    const previousAssistant = buildMessage({
      id: "assistant-previous",
      role: "assistant",
      content: "Checking the parser now.",
      createdAt: "2026-03-02T12:00:00.000Z"
    });
    const currentAssistant = buildMessage({
      id: "assistant-current",
      role: "assistant",
      content: "Checking the parser now.",
      createdAt: "2026-03-02T12:01:00.000Z"
    });

    const next = __TEST_ONLY__.upsertMessage([previousAssistant], currentAssistant);

    expect(next.map((message) => message.id)).toEqual([
      "assistant-previous",
      "assistant-current"
    ]);
  });

  it("replaces stale server snapshot entries while retaining pending optimistic user messages", () => {
    const staleAssistant = buildMessage({
      id: "assistant-old",
      role: "assistant",
      content: "Old answer",
      createdAt: "2026-03-02T12:00:04.000Z"
    });
    const optimisticUser = buildMessage({
      id: "local-pending",
      role: "user",
      content: "Follow-up question",
      createdAt: new Date().toISOString()
    });
    const next = __TEST_ONLY__.mergeSnapshotMessages(
      [staleAssistant, optimisticUser],
      [
        buildMessage({
          id: "assistant-new",
          role: "assistant",
          content: "New authoritative answer",
          createdAt: "2026-03-02T12:00:08.000Z"
        })
      ]
    );

    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({
      id: "assistant-new",
      content: "New authoritative answer"
    });
    expect(next[1]).toMatchObject({
      id: "local-pending",
      role: "user",
      content: "Follow-up question"
    });
  });

  it("retains tool call cards across base snapshot replacement", () => {
    const existingToolCall = buildMessage({
      id: "tool-existing",
      role: "tool",
      eventType: "tool_call",
      content: "Tool: exec_command\n\nInput:\nrg --files",
      createdAt: "2026-03-02T12:00:06.000Z",
      toolCall: {
        name: "exec_command",
        input: "rg --files",
        status: "completed"
      }
    });

    const next = __TEST_ONLY__.mergeSnapshotMessages(
      [existingToolCall],
      [
        buildMessage({
          id: "assistant-new",
          role: "assistant",
          content: "Fresh base snapshot response",
          createdAt: "2026-03-02T12:00:08.000Z"
        })
      ]
    );

    expect(next.map((message) => message.id)).toEqual([
      "tool-existing",
      "assistant-new"
    ]);
    expect(next[0]).toMatchObject({
      id: "tool-existing",
      eventType: "tool_call"
    });
  });

  it("keeps the triggering user message ahead of retained tool calls after snapshot acknowledgement", () => {
    const now = Date.now();
    const optimisticCreatedAt = new Date(now - 3_000).toISOString();
    const toolCreatedAt = new Date(now - 2_000).toISOString();
    const acknowledgedCreatedAt = new Date(now - 1_000).toISOString();

    const optimisticUser = buildMessage({
      id: "local-prompt",
      role: "user",
      content: "Run rg --files",
      createdAt: optimisticCreatedAt
    });
    const liveToolCall = buildMessage({
      id: "tool-live",
      role: "tool",
      eventType: "tool_call",
      content: "Tool: exec_command\n\nInput:\nrg --files",
      createdAt: toolCreatedAt,
      toolCall: {
        name: "exec_command",
        input: "rg --files",
        status: "running"
      }
    });

    const next = __TEST_ONLY__.mergeSnapshotMessages(
      [optimisticUser, liveToolCall],
      [
        buildMessage({
          id: "srv-prompt",
          role: "user",
          content: "Run rg --files",
          createdAt: acknowledgedCreatedAt
        })
      ]
    );

    expect(next.map((message) => `${message.role}:${message.id}`)).toEqual([
      "user:srv-prompt",
      "tool:tool-live"
    ]);
    expect(next[0]).toMatchObject({
      createdAt: optimisticCreatedAt
    });
  });

  it("keeps assistant and tool snapshot entries separate when they share an id", () => {
    const next = __TEST_ONLY__.mergeSnapshotMessages([], [
      buildMessage({
        id: "shared-upstream-id",
        role: "assistant",
        content: "Running the command now.",
        createdAt: "2026-03-02T12:00:08.000Z"
      }),
      buildMessage({
        id: "shared-upstream-id",
        role: "tool",
        eventType: "tool_call",
        content:
          "Tool: exec_command\n\nInput:\nrg --files\n\nOutput:\nProcess exited with code 0",
        createdAt: "2026-03-02T12:00:09.000Z",
        toolCall: {
          name: "exec_command",
          input: "rg --files",
          output: "Process exited with code 0",
          status: "completed"
        }
      })
    ]);

    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({
      id: "shared-upstream-id",
      role: "assistant",
      content: "Running the command now."
    });
    expect(next[1]).toMatchObject({
      id: "shared-upstream-id",
      role: "tool",
      eventType: "tool_call",
      toolCall: {
        name: "exec_command",
        output: "Process exited with code 0",
        status: "completed"
      }
    });
  });

  it("merges rollout enrichment additively without dropping newer live messages", () => {
    const liveMessages = [
      buildMessage({
        id: "assistant-live",
        role: "assistant",
        content: "Current live answer",
        createdAt: "2026-03-02T12:00:10.000Z"
      }),
      buildMessage({
        id: "tool-live",
        role: "tool",
        eventType: "tool_call",
        content: "Tool: exec_command\n\nInput:\nrg --files",
        createdAt: "2026-03-02T12:00:11.000Z",
        toolCall: {
          name: "exec_command",
          input: "rg --files",
          status: "running"
        }
      })
    ];

    const enriched = __TEST_ONLY__.mergeRolloutEnrichmentMessages(liveMessages, [
      buildMessage({
        id: "tool-live",
        role: "tool",
        eventType: "tool_call",
        content:
          "Tool: exec_command\n\nInput:\nrg --files\n\nOutput:\nProcess exited with code 0",
        createdAt: "2026-03-02T12:00:12.000Z",
        toolCall: {
          name: "exec_command",
          input: "rg --files",
          output: "Process exited with code 0",
          status: "completed"
        }
      }),
      buildMessage({
        id: "assistant-history",
        role: "assistant",
        content: "Earlier rollout-backed answer",
        createdAt: "2026-03-02T12:00:05.000Z"
      })
    ]);

    expect(enriched).toHaveLength(3);
    expect(enriched.map((message) => message.id)).toEqual([
      "assistant-history",
      "assistant-live",
      "tool-live"
    ]);
    expect(enriched[2]).toMatchObject({
      toolCall: {
        name: "exec_command",
        output: "Process exited with code 0",
        status: "completed"
      }
    });
  });

  it("keeps the triggering user message ahead of rollout tool history when thread/read used a later user timestamp", () => {
    const baseThreadReadMessages = [
      buildMessage({
        id: "thread-read-user",
        role: "user",
        content: "Inspect the timeline",
        createdAt: "2026-03-02T12:00:05.000Z"
      })
    ];

    const enriched = __TEST_ONLY__.mergeRolloutEnrichmentMessages(
      baseThreadReadMessages,
      [
        buildMessage({
          id: "rollout-user",
          role: "user",
          content: "Inspect the timeline",
          createdAt: "2026-03-02T12:00:00.000Z"
        }),
        buildMessage({
          id: "rollout-tool",
          role: "tool",
          eventType: "tool_call",
          content: "Tool: exec_command\n\nInput:\nrg timeline",
          createdAt: "2026-03-02T12:00:01.000Z",
          toolCall: {
            name: "exec_command",
            input: "rg timeline",
            status: "completed"
          }
        })
      ]
    );

    expect(enriched.map((message) => [message.role, message.createdAt])).toEqual([
      ["user", "2026-03-02T12:00:00.000Z"],
      ["tool", "2026-03-02T12:00:01.000Z"]
    ]);
    expect(enriched[0]).toMatchObject({
      role: "user",
      content: "Inspect the timeline"
    });
  });

  it("merges restamped snapshot chat items back onto rollout twins so tools stay interleaved", () => {
    const snapshotMessages = [
      buildMessage({
        id: "item-1",
        role: "user",
        content: "I want all prime numbers from 1 - 100. Write a python script for that",
        createdAt: "2026-03-08T10:34:48.000Z",
        timelineOrder: 0
      }),
      buildMessage({
        id: "item-2",
        role: "assistant",
        content:
          "I’m checking the workspace layout first, then I’ll add a small Python script that prints all primes from 1 to 100 and verify it runs.",
        createdAt: "2026-03-08T10:34:48.000Z",
        timelineOrder: 1
      }),
      buildMessage({
        id: "item-3",
        role: "assistant",
        content:
          "The workspace is minimal, so I’m adding a standalone script at the repo root rather than modifying existing files. After that I’ll run it once to confirm the output.",
        createdAt: "2026-03-08T10:34:48.000Z",
        timelineOrder: 2
      }),
      buildMessage({
        id: "item-4",
        role: "assistant",
        content:
          "Created `primes_1_to_100.py`. It prints all prime numbers from 1 to 100.",
        createdAt: "2026-03-08T10:34:48.000Z",
        timelineOrder: 3
      })
    ];

    const enriched = __TEST_ONLY__.mergeRolloutEnrichmentMessages(snapshotMessages, [
      buildMessage({
        id: "message-user",
        role: "user",
        content: "I want all prime numbers from 1 - 100. Write a python script for that",
        createdAt: "2026-03-08T10:34:26.740Z",
        timelineOrder: 0
      }),
      buildMessage({
        id: "message-assistant-1",
        role: "assistant",
        content:
          "I’m checking the workspace layout first, then I’ll add a small Python script that prints all primes from 1 to 100 and verify it runs.",
        createdAt: "2026-03-08T10:34:36.247Z",
        timelineOrder: 1
      }),
      buildMessage({
        id: "call-apply-patch",
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
      }),
      buildMessage({
        id: "message-assistant-2",
        role: "assistant",
        content:
          "The workspace is minimal, so I’m adding a standalone script at the repo root rather than modifying existing files. After that I’ll run it once to confirm the output.",
        createdAt: "2026-03-08T10:34:41.920Z",
        timelineOrder: 3
      }),
      buildMessage({
        id: "call-exec-command",
        role: "tool",
        eventType: "tool_call",
        content: "Tool: exec_command\n\nInput:\npython3 primes_1_to_100.py",
        createdAt: "2026-03-08T10:34:42.515Z",
        timelineOrder: 4,
        toolCall: {
          name: "exec_command",
          input: "python3 primes_1_to_100.py",
          output: "[2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97]",
          status: "completed"
        }
      }),
      buildMessage({
        id: "message-assistant-3",
        role: "assistant",
        content:
          "Created `primes_1_to_100.py`. It prints all prime numbers from 1 to 100.",
        createdAt: "2026-03-08T10:34:48.130Z",
        timelineOrder: 5
      })
    ]);

    expect(enriched.map((message) => [message.id, message.role, message.createdAt])).toEqual([
      ["item-1", "user", "2026-03-08T10:34:26.740Z"],
      ["item-2", "assistant", "2026-03-08T10:34:36.247Z"],
      ["call-apply-patch", "tool", "2026-03-08T10:34:37.920Z"],
      ["item-3", "assistant", "2026-03-08T10:34:41.920Z"],
      ["call-exec-command", "tool", "2026-03-08T10:34:42.515Z"],
      ["item-4", "assistant", "2026-03-08T10:34:48.130Z"]
    ]);
  });

  it("keeps exact same snapshot item ids pinned to their first rendered timestamp across later thread/read refreshes", () => {
    const existing = [
      buildMessage({
        id: "item-1",
        role: "user",
        content: "Use exec_command to run pwd and ls src/state. Then summarize the result.",
        createdAt: "2026-03-08T09:39:28.104Z",
        timelineOrder: 0
      }),
      buildMessage({
        id: "item-2",
        role: "assistant",
        content:
          "Ledger upkeep first: I’ll read `CONTINUITY.md` to sync state, then run `pwd` and `ls src/state` and summarize both outputs.",
        createdAt: "2026-03-08T09:39:28.104Z",
        timelineOrder: 1
      }),
      buildMessage({
        id: "call-live-tool",
        role: "tool",
        eventType: "tool_call",
        content: "Tool: exec_command\n\nInput:\npwd",
        createdAt: "2026-03-08T09:39:28.747Z",
        timelineOrder: 2,
        toolCall: {
          name: "exec_command",
          input: "pwd",
          status: "completed"
        }
      })
    ];

    const next = __TEST_ONLY__.mergeSnapshotMessages(existing, [
      buildMessage({
        id: "item-1",
        role: "user",
        content: "Use exec_command to run pwd and ls src/state. Then summarize the result.",
        createdAt: "2026-03-08T09:39:40.754Z",
        timelineOrder: 0
      }),
      buildMessage({
        id: "item-2",
        role: "assistant",
        content:
          "Ledger upkeep first: I’ll read `CONTINUITY.md` to sync state, then run `pwd` and `ls src/state` and summarize both outputs.",
        createdAt: "2026-03-08T09:39:40.754Z",
        timelineOrder: 1
      }),
      buildMessage({
        id: "item-3",
        role: "assistant",
        content: "I’ve synced the ledger context and I’m running the two requested shell commands now.",
        createdAt: "2026-03-08T09:39:40.754Z",
        timelineOrder: 2
      })
    ]);

    expect(next.map((message) => [message.id, message.createdAt])).toEqual([
      ["item-1", "2026-03-08T09:39:28.104Z"],
      ["item-2", "2026-03-08T09:39:28.104Z"],
      ["call-live-tool", "2026-03-08T09:39:28.747Z"],
      ["item-3", "2026-03-08T09:39:40.754Z"]
    ]);
  });

  it("replays mixed live+snapshot+rollout convergence from the shared chronology corpus", () => {
    const fixture = chronologyReplayFixtureById["live-snapshot-rollout-tool-convergence"];
    const messages = applyChronologyReplayFixture(fixture);

    expect(messageRoleIdOrder(messages)).toEqual(fixture.expectedOrder);
    expectToolBubblesToMatch(messages, fixture.expectedToolBubbles);
  });

  it("preserves distinct tool bubbles when the same upstream call_id is reused across turns", () => {
    const fixture = chronologyReplayFixtureById["reused-call-id-across-turns"];
    const messages = applyChronologyReplayFixture(fixture);

    expect(messageRoleIdOrder(messages)).toEqual(fixture.expectedOrder);
    expectToolBubblesToMatch(messages, fixture.expectedToolBubbles);
  });
});

describe("useAppStore composer preference helpers", () => {
  it("defaults to catalog model and its configured default effort when missing", () => {
    expect(
      __TEST_ONLY__.toComposerPreference({
        model: undefined,
        effort: undefined
      })
    ).toEqual({
      model: "gpt-5.3-codex",
      thinkingEffort: "xhigh"
    });
  });

  it("coerces unsupported effort to nearest valid default for selected model", () => {
    expect(
      __TEST_ONLY__.toComposerPreference({
        model: "gpt-5.1-codex-mini",
        effort: "xhigh"
      })
    ).toEqual({
      model: "gpt-5.1-codex-mini",
      thinkingEffort: "medium"
    });
  });

  it("keeps existing preference map reference when no change is needed", () => {
    const initial = {
      "device-1::thread-1": {
        model: "gpt-5.2-codex",
        thinkingEffort: "high"
      }
    } as const;
    const next = __TEST_ONLY__.upsertComposerPreference(
      initial,
      "device-1::thread-1",
      "gpt-5.2-codex",
      "high"
    );
    expect(next).toBe(initial);
  });

  it("updates effort when switching to model with narrower effort support", () => {
    const initial: Record<string, ComposerPreference> = {
      "device-1::thread-1": {
        model: "gpt-5.2-codex",
        thinkingEffort: "xhigh"
      }
    };
    const next = __TEST_ONLY__.upsertComposerPreference(
      initial,
      "device-1::thread-1",
      "gpt-5.1-codex-mini",
      undefined
    );
    expect(next).not.toBe(initial);
    expect(next["device-1::thread-1"]).toEqual({
      model: "gpt-5.1-codex-mini",
      thinkingEffort: "medium"
    });
  });

  it("keeps existing model when no explicit model override is provided", () => {
    const initial: Record<string, ComposerPreference> = {
      "device-1::thread-1": {
        model: "gpt-5.3-codex",
        thinkingEffort: "xhigh"
      }
    };
    const next = __TEST_ONLY__.upsertComposerPreference(
      initial,
      "device-1::thread-1",
      undefined,
      undefined
    );

    expect(next).toBe(initial);
    expect(next["device-1::thread-1"]).toEqual({
      model: "gpt-5.3-codex",
      thinkingEffort: "xhigh"
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

    // First application should not undercount: anchor to total usage snapshot.
    expect(first.nextCostUsd).toBeCloseTo(0.006025, 9);
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
