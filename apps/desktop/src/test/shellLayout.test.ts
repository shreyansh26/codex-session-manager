import { describe, expect, it } from "vitest";
import {
  COMPACT_HYSTERESIS_PX,
  SHELL_GUTTER_BUDGET_PX,
  SIDEBAR_MAX_RATIO,
  clampSidebarWidth,
  isValidShellWidth,
  resolveCompactShell,
  resolveCompactTransition
} from "../shellLayout";

const MIN_WORKSPACE_WIDTH_PX = 760;
const SPLITTER_TOTAL_WIDTH_PX = 20;

const compactThreshold = (effectiveSidebarWidth: number): number =>
  effectiveSidebarWidth +
  MIN_WORKSPACE_WIDTH_PX +
  SPLITTER_TOTAL_WIDTH_PX +
  SHELL_GUTTER_BUDGET_PX;

describe("shellLayout clampSidebarWidth", () => {
  it("clamps requested width against shell ratio bounds", () => {
    expect(clampSidebarWidth(100, 1400)).toBe(280);
    expect(clampSidebarWidth(1200, 1400)).toBe(Math.floor(1400 * SIDEBAR_MAX_RATIO));
    expect(clampSidebarWidth(360, 1400)).toBe(360);
  });

  it("uses safe fallback width for non-finite requests", () => {
    expect(clampSidebarWidth(Number.NaN, 1400)).toBe(360);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY, 1400)).toBe(360);
  });
});

describe("shellLayout resolveCompactShell", () => {
  it("stays split at threshold and above when not already compact", () => {
    const effectiveSidebarWidth = clampSidebarWidth(360, 2000);
    const threshold = compactThreshold(effectiveSidebarWidth);

    expect(
      resolveCompactShell({
        shellWidth: threshold - 1,
        effectiveSidebarWidth,
        wasCompact: false
      })
    ).toBe(true);
    expect(
      resolveCompactShell({
        shellWidth: threshold,
        effectiveSidebarWidth,
        wasCompact: false
      })
    ).toBe(false);
    expect(
      resolveCompactShell({
        shellWidth: threshold + 1,
        effectiveSidebarWidth,
        wasCompact: false
      })
    ).toBe(false);
  });

  it("applies hysteresis when already compact", () => {
    const effectiveSidebarWidth = clampSidebarWidth(360, 2000);
    const threshold = compactThreshold(effectiveSidebarWidth);

    expect(
      resolveCompactShell({
        shellWidth: threshold + COMPACT_HYSTERESIS_PX - 1,
        effectiveSidebarWidth,
        wasCompact: true
      })
    ).toBe(true);
    expect(
      resolveCompactShell({
        shellWidth: threshold + COMPACT_HYSTERESIS_PX,
        effectiveSidebarWidth,
        wasCompact: true
      })
    ).toBe(false);
  });

  it("uses effective clamped sidebar width in threshold math", () => {
    const shellWidth = 2200;
    const staleOversizedSidebar = 3000;
    const effectiveSidebarWidth = clampSidebarWidth(staleOversizedSidebar, shellWidth);

    expect(effectiveSidebarWidth).toBe(Math.floor(shellWidth * SIDEBAR_MAX_RATIO));
    expect(
      resolveCompactShell({
        shellWidth,
        effectiveSidebarWidth,
        wasCompact: false
      })
    ).toBe(false);
  });

  it("clamps stale oversized sidebar widths after shell shrink before compact checks", () => {
    const staleSidebarWidth = 1300;
    const shrunkShellWidth = 1400;
    const effectiveSidebarWidth = clampSidebarWidth(staleSidebarWidth, shrunkShellWidth);

    expect(effectiveSidebarWidth).toBe(Math.floor(shrunkShellWidth * SIDEBAR_MAX_RATIO));
    expect(
      resolveCompactShell({
        shellWidth: shrunkShellWidth,
        effectiveSidebarWidth,
        wasCompact: false
      })
    ).toBe(true);
  });

  it("remains safely non-compact from invalid widths until a valid width arrives", () => {
    const effectiveSidebarWidth = clampSidebarWidth(360, 2000);
    const threshold = compactThreshold(effectiveSidebarWidth);

    expect(isValidShellWidth(Number.NaN)).toBe(false);
    expect(isValidShellWidth(0)).toBe(false);
    expect(
      resolveCompactShell({
        shellWidth: Number.NaN,
        effectiveSidebarWidth,
        wasCompact: false
      })
    ).toBe(false);
    expect(
      resolveCompactShell({
        shellWidth: 0,
        effectiveSidebarWidth,
        wasCompact: false
      })
    ).toBe(false);
    expect(
      resolveCompactShell({
        shellWidth: threshold - 1,
        effectiveSidebarWidth,
        wasCompact: false
      })
    ).toBe(true);
  });
});

describe("shellLayout resolveCompactTransition", () => {
  it("signals pointer and resize cleanup when entering compact while dragging", () => {
    const transition = resolveCompactTransition({
      wasCompact: false,
      nextCompact: true,
      isResizing: true,
      activePointerId: 42
    });

    expect(transition).toEqual({
      didEnterCompact: true,
      clearResizing: true,
      clearActivePointer: true
    });
  });

  it("preserves state when compact mode is not newly entered", () => {
    expect(
      resolveCompactTransition({
        wasCompact: true,
        nextCompact: true,
        isResizing: true,
        activePointerId: 7
      })
    ).toEqual({
      didEnterCompact: false,
      clearResizing: false,
      clearActivePointer: false
    });

    expect(
      resolveCompactTransition({
        wasCompact: false,
        nextCompact: false,
        isResizing: false,
        activePointerId: null
      })
    ).toEqual({
      didEnterCompact: false,
      clearResizing: false,
      clearActivePointer: false
    });
  });
});
