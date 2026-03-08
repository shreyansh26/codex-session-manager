import { describe, expect, it } from "vitest";
import {
  computeCostUsdFromUsage,
  normalizeModelId,
  resolveModelPricing
} from "../services/modelPricing";

describe("normalizeModelId", () => {
  it("normalizes provider-prefixed and dated model ids", () => {
    expect(normalizeModelId("openai/GPT-5.1-2026-02-14")).toBe("gpt-5.1");
  });
});

describe("resolveModelPricing", () => {
  it("resolves exact and alias model ids", () => {
    expect(resolveModelPricing("gpt-5")).toEqual({
      inputUsdPer1M: 1.25,
      cachedInputUsdPer1M: 0.125,
      outputUsdPer1M: 10
    });

    expect(resolveModelPricing("gpt-5.4")).toEqual({
      inputUsdPer1M: 2.5,
      cachedInputUsdPer1M: 0.25,
      outputUsdPer1M: 15
    });

    expect(resolveModelPricing("gpt-5-chat-latest")).toEqual({
      inputUsdPer1M: 1.25,
      cachedInputUsdPer1M: 0.125,
      outputUsdPer1M: 10
    });

    expect(resolveModelPricing("gpt-5.3-codex")).toEqual({
      inputUsdPer1M: 1.75,
      cachedInputUsdPer1M: 0.175,
      outputUsdPer1M: 14
    });

    expect(resolveModelPricing("gpt-5.3-codex-spark")).toEqual({
      inputUsdPer1M: 1.75,
      cachedInputUsdPer1M: 0.175,
      outputUsdPer1M: 14
    });

    expect(resolveModelPricing("gpt-5.3-codex-spark-latest")).toEqual({
      inputUsdPer1M: 1.75,
      cachedInputUsdPer1M: 0.175,
      outputUsdPer1M: 14
    });

    expect(resolveModelPricing("gpt-5.1-codex-mini")).toEqual({
      inputUsdPer1M: 0.25,
      cachedInputUsdPer1M: 0.025,
      outputUsdPer1M: 2
    });
  });

  it("returns null for unknown models", () => {
    expect(resolveModelPricing("unknown-model-123")).toBeNull();
  });
});

describe("computeCostUsdFromUsage", () => {
  it("computes cost using uncached input, cached input, and output rates", () => {
    const pricing = resolveModelPricing("gpt-5");
    expect(pricing).not.toBeNull();

    const cost = computeCostUsdFromUsage(
      {
        totalTokens: 1500,
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 500,
        reasoningOutputTokens: 100
      },
      pricing!
    );

    expect(cost).toBeCloseTo(0.006025, 9);
  });

  it("returns null if cached tokens exist but cached input pricing is unavailable", () => {
    const cost = computeCostUsdFromUsage(
      {
        totalTokens: 300,
        inputTokens: 200,
        cachedInputTokens: 50,
        outputTokens: 100,
        reasoningOutputTokens: 20
      },
      {
        inputUsdPer1M: 1,
        cachedInputUsdPer1M: null,
        outputUsdPer1M: 2
      }
    );

    expect(cost).toBeNull();
  });
});
