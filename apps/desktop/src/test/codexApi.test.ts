import { describe, expect, it } from "vitest";
import {
  __TEST_ONLY__ as codexApiTest,
  buildTurnStartAttempts,
  joinPosixPath,
  normalizePosixPath,
  parseToolMessagesFromRolloutJsonl,
  parentPosixPath,
  parseLsDirectoryEntries
} from "../services/codexApi";
import type { ChatImageAttachment, ChatMessage, ComposerSubmission } from "../domain/types";
import { parseRpcNotification } from "../services/eventParser";
import {
  chronologyReplayFixtureById,
  existingSessionChronologyFixture
} from "./chronologyReplayFixtures";
import { responseItemClassifierFixture } from "./reopenedSessionDiagnosticFixtures";

const sampleImage = (url: string): ChatImageAttachment => ({
  id: "img-1",
  url,
  mimeType: "image/png"
});

const hasStringInputFallback = (attempts: Array<Record<string, unknown>>): boolean =>
  attempts.some((attempt) => typeof attempt.input === "string");

describe("buildTurnStartAttempts", () => {
  it("does not include text-only fallback attempts when images are attached", () => {
    const submission: ComposerSubmission = {
      prompt: "What does this image show?",
      images: [sampleImage("data:image/png;base64,abc123")],
      model: "gpt-5.3-codex",
      thinkingEffort: "high"
    };

    const attempts = buildTurnStartAttempts("thread-1", submission);
    expect(attempts.length).toBeGreaterThan(0);
    expect(hasStringInputFallback(attempts)).toBe(false);
    expect(
      attempts.every(
        (attempt) =>
          attempt.model === "gpt-5.3-codex" &&
          JSON.stringify(attempt.reasoning) === JSON.stringify({ effort: "high" })
      )
    ).toBe(true);

    const serializedInputs = attempts
      .map((attempt) => JSON.stringify(attempt.input))
      .join("\n");
    expect(serializedInputs).not.toContain("input_text");
    expect(serializedInputs).not.toContain("input_image");
    expect(serializedInputs).toContain("image");
    expect(serializedInputs).toContain("abc123");
  });

  it("keeps legacy string fallback for text-only submissions", () => {
    const attempts = buildTurnStartAttempts("thread-2", {
      prompt: "Hello",
      images: [],
      model: "gpt-5.2",
      thinkingEffort: "xhigh"
    });

    expect(attempts.length).toBeGreaterThan(0);
    expect(hasStringInputFallback(attempts)).toBe(true);
    expect(attempts.some((attempt) => attempt.input === "Hello")).toBe(true);
    expect(attempts.every((attempt) => typeof attempt.threadId === "string")).toBe(
      true
    );
    expect(attempts.some((attempt) => "thread_id" in attempt)).toBe(false);
    expect(
      attempts.every(
        (attempt) =>
          attempt.model === "gpt-5.2" &&
          JSON.stringify(attempt.reasoning) === JSON.stringify({ effort: "xhigh" })
      )
    ).toBe(true);
  });

  it("supports image-only submissions without introducing string fallbacks", () => {
    const attempts = buildTurnStartAttempts("thread-3", {
      prompt: "",
      images: [sampleImage("data:image/png;base64,def456")],
      model: "gpt-5.1-codex-mini",
      thinkingEffort: "medium"
    });

    expect(attempts.length).toBeGreaterThan(0);
    expect(hasStringInputFallback(attempts)).toBe(false);

    const serializedInputs = attempts
      .map((attempt) => JSON.stringify(attempt.input))
      .join("\n");
    expect(serializedInputs).toContain("def456");
    expect(attempts.every((attempt) => typeof attempt.threadId === "string")).toBe(
      true
    );
    expect(
      attempts.every(
        (attempt) =>
          attempt.model === "gpt-5.1-codex-mini" &&
          JSON.stringify(attempt.reasoning) === JSON.stringify({ effort: "medium" })
      )
    ).toBe(true);
  });
});

describe("posix path helpers", () => {
  it("normalizes path segments and trailing slashes", () => {
    expect(normalizePosixPath("/Users/demo//projects///app/")).toBe(
      "/Users/demo/projects/app"
    );
    expect(normalizePosixPath("./src/../test/")).toBe("test");
    expect(normalizePosixPath("")).toBe(".");
  });

  it("computes parent path safely", () => {
    expect(parentPosixPath("/Users/demo/projects/app")).toBe("/Users/demo/projects");
    expect(parentPosixPath("/")).toBe("/");
    expect(parentPosixPath("relative/path")).toBe("relative");
    expect(parentPosixPath("single")).toBe(".");
  });

  it("joins child directories into normalized paths", () => {
    expect(joinPosixPath("/Users/demo", "projects")).toBe("/Users/demo/projects");
    expect(joinPosixPath("/", "tmp")).toBe("/tmp");
    expect(joinPosixPath(".", "src")).toBe("src");
  });
});

describe("parseLsDirectoryEntries", () => {
  it("returns parent entry and directory-only children sorted", () => {
    const entries = parseLsDirectoryEntries(
      "src/\nREADME.md\n.node/\n.gitignore\nassets/\n",
      "/Users/demo/project"
    );

    expect(entries).toEqual([
      { kind: "parent", name: "..", path: "/Users/demo" },
      { kind: "directory", name: ".node", path: "/Users/demo/project/.node" },
      { kind: "directory", name: "assets", path: "/Users/demo/project/assets" },
      { kind: "directory", name: "src", path: "/Users/demo/project/src" }
    ]);
  });

  it("does not add parent entry when cwd is root", () => {
    const entries = parseLsDirectoryEntries("tmp/\nusr/\n", "/");
    expect(entries).toEqual([
      { kind: "directory", name: "tmp", path: "/tmp" },
      { kind: "directory", name: "usr", path: "/usr" }
    ]);
  });
});

describe("parseToolMessagesFromRolloutJsonl", () => {
  it("pairs function_call records with function_call_output records", () => {
    const jsonl = [
      JSON.stringify({
        timestamp: "2026-03-08T04:48:18.714Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: "git status --short",
            workdir: "/Users/shreyansh/Projects/codex-app-v2/apps/desktop"
          }),
          call_id: "call_exec_1"
        }
      }),
      JSON.stringify({
        timestamp: "2026-03-08T04:48:18.825Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_exec_1",
          output:
            "Chunk ID: 123abc\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\n M src/App.tsx"
        }
      })
    ].join("\n");

    const messages = parseToolMessagesFromRolloutJsonl(
      "device-1",
      "thread-1",
      jsonl
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "call_exec_1",
      role: "tool",
      eventType: "tool_call",
      toolCall: {
        name: "exec_command",
        status: "completed"
      }
    });
    expect(messages[0].toolCall?.input).toContain("\"cmd\": \"git status --short\"");
    expect(messages[0].toolCall?.output).toContain("Process exited with code 0");
  });

  it("parses custom tool calls and extracts the nested output text", () => {
    const jsonl = [
      JSON.stringify({
        timestamp: "2026-03-08T04:48:37.744Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call_patch_1",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch\n"
        }
      }),
      JSON.stringify({
        timestamp: "2026-03-08T04:48:37.785Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call_patch_1",
          output: JSON.stringify({
            output: "Success. Updated the following files:\nM /tmp/example.ts\n",
            metadata: {
              exit_code: 0
            }
          })
        }
      })
    ].join("\n");

    const messages = parseToolMessagesFromRolloutJsonl(
      "device-1",
      "thread-1",
      jsonl
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "call_patch_1",
      toolCall: {
        name: "apply_patch",
        input: "*** Begin Patch\n*** End Patch\n",
        output: "Success. Updated the following files:\nM /tmp/example.ts",
        status: "completed"
      }
    });
  });

  it("parses web_search_call rollout records into tool messages", () => {
    const jsonl = [
      JSON.stringify({
        timestamp: "2026-03-08T10:15:55.487Z",
        type: "response_item",
        payload: {
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "site:investing.com Reuters March 8 2026 Gulf attacks Iran war",
            queries: [
              "site:investing.com Reuters March 8 2026 Gulf attacks Iran war",
              "site:investing.com Reuters March 8 2026 oil prices Hormuz Iran war"
            ]
          }
        }
      })
    ].join("\n");

    const messages = parseToolMessagesFromRolloutJsonl(
      "device-1",
      "thread-1",
      jsonl
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "tool",
      eventType: "tool_call",
      toolCall: {
        name: "web_search",
        status: "completed"
      }
    });
    expect(messages[0].toolCall?.input).toContain(
      '"query": "site:investing.com Reuters March 8 2026 Gulf attacks Iran war"'
    );
  });
});

describe("shared chronology replay fixtures", () => {
  it("preserves explicit tool-call structure for equal-timestamp snapshot items", () => {
    const fixture = chronologyReplayFixtureById["equal-timestamps-timeline-order"];
    const snapshotStep = fixture.steps.find((step) => step.source === "thread_read");
    expect(snapshotStep?.source).toBe("thread_read");
    if (!snapshotStep || snapshotStep.source !== "thread_read") {
      throw new Error("Missing equal timestamp snapshot step");
    }

    const messages = codexApiTest.parseMessagesFromThread(
      "device-1",
      fixture.threadId,
      snapshotStep.snapshot
    );

    expect(messages[2]).toMatchObject({
      id: "tool-equal",
      role: "tool",
      eventType: "tool_call",
      toolCall: {
        name: "exec_command",
        input: "pwd",
        status: "completed"
      }
    });
  });

  it("keeps reused call_id parser identity stable across turns under collision pressure", () => {
    const fixture = chronologyReplayFixtureById["reused-call-id-across-turns"];
    const parsedToolIds = fixture.steps
      .filter((step) => step.source === "live")
      .map((step) =>
        step.source === "live" ? parseRpcNotification("device-1", step.notification) : null
      )
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .filter((value) => value.message.eventType === "tool_call")
      .map((value) => value.message.id);

    expect(parsedToolIds).toEqual([
      "call-reused",
      "call-reused",
      "call-reused",
      "call-reused"
    ]);
  });
});

describe("parseMessagesFromThread", () => {
  it("prefers turn order over grouped flat thread messages when per-message timestamps are missing", () => {
    const messages = codexApiTest.parseMessagesFromThread("device-1", "thread-1", {
      createdAt: "2026-03-08T08:00:00.000Z",
      messages: [
        { id: "user-1", role: "user", content: "First prompt" },
        { id: "user-2", role: "user", content: "Second prompt" },
        { id: "assistant-1", role: "assistant", content: "First answer" },
        { id: "assistant-2", role: "assistant", content: "Second answer" }
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
        }
      ]
    });

    expect(messages.map((message) => `${message.role}:${message.id}`)).toEqual([
      "user:user-1",
      "assistant:assistant-1",
      "user:user-2",
      "assistant:assistant-2"
    ]);
    expect(messages.map((message) => message.timelineOrder)).toEqual([0, 1, 2, 3]);
  });

  it("ignores rollout response_item user scaffolding while preserving visible user and assistant timeline messages", () => {
    const messages = [
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
        content: "What are the top news from today from the Iran-Israel war?",
        createdAt: "2026-03-08T09:58:46.626Z",
        order: 1,
        sourceType: "event_msg"
      },
      {
        kind: "message",
        id: "assistant",
        role: "assistant",
        content: "Here are the latest developments I found.",
        createdAt: "2026-03-08T10:00:47.879Z",
        order: 2,
        sourceType: "response_item"
      },
      {
        kind: "message",
        id: "reasoning",
        role: "assistant",
        content: "Searching Reuters and AP.",
        createdAt: "2026-03-08T09:58:52.344Z",
        order: 3,
        eventType: "reasoning",
        sourceType: "response_item"
      }
    ]
      .map((record) =>
        codexApiTest.toTimelineMessageFromRolloutRecord("device-1", "thread-1", record)
      )
      .filter((message): message is ChatMessage => message !== null);

    expect(messages.map((message) => `${message.role}:${message.id}`)).toEqual([
      "user:prompt",
      "assistant:assistant",
      "assistant:reasoning"
    ]);
    expect(messages.find((message) => message.id === "reasoning")?.eventType).toBe(
      "reasoning"
    );
  });

  it("reorders flat existing-session item snapshots numerically when turns are missing", () => {
    const messages = codexApiTest.parseMessagesFromThread(
      "device-1",
      existingSessionChronologyFixture.threadId,
      existingSessionChronologyFixture.threadReadSnapshot
    );

    expect(messages.map((message) => `${message.role}:${message.id}`)).toEqual(
      existingSessionChronologyFixture.expectedNumericSnapshotOrder
    );
  });

  it("prefers recovered rollout chronology when opening a historical existing session later", async () => {
    const snapshotMessages = codexApiTest.parseMessagesFromThread(
      "device-1",
      existingSessionChronologyFixture.threadId,
      existingSessionChronologyFixture.threadReadSnapshot
    );
    const rolloutMessages = existingSessionChronologyFixture.rolloutRecords
      .map((record) =>
        codexApiTest.toTimelineMessageFromRolloutRecord(
          "device-1",
          existingSessionChronologyFixture.threadId,
          record
        )
      )
      .filter((message): message is ChatMessage => message !== null);

    const recovered = await codexApiTest.recoverRolloutHistoryForThread(
      {
        id: "mock-local-device",
        name: "Local Device",
        config: { kind: "local" },
        connected: true,
        connection: {
          endpoint: "mock://local/mock-local-device",
          transport: "mock-jsonrpc",
          connectedAtMs: Date.UTC(2026, 2, 12, 9, 30, 0, 0)
        }
      },
      existingSessionChronologyFixture.threadId,
      null,
      "2026-01-10T16:12:55.000Z",
      {
        findLatestRolloutPath: async () =>
          `/Users/mock/.codex/sessions/2026/01/10/rollout-${existingSessionChronologyFixture.threadId}.jsonl`,
        readRolloutMessages: async (_device, _threadId, path) =>
          path ? rolloutMessages : []
      }
    );

    const openedMessages =
      recovered.messages.length > 0 ? recovered.messages : snapshotMessages;

    expect(snapshotMessages.map((message) => `${message.role}:${message.id}`)).toEqual(
      existingSessionChronologyFixture.expectedNumericSnapshotOrder
    );
    expect(recovered.rolloutPath).toContain(existingSessionChronologyFixture.threadId);
    expect(openedMessages.map((message) => `${message.role}:${message.id}`)).toEqual(
      existingSessionChronologyFixture.expectedCanonicalOrder
    );
  });

  it("filters hidden response_item wrappers but keeps visible response_item user prompts", () => {
    const messages = responseItemClassifierFixture.rolloutTimeline
      .map((record) =>
        codexApiTest.toTimelineMessageFromRolloutRecord("device-1", "thread-1", {
          ...record
        })
      )
      .filter((message): message is ChatMessage => message !== null);

    expect(messages.map((message) => `${message.role}:${message.id}`)).toEqual(
      responseItemClassifierFixture.expectedVisibleRoleIdOrder
    );
  });
});
