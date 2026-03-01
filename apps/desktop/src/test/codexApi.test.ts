import { describe, expect, it } from "vitest";
import { buildTurnStartAttempts } from "../services/codexApi";
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
      images: [sampleImage("data:image/png;base64,abc123")]
    };

    const attempts = buildTurnStartAttempts("thread-1", submission);
    expect(attempts.length).toBeGreaterThan(0);
    expect(hasStringInputFallback(attempts)).toBe(false);

    const serializedInputs = attempts
      .map((attempt) => JSON.stringify(attempt.input))
      .join("\n");
    expect(serializedInputs).toContain("image");
    expect(serializedInputs).toContain("abc123");
  });

  it("keeps legacy string fallback for text-only submissions", () => {
    const attempts = buildTurnStartAttempts("thread-2", {
      prompt: "Hello",
      images: []
    });

    expect(attempts.length).toBeGreaterThan(0);
    expect(hasStringInputFallback(attempts)).toBe(true);
    expect(attempts.some((attempt) => attempt.input === "Hello")).toBe(true);
  });

  it("supports image-only submissions without introducing string fallbacks", () => {
    const attempts = buildTurnStartAttempts("thread-3", {
      prompt: "",
      images: [sampleImage("data:image/png;base64,def456")]
    });

    expect(attempts.length).toBeGreaterThan(0);
    expect(hasStringInputFallback(attempts)).toBe(false);

    const serializedInputs = attempts
      .map((attempt) => JSON.stringify(attempt.input))
      .join("\n");
    expect(serializedInputs).toContain("def456");
  });
});
