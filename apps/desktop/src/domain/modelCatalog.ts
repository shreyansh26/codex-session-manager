import type { ThinkingEffort } from "./types";

export interface ModelCatalogEntry {
  id: string;
  label: string;
  thinkingEfforts: ThinkingEffort[];
}

const MODEL_CATALOG_ENTRIES: ModelCatalogEntry[] = [
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3-Codex",
    thinkingEfforts: ["low", "medium", "high", "xhigh"]
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3-Codex-Spark",
    thinkingEfforts: ["low", "medium", "high"]
  },
  {
    id: "gpt-5.2-codex",
    label: "GPT-5.2-Codex",
    thinkingEfforts: ["low", "medium", "high", "xhigh"]
  },
  {
    id: "gpt-5.1-codex-max",
    label: "GPT-5.1-Codex-Max",
    thinkingEfforts: ["medium", "high", "xhigh"]
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    thinkingEfforts: ["low", "medium", "high", "xhigh"]
  },
  {
    id: "gpt-5.1-codex-mini",
    label: "GPT-5.1-Codex-Mini",
    thinkingEfforts: ["medium", "high"]
  }
];

const THINKING_EFFORT_LABELS: Record<ThinkingEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High"
};

const MODEL_DEFAULT_THINKING_EFFORT: Partial<Record<string, ThinkingEffort>> = {
  "gpt-5.3-codex": "xhigh"
};

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = MODEL_CATALOG_ENTRIES;

export const DEFAULT_COMPOSER_MODEL_ID = MODEL_CATALOG_ENTRIES[0].id;

const DATE_SUFFIX_PATTERN = /-\d{4}-\d{2}-\d{2}$/;

const MODEL_ID_ALIASES: Record<string, string> = {
  "gpt-5.3-codex-latest": "gpt-5.3-codex",
  "gpt-5-codex-latest": "gpt-5.3-codex",
  "gpt-5-codex": "gpt-5.3-codex",
  "gpt-5.3-codex-spark-latest": "gpt-5.3-codex-spark",
  "gpt-5-codex-spark-latest": "gpt-5.3-codex-spark",
  "gpt-5-codex-spark": "gpt-5.3-codex-spark",
  "codex-spark": "gpt-5.3-codex-spark"
};

const isThinkingEffort = (value: string): value is ThinkingEffort =>
  value === "low" || value === "medium" || value === "high" || value === "xhigh";

export const getThinkingEffortLabel = (effort: ThinkingEffort): string =>
  THINKING_EFFORT_LABELS[effort];

export const normalizeCatalogModelId = (
  value: string | null | undefined
): string | null => {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  const withoutProvider = normalized.includes("/")
    ? normalized.split("/").at(-1) ?? normalized
    : normalized;
  let normalizedModelId = withoutProvider;

  if (normalizedModelId.endsWith("-latest")) {
    normalizedModelId = normalizedModelId.slice(0, -"-latest".length);
  }
  normalizedModelId = normalizedModelId.replace(DATE_SUFFIX_PATTERN, "");
  if (normalizedModelId.endsWith("-latest")) {
    normalizedModelId = normalizedModelId.slice(0, -"-latest".length);
  }

  const aliased = MODEL_ID_ALIASES[normalizedModelId] ?? normalizedModelId;
  return aliased || null;
};

const findModelEntry = (
  value: string | null | undefined
): ModelCatalogEntry | null => {
  const normalized = normalizeCatalogModelId(value);
  if (!normalized) {
    return null;
  }

  for (const entry of MODEL_CATALOG_ENTRIES) {
    if (normalized === entry.id) {
      return entry;
    }
  }

  const bySpecificPrefix = [...MODEL_CATALOG_ENTRIES]
    .sort((a, b) => b.id.length - a.id.length)
    .find((entry) => normalized.startsWith(`${entry.id}-`));
  if (bySpecificPrefix) {
    return bySpecificPrefix;
  }

  for (const entry of MODEL_CATALOG_ENTRIES) {
    if (normalized.startsWith(entry.id)) {
      return entry;
    }
  }

  if (normalized.includes("spark") && normalized.includes("codex")) {
    return MODEL_CATALOG_ENTRIES.find((entry) => entry.id === "gpt-5.3-codex-spark") ?? null;
  }

  return null;
};

export const resolveSupportedModelId = (
  value: string | null | undefined
): string | null => findModelEntry(value)?.id ?? null;

export const resolveComposerModel = (
  value: string | null | undefined
): string => resolveSupportedModelId(value) ?? DEFAULT_COMPOSER_MODEL_ID;

export const getSupportedThinkingEfforts = (
  modelId: string | null | undefined
): ThinkingEffort[] => {
  const resolved = findModelEntry(modelId) ?? MODEL_CATALOG_ENTRIES[0];
  return [...resolved.thinkingEfforts];
};

export const resolveThinkingEffortForModel = (
  modelId: string | null | undefined,
  effort: ThinkingEffort | string | null | undefined
): ThinkingEffort => {
  const supported = getSupportedThinkingEfforts(modelId);
  if (typeof effort === "string") {
    const normalized = effort.trim().toLowerCase();
    if (isThinkingEffort(normalized) && supported.includes(normalized)) {
      return normalized;
    }
  }

  const defaultForModel = MODEL_DEFAULT_THINKING_EFFORT[resolveComposerModel(modelId)];
  if (defaultForModel && supported.includes(defaultForModel)) {
    return defaultForModel;
  }

  return supported.includes("medium") ? "medium" : supported[0];
};
