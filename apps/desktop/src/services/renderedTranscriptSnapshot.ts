import type { VisibleMessageWindow } from "../components/chatWindow";
import { getMessageWindowKey, resolveVisibleMessageWindow } from "../components/chatWindow";
import type { ChatMessage, ChatRole, SessionSummary } from "../domain/types";

const PREVIEW_MAX_CHARS = 160;

export type RenderedTranscriptPhase =
  | "base-loaded"
  | "rollout-parsed"
  | "rollout-applied"
  | "rollout-idle";
export type RenderedTranscriptMode = "mounted-visible" | "expanded-full";

export interface RenderedTranscriptStoreEntry {
  orderIndex: number;
  renderKey: string;
  id: string;
  role: ChatRole;
  eventType: string | null;
  createdAt: string;
  timelineOrder: number | null;
  chronologySource: string | null;
  label: string;
  contentPreview: string;
  toolName: string | null;
  toolStatus: string | null;
}

export interface RenderedTranscriptDomEntry {
  domIndex: number;
  renderKey: string;
  id: string;
  role: ChatRole;
  eventType: string | null;
  label: string;
  textPreview: string;
  toolName: string | null;
  toolStatus: string | null;
}

export interface RenderedTranscriptVisibleWindow {
  hiddenMessageCount: number;
  startIndex: number;
  anchorMessageKey: string | null;
  visibleRenderKeys: string[];
}

export interface RenderedTranscriptOrderDiff {
  expectedOrder: string[];
  actualOrder: string[];
  firstMismatchIndex: number | null;
  missingFromActual: string[];
  extraInActual: string[];
}

export interface RenderedTranscriptRoleRun {
  role: ChatRole;
  startIndex: number;
  length: number;
}

export interface RenderedTranscriptDuplicateKey {
  renderKey: string;
  positions: number[];
}

export interface RenderedTranscriptSnapshot {
  sessionKey: string;
  threadId: string;
  deviceId: string;
  phase: RenderedTranscriptPhase;
  mode: RenderedTranscriptMode;
  visibleWindow: RenderedTranscriptVisibleWindow;
  storeEntries: RenderedTranscriptStoreEntry[];
  domEntries: RenderedTranscriptDomEntry[];
  storeVsDom: RenderedTranscriptOrderDiff;
  missingFromDom: string[];
  extraInDom: string[];
  duplicateWindowKeys: RenderedTranscriptDuplicateKey[];
  roleRuns: RenderedTranscriptRoleRun[];
}

export interface RenderedTranscriptPhaseCapture {
  phase: RenderedTranscriptPhase;
  mountedVisible: RenderedTranscriptSnapshot;
  expandedFull: RenderedTranscriptSnapshot;
}

export type ReopenedSessionBadLayer =
  | "rollout_parse_loss"
  | "rollout_apply_loss"
  | "visible_window_loss"
  | "dom_keying_loss";

export interface RenderedTranscriptCoverage {
  total: number;
  user: number;
  assistant: number;
  system: number;
  tool: number;
  reasoning: number;
  activity: number;
  toolCall: number;
}

export interface ReopenedSessionTranscriptAnalysis {
  firstBadLayer: ReopenedSessionBadLayer | null;
  rolloutParsedSource: "raw" | "inferred-from-rollout-applied";
  coverage: {
    baseLoaded: RenderedTranscriptCoverage;
    rolloutParsed: RenderedTranscriptCoverage;
    rolloutApplied: RenderedTranscriptCoverage;
  };
  diffs: {
    baseToRolloutParsed: RenderedTranscriptOrderDiff;
    baseToRolloutApplied: RenderedTranscriptOrderDiff;
    rolloutParsedToRolloutApplied: RenderedTranscriptOrderDiff;
  };
  notes: string[];
}

export interface ReopenedSessionTranscriptCapture {
  sessionKey: string;
  threadId: string;
  deviceId: string;
  captures: RenderedTranscriptPhaseCapture[];
  analysis?: ReopenedSessionTranscriptAnalysis;
}

const truncatePreview = (value: string): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= PREVIEW_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
};

const messageLabel = (message: ChatMessage): string => {
  if (message.role === "user") {
    return "user";
  }
  if (message.toolCall || message.eventType === "tool_call") {
    return "Tool Call";
  }
  if (message.eventType === "reasoning") {
    return "Reasoning";
  }
  if (message.eventType === "activity") {
    return "Activity";
  }
  return message.role;
};

const readDatasetValue = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
};

const diffOrders = (
  expectedOrder: string[],
  actualOrder: string[]
): RenderedTranscriptOrderDiff => {
  const firstMismatchIndex = (() => {
    const maxLength = Math.max(expectedOrder.length, actualOrder.length);
    for (let index = 0; index < maxLength; index += 1) {
      if (expectedOrder[index] !== actualOrder[index]) {
        return index;
      }
    }
    return null;
  })();

  const actualCounts = new Map<string, number>();
  for (const entry of actualOrder) {
    actualCounts.set(entry, (actualCounts.get(entry) ?? 0) + 1);
  }

  const missingFromActual: string[] = [];
  for (const entry of expectedOrder) {
    const remaining = actualCounts.get(entry) ?? 0;
    if (remaining > 0) {
      actualCounts.set(entry, remaining - 1);
      continue;
    }
    missingFromActual.push(entry);
  }

  const expectedCounts = new Map<string, number>();
  for (const entry of expectedOrder) {
    expectedCounts.set(entry, (expectedCounts.get(entry) ?? 0) + 1);
  }

  const extraInActual: string[] = [];
  for (const entry of actualOrder) {
    const remaining = expectedCounts.get(entry) ?? 0;
    if (remaining > 0) {
      expectedCounts.set(entry, remaining - 1);
      continue;
    }
    extraInActual.push(entry);
  }

  return {
    expectedOrder,
    actualOrder,
    firstMismatchIndex,
    missingFromActual,
    extraInActual
  };
};

export const toRenderedTranscriptStoreEntries = (
  messages: ChatMessage[]
): RenderedTranscriptStoreEntry[] =>
  messages.map((message, orderIndex) => ({
    orderIndex,
    renderKey: getMessageWindowKey(message),
    id: message.id,
    role: message.role,
    eventType: message.eventType ?? null,
    createdAt: message.createdAt,
    timelineOrder:
      typeof message.timelineOrder === "number" ? message.timelineOrder : null,
    chronologySource: message.chronologySource ?? null,
    label: messageLabel(message),
    contentPreview: truncatePreview(message.content),
    toolName: message.toolCall?.name ?? null,
    toolStatus: message.toolCall?.status ?? null
  }));

export const findDuplicateWindowKeys = (
  messages: ChatMessage[]
): RenderedTranscriptDuplicateKey[] => {
  const positionsByKey = new Map<string, number[]>();
  messages.forEach((message, index) => {
    const renderKey = getMessageWindowKey(message);
    const positions = positionsByKey.get(renderKey) ?? [];
    positionsByKey.set(renderKey, [...positions, index]);
  });

  return [...positionsByKey.entries()]
    .filter(([, positions]) => positions.length > 1)
    .map(([renderKey, positions]) => ({ renderKey, positions }));
};

export const buildVisibleWindowSnapshot = (params: {
  messages: ChatMessage[];
  visibleMessageCount: number;
  anchorMessageKey: string | null;
}): RenderedTranscriptVisibleWindow => {
  const windowState = resolveVisibleMessageWindow(params);
  return {
    hiddenMessageCount: windowState.hiddenMessageCount,
    startIndex: windowState.startIndex,
    anchorMessageKey: params.anchorMessageKey,
    visibleRenderKeys: windowState.visibleMessages.map((message) =>
      getMessageWindowKey(message)
    )
  };
};

export const buildExpandedVisibleWindow = (
  messages: ChatMessage[]
): VisibleMessageWindow =>
  resolveVisibleMessageWindow({
    messages,
    visibleMessageCount: messages.length,
    anchorMessageKey: null
  });

export const deriveVisibleWindowSnapshotFromDom = (params: {
  messages: ChatMessage[];
  domEntries: RenderedTranscriptDomEntry[];
}): RenderedTranscriptVisibleWindow => {
  const storeEntries = toRenderedTranscriptStoreEntries(params.messages);
  const visibleRenderKeys = params.domEntries.map((entry) => entry.renderKey);
  const firstRenderKey = visibleRenderKeys[0] ?? null;
  const startIndex =
    firstRenderKey === null
      ? Math.max(0, params.messages.length - visibleRenderKeys.length)
      : Math.max(
          0,
          storeEntries.findIndex((entry) => entry.renderKey === firstRenderKey)
        );

  return {
    hiddenMessageCount: startIndex,
    startIndex,
    anchorMessageKey: firstRenderKey,
    visibleRenderKeys
  };
};

export const extractRenderedTranscriptDomEntries = (
  root: ParentNode
): RenderedTranscriptDomEntry[] =>
  Array.from(root.querySelectorAll<HTMLElement>("li[data-message-id]"))
    .map((element, domIndex) => {
      const id = readDatasetValue(element.dataset.messageId);
      const renderKey = readDatasetValue(element.dataset.messageKey);
      const role = readDatasetValue(element.dataset.messageRole);
      const label = readDatasetValue(element.dataset.messageLabel);
      if (
        !id ||
        !renderKey ||
        !label ||
        (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool")
      ) {
        return null;
      }

      return {
        domIndex,
        renderKey,
        id,
        role,
        eventType: readDatasetValue(element.dataset.eventType),
        label,
        textPreview: truncatePreview(element.textContent ?? ""),
        toolName: readDatasetValue(element.dataset.toolName),
        toolStatus: readDatasetValue(element.dataset.toolStatus)
      } satisfies RenderedTranscriptDomEntry;
    })
    .filter((entry): entry is RenderedTranscriptDomEntry => entry !== null);

export const summarizeRoleRuns = (
  entries: Array<Pick<RenderedTranscriptDomEntry, "role">>
): RenderedTranscriptRoleRun[] => {
  const runs: RenderedTranscriptRoleRun[] = [];
  for (const [index, entry] of entries.entries()) {
    const previous = runs.at(-1);
    if (!previous || previous.role !== entry.role) {
      runs.push({
        role: entry.role,
        startIndex: index,
        length: 1
      });
      continue;
    }
    previous.length += 1;
  }
  return runs;
};

export const buildRenderedTranscriptSnapshot = (params: {
  session: Pick<SessionSummary, "key" | "threadId" | "deviceId">;
  phase: RenderedTranscriptPhase;
  mode: RenderedTranscriptMode;
  messages: ChatMessage[];
  visibleWindow: RenderedTranscriptVisibleWindow;
  domEntries: RenderedTranscriptDomEntry[];
}): RenderedTranscriptSnapshot => {
  const storeEntries = toRenderedTranscriptStoreEntries(params.messages);
  const domOrder = params.domEntries.map((entry) => entry.renderKey);
  const expectedStoreEntries =
    params.mode === "mounted-visible"
      ? storeEntries.filter((entry) =>
          params.visibleWindow.visibleRenderKeys.includes(entry.renderKey)
        )
      : storeEntries;
  const expectedOrder = expectedStoreEntries.map((entry) => entry.renderKey);
  const storeVsDom = diffOrders(expectedOrder, domOrder);

  return {
    sessionKey: params.session.key,
    threadId: params.session.threadId,
    deviceId: params.session.deviceId,
    phase: params.phase,
    mode: params.mode,
    visibleWindow: params.visibleWindow,
    storeEntries,
    domEntries: params.domEntries,
    storeVsDom,
    missingFromDom: storeVsDom.missingFromActual,
    extraInDom: storeVsDom.extraInActual,
    duplicateWindowKeys: findDuplicateWindowKeys(params.messages),
    roleRuns: summarizeRoleRuns(params.domEntries)
  };
};

const summarizeCoverage = (
  entries: RenderedTranscriptStoreEntry[]
): RenderedTranscriptCoverage => {
  const coverage: RenderedTranscriptCoverage = {
    total: entries.length,
    user: 0,
    assistant: 0,
    system: 0,
    tool: 0,
    reasoning: 0,
    activity: 0,
    toolCall: 0
  };

  for (const entry of entries) {
    coverage[entry.role] += 1;
    if (entry.eventType === "reasoning") {
      coverage.reasoning += 1;
    }
    if (entry.eventType === "activity") {
      coverage.activity += 1;
    }
    if (entry.eventType === "tool_call") {
      coverage.toolCall += 1;
    }
  }

  return coverage;
};

const toSyntheticDomEntry = (
  entry: RenderedTranscriptStoreEntry,
  domIndex: number
): RenderedTranscriptDomEntry => ({
  domIndex,
  renderKey: entry.renderKey,
  id: entry.id,
  role: entry.role,
  eventType: entry.eventType,
  label: entry.label,
  textPreview: entry.contentPreview,
  toolName: entry.toolName,
  toolStatus: entry.toolStatus
});

const findPhaseCapture = (
  captures: RenderedTranscriptPhaseCapture[],
  phase: RenderedTranscriptPhase
): RenderedTranscriptPhaseCapture | null =>
  captures.find((capture) => capture.phase === phase) ?? null;

const normalizeRolloutAppliedCapture = (
  captures: RenderedTranscriptPhaseCapture[]
): RenderedTranscriptPhaseCapture | null => {
  const rolloutApplied = findPhaseCapture(captures, "rollout-applied");
  if (rolloutApplied) {
    return rolloutApplied;
  }

  const legacy = findPhaseCapture(captures, "rollout-idle");
  if (!legacy) {
    return null;
  }

  return {
    phase: "rollout-applied",
    mountedVisible: {
      ...legacy.mountedVisible,
      phase: "rollout-applied"
    },
    expandedFull: {
      ...legacy.expandedFull,
      phase: "rollout-applied"
    }
  };
};

const buildRolloutParsedCaptureFromApplied = (
  appliedCapture: RenderedTranscriptPhaseCapture
): RenderedTranscriptPhaseCapture => {
  const rolloutEntries = appliedCapture.expandedFull.storeEntries.filter(
    (entry) => entry.chronologySource === "rollout"
  );
  const rolloutDomEntries = rolloutEntries.map((entry, index) =>
    toSyntheticDomEntry(entry, index)
  );
  const rolloutOrder = rolloutEntries.map((entry) => entry.renderKey);
  const rolloutWindow: RenderedTranscriptVisibleWindow = {
    hiddenMessageCount: 0,
    startIndex: 0,
    anchorMessageKey: rolloutOrder[0] ?? null,
    visibleRenderKeys: rolloutOrder
  };
  const rolloutStoreVsDom = diffOrders(rolloutOrder, rolloutOrder);

  return {
    phase: "rollout-parsed",
    mountedVisible: {
      ...appliedCapture.mountedVisible,
      phase: "rollout-parsed",
      mode: "mounted-visible",
      visibleWindow: rolloutWindow,
      storeEntries: rolloutEntries,
      domEntries: rolloutDomEntries,
      storeVsDom: rolloutStoreVsDom,
      missingFromDom: [],
      extraInDom: [],
      duplicateWindowKeys: [],
      roleRuns: summarizeRoleRuns(rolloutDomEntries)
    },
    expandedFull: {
      ...appliedCapture.expandedFull,
      phase: "rollout-parsed",
      mode: "expanded-full",
      visibleWindow: rolloutWindow,
      storeEntries: rolloutEntries,
      domEntries: rolloutDomEntries,
      storeVsDom: rolloutStoreVsDom,
      missingFromDom: [],
      extraInDom: [],
      duplicateWindowKeys: [],
      roleRuns: summarizeRoleRuns(rolloutDomEntries)
    }
  };
};

const classifyFirstBadLayer = (params: {
  baseLoaded: RenderedTranscriptPhaseCapture;
  rolloutParsed: RenderedTranscriptPhaseCapture;
  rolloutApplied: RenderedTranscriptPhaseCapture;
}): {
  firstBadLayer: ReopenedSessionBadLayer | null;
  notes: string[];
  diffs: ReopenedSessionTranscriptAnalysis["diffs"];
  coverage: ReopenedSessionTranscriptAnalysis["coverage"];
} => {
  const baseOrder = params.baseLoaded.expandedFull.storeEntries.map(
    (entry) => entry.renderKey
  );
  const parsedOrder = params.rolloutParsed.expandedFull.storeEntries.map(
    (entry) => entry.renderKey
  );
  const appliedOrder = params.rolloutApplied.expandedFull.storeEntries.map(
    (entry) => entry.renderKey
  );

  const diffs = {
    baseToRolloutParsed: diffOrders(baseOrder, parsedOrder),
    baseToRolloutApplied: diffOrders(baseOrder, appliedOrder),
    rolloutParsedToRolloutApplied: diffOrders(parsedOrder, appliedOrder)
  };
  const coverage = {
    baseLoaded: summarizeCoverage(params.baseLoaded.expandedFull.storeEntries),
    rolloutParsed: summarizeCoverage(params.rolloutParsed.expandedFull.storeEntries),
    rolloutApplied: summarizeCoverage(params.rolloutApplied.expandedFull.storeEntries)
  };

  const notes: string[] = [];
  const rolloutAppliedImprovesCoverage =
    coverage.rolloutApplied.tool > coverage.baseLoaded.tool ||
    coverage.rolloutApplied.user > coverage.baseLoaded.user ||
    coverage.rolloutApplied.total > coverage.baseLoaded.total;

  if (params.rolloutApplied.expandedFull.storeVsDom.firstMismatchIndex !== null) {
    notes.push("Expanded rollout-applied store/DOM mismatch detected.");
    return { firstBadLayer: "dom_keying_loss", notes, diffs, coverage };
  }
  if (
    params.rolloutApplied.mountedVisible.storeVsDom.firstMismatchIndex !== null &&
    params.rolloutApplied.expandedFull.storeVsDom.firstMismatchIndex === null
  ) {
    notes.push("Mounted-visible mismatch with expanded-full aligned.");
    return { firstBadLayer: "visible_window_loss", notes, diffs, coverage };
  }
  if (
    !rolloutAppliedImprovesCoverage &&
    (coverage.rolloutParsed.tool < coverage.baseLoaded.tool ||
      coverage.rolloutParsed.user < coverage.baseLoaded.user ||
      coverage.rolloutParsed.total < coverage.baseLoaded.total)
  ) {
    notes.push("Rollout-parsed coverage regressed versus base-loaded.");
    return { firstBadLayer: "rollout_parse_loss", notes, diffs, coverage };
  }
  if (
    coverage.rolloutApplied.tool < coverage.rolloutParsed.tool ||
    coverage.rolloutApplied.user < coverage.rolloutParsed.user ||
    coverage.rolloutApplied.total < coverage.rolloutParsed.total
  ) {
    notes.push("Rollout-applied coverage regressed versus rollout-parsed.");
    return { firstBadLayer: "rollout_apply_loss", notes, diffs, coverage };
  }

  notes.push("No first bad layer detected from capture metrics.");
  return { firstBadLayer: null, notes, diffs, coverage };
};

const parseCaptureInput = (rawCapture: unknown): ReopenedSessionTranscriptCapture => {
  if (!rawCapture || typeof rawCapture !== "object") {
    throw new Error("Invalid reopened-session capture artifact: expected object.");
  }

  const parsed = rawCapture as ReopenedSessionTranscriptCapture;
  if (!Array.isArray(parsed.captures)) {
    throw new Error("Invalid reopened-session capture artifact: captures is missing.");
  }

  return parsed;
};

export const enrichReopenedSessionTranscriptCapture = (
  rawCapture: unknown
): ReopenedSessionTranscriptCapture => {
  const parsed = parseCaptureInput(rawCapture);
  const baseLoaded = findPhaseCapture(parsed.captures, "base-loaded");
  const rolloutApplied = normalizeRolloutAppliedCapture(parsed.captures);

  if (!baseLoaded || !rolloutApplied) {
    return parsed;
  }

  const rawRolloutParsed = findPhaseCapture(parsed.captures, "rollout-parsed");
  const rolloutParsed =
    rawRolloutParsed ?? buildRolloutParsedCaptureFromApplied(rolloutApplied);
  const phaseSummary = classifyFirstBadLayer({
    baseLoaded,
    rolloutParsed,
    rolloutApplied
  });

  return {
    ...parsed,
    captures: [baseLoaded, rolloutParsed, rolloutApplied],
    analysis: {
      firstBadLayer: phaseSummary.firstBadLayer,
      rolloutParsedSource: rawRolloutParsed ? "raw" : "inferred-from-rollout-applied",
      coverage: phaseSummary.coverage,
      diffs: phaseSummary.diffs,
      notes: phaseSummary.notes
    }
  };
};
