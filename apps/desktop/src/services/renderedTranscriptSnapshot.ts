import type { VisibleMessageWindow } from "../components/chatWindow";
import { getMessageWindowKey, resolveVisibleMessageWindow } from "../components/chatWindow";
import type { ChatMessage, ChatRole, SessionSummary } from "../domain/types";

const PREVIEW_MAX_CHARS = 160;

export type RenderedTranscriptPhase = "base-loaded" | "rollout-idle";
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

export interface ReopenedSessionTranscriptCapture {
  sessionKey: string;
  threadId: string;
  deviceId: string;
  captures: RenderedTranscriptPhaseCapture[];
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
