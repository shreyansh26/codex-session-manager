import { describe, expect, it } from "vitest";
import {
  normalizeCatalogModelId,
  resolveSupportedModelId,
  resolveThinkingEffortForModel
} from "../domain/modelCatalog";

describe("modelCatalog normalization", () => {
  it("maps codex spark aliases to canonical catalog id", () => {
    expect(resolveSupportedModelId("gpt-5-codex-spark")).toBe("gpt-5.3-codex-spark");
    expect(resolveSupportedModelId("openai/gpt-5-codex-spark-latest")).toBe(
      "gpt-5.3-codex-spark"
    );
    expect(resolveSupportedModelId("codex-spark")).toBe("gpt-5.3-codex-spark");
  });

  it("strips provider/date/latest suffixes before catalog mapping", () => {
    expect(normalizeCatalogModelId("openai/gpt-5.3-codex-2026-03-02")).toBe(
      "gpt-5.3-codex"
    );
    expect(normalizeCatalogModelId("openai/gpt-5.3-codex-latest")).toBe(
      "gpt-5.3-codex"
    );
    expect(normalizeCatalogModelId("openai/gpt-5.4-latest")).toBe("gpt-5.4");
    expect(resolveSupportedModelId("gpt-5.4")).toBe("gpt-5.4");
  });
});

describe("modelCatalog effort defaults", () => {
  it("defaults gpt-5.4 to high effort", () => {
    expect(resolveThinkingEffortForModel("gpt-5.4", undefined)).toBe("high");
  });

  it("defaults gpt-5.3-codex to xhigh effort", () => {
    expect(resolveThinkingEffortForModel("gpt-5.3-codex", undefined)).toBe("xhigh");
  });
});
