export const MIN_WORKSPACE_WIDTH_PX = 760;
export const SPLITTER_TOTAL_WIDTH_PX = 20;
export const SHELL_GUTTER_BUDGET_PX = 48;
export const COMPACT_HYSTERESIS_PX = 24;

export const SIDEBAR_MIN_WIDTH_PX = 280;
export const SIDEBAR_MAX_RATIO = 0.62;
export const DEFAULT_SIDEBAR_WIDTH_PX = 360;

const sanitizeRequestedSidebarWidth = (value: number): number =>
  Number.isFinite(value) ? value : DEFAULT_SIDEBAR_WIDTH_PX;

export const isValidShellWidth = (shellWidth: number): boolean =>
  Number.isFinite(shellWidth) && shellWidth > 0;

export const clampSidebarWidth = (requested: number, shellWidth: number): number => {
  const safeRequested = sanitizeRequestedSidebarWidth(requested);
  if (!isValidShellWidth(shellWidth)) {
    return Math.max(safeRequested, SIDEBAR_MIN_WIDTH_PX);
  }

  const maxWidth = Math.max(SIDEBAR_MIN_WIDTH_PX, Math.floor(shellWidth * SIDEBAR_MAX_RATIO));
  return Math.min(Math.max(safeRequested, SIDEBAR_MIN_WIDTH_PX), maxWidth);
};

export const resolveCompactShell = (params: {
  shellWidth: number;
  effectiveSidebarWidth: number;
  wasCompact: boolean;
}): boolean => {
  if (!isValidShellWidth(params.shellWidth)) {
    return params.wasCompact;
  }

  const compactThreshold =
    params.effectiveSidebarWidth +
    MIN_WORKSPACE_WIDTH_PX +
    SPLITTER_TOTAL_WIDTH_PX +
    SHELL_GUTTER_BUDGET_PX;

  if (params.wasCompact) {
    return params.shellWidth < compactThreshold + COMPACT_HYSTERESIS_PX;
  }

  return params.shellWidth < compactThreshold;
};

export const resolveCompactTransition = (params: {
  wasCompact: boolean;
  nextCompact: boolean;
  isResizing: boolean;
  activePointerId: number | null;
}): {
  didEnterCompact: boolean;
  clearResizing: boolean;
  clearActivePointer: boolean;
} => {
  const didEnterCompact = !params.wasCompact && params.nextCompact;
  return {
    didEnterCompact,
    clearResizing: didEnterCompact && params.isResizing,
    clearActivePointer: didEnterCompact && params.activePointerId !== null
  };
};
