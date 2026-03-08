import type { TokenUsageBreakdown } from "../domain/types";

export interface ModelPricing {
  inputUsdPer1M: number;
  cachedInputUsdPer1M: number | null;
  outputUsdPer1M: number;
}

const PRICING_BY_MODEL: Record<string, ModelPricing> = {
  "gpt-5.2": { inputUsdPer1M: 2.0, cachedInputUsdPer1M: 0.5, outputUsdPer1M: 8.0 },
  "gpt-5.2-mini": { inputUsdPer1M: 0.4, cachedInputUsdPer1M: 0.1, outputUsdPer1M: 1.6 },
  "gpt-5.2-nano": { inputUsdPer1M: 0.1, cachedInputUsdPer1M: 0.025, outputUsdPer1M: 0.4 },
  "gpt-5.1": { inputUsdPer1M: 1.25, cachedInputUsdPer1M: 0.125, outputUsdPer1M: 10.0 },
  "gpt-5.1-mini": { inputUsdPer1M: 0.25, cachedInputUsdPer1M: 0.025, outputUsdPer1M: 2.0 },
  "gpt-5.1-nano": { inputUsdPer1M: 0.05, cachedInputUsdPer1M: 0.005, outputUsdPer1M: 0.4 },
  "gpt-5": { inputUsdPer1M: 1.25, cachedInputUsdPer1M: 0.125, outputUsdPer1M: 10.0 },
  "gpt-5.4": { inputUsdPer1M: 2.5, cachedInputUsdPer1M: 0.25, outputUsdPer1M: 15.0 },
  "gpt-5-mini": { inputUsdPer1M: 0.25, cachedInputUsdPer1M: 0.025, outputUsdPer1M: 2.0 },
  "gpt-5-nano": { inputUsdPer1M: 0.05, cachedInputUsdPer1M: 0.005, outputUsdPer1M: 0.4 },
  "gpt-4.1": { inputUsdPer1M: 2.0, cachedInputUsdPer1M: 0.5, outputUsdPer1M: 8.0 },
  "gpt-4.1-mini": { inputUsdPer1M: 0.4, cachedInputUsdPer1M: 0.1, outputUsdPer1M: 1.6 },
  "gpt-4.1-nano": { inputUsdPer1M: 0.1, cachedInputUsdPer1M: 0.025, outputUsdPer1M: 0.4 },
  "gpt-4o": { inputUsdPer1M: 2.5, cachedInputUsdPer1M: 1.25, outputUsdPer1M: 10.0 },
  "gpt-4o-mini": { inputUsdPer1M: 0.15, cachedInputUsdPer1M: 0.075, outputUsdPer1M: 0.6 },
  "gpt-5.3-codex": {
    inputUsdPer1M: 1.75,
    cachedInputUsdPer1M: 0.175,
    outputUsdPer1M: 14.0
  },
  "gpt-5.2-codex": {
    inputUsdPer1M: 1.75,
    cachedInputUsdPer1M: 0.175,
    outputUsdPer1M: 14.0
  },
  "gpt-5-codex": { inputUsdPer1M: 1.25, cachedInputUsdPer1M: 0.125, outputUsdPer1M: 10.0 },
  "gpt-5.1-codex": { inputUsdPer1M: 1.25, cachedInputUsdPer1M: 0.125, outputUsdPer1M: 10.0 },
  "gpt-5.1-codex-mini": {
    inputUsdPer1M: 0.25,
    cachedInputUsdPer1M: 0.025,
    outputUsdPer1M: 2.0
  },
  "gpt-5.1-codex-max": {
    inputUsdPer1M: 1.25,
    cachedInputUsdPer1M: 0.125,
    outputUsdPer1M: 10.0
  }
};

const MODEL_ALIASES: Record<string, string> = {
  "gpt-5-chat-latest": "gpt-5",
  "gpt-5.4-latest": "gpt-5.4",
  "gpt-5.1-chat-latest": "gpt-5.1",
  "gpt-5.3-codex-latest": "gpt-5.3-codex",
  "gpt-5-codex-latest": "gpt-5.3-codex",
  "gpt-5.1-codex-latest": "gpt-5.1-codex",
  "gpt-5.3-codex-spark": "gpt-5.3-codex",
  "gpt-5.3-codex-spark-latest": "gpt-5.3-codex",
  "gpt-5-codex-spark": "gpt-5.3-codex",
  "gpt-5-codex-spark-latest": "gpt-5.3-codex",
  "codex-spark": "gpt-5.3-codex"
};

const DATE_SUFFIX_PATTERN = /-\d{4}-\d{2}-\d{2}$/;

export const normalizeModelId = (value: string): string => {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "";
  }

  const withoutProvider = trimmed.includes("/") ? trimmed.split("/").at(-1) ?? trimmed : trimmed;
  const withoutDateSuffix = withoutProvider.replace(DATE_SUFFIX_PATTERN, "");
  const aliased = MODEL_ALIASES[withoutDateSuffix] ?? withoutDateSuffix;

  return aliased;
};

export const resolveModelPricing = (modelId: string): ModelPricing | null => {
  const normalized = normalizeModelId(modelId);
  if (normalized.length === 0) {
    return null;
  }

  if (normalized in PRICING_BY_MODEL) {
    return PRICING_BY_MODEL[normalized];
  }

  if (normalized.endsWith("-latest")) {
    const stripped = normalized.slice(0, -"-latest".length);
    const aliased = MODEL_ALIASES[stripped] ?? stripped;
    return PRICING_BY_MODEL[aliased] ?? null;
  }

  return null;
};

export const computeCostUsdFromUsage = (
  usage: TokenUsageBreakdown,
  pricing: ModelPricing
): number | null => {
  const cachedInputTokens = Math.max(usage.cachedInputTokens, 0);
  const totalInputTokens = Math.max(usage.inputTokens, 0);
  const outputTokens = Math.max(usage.outputTokens, 0);
  const uncachedInputTokens = Math.max(totalInputTokens - cachedInputTokens, 0);

  if (cachedInputTokens > 0 && pricing.cachedInputUsdPer1M === null) {
    return null;
  }

  const inputCost = (uncachedInputTokens * pricing.inputUsdPer1M) / 1_000_000;
  const cachedInputCost =
    pricing.cachedInputUsdPer1M === null
      ? 0
      : (cachedInputTokens * pricing.cachedInputUsdPer1M) / 1_000_000;
  const outputCost = (outputTokens * pricing.outputUsdPer1M) / 1_000_000;

  return inputCost + cachedInputCost + outputCost;
};
