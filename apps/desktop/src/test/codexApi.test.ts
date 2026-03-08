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
import type { ChatImageAttachment, ComposerSubmission } from "../domain/types";

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
});
