import { describe, expect, it } from "vitest";
import {
  buildTurnStartAttempts,
  joinPosixPath,
  normalizePosixPath,
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
