import { create } from "zustand";
import {
  resolveComposerModel,
  resolveThinkingEffortForModel,
  resolveSupportedModelId
} from "../domain/modelCatalog";
import { makeSessionKey } from "../domain/sessionKey";
import type {
  ChatMessage,
  ComposerPreference,
  ComposerSubmission,
  DirectoryBrowseResult,
  DeviceAddSshRequest,
  DeviceRecord,
  NewSessionRequest,
  RpcNotification,
  SearchIndexThreadPayload,
  SearchSessionHit,
  SessionSummary,
  ThinkingEffort,
  TokenUsageBreakdown,
  ThreadTokenUsageState
} from "../domain/types";
import {
  closeAllClients,
  closeDeviceClient,
  listDirectories,
  listModels,
  listThreads,
  readThreadUsageFromRollout,
  readAccount,
  readThread,
  resumeThread,
  setNotificationSink,
  startThread,
  startTurn
} from "../services/codexApi";
import {
  parseRpcNotification,
  parseThreadModelNotification,
  parseThreadTokenUsageNotification
} from "../services/eventParser";
import { computeCostUsdFromUsage, resolveModelPricing } from "../services/modelPricing";
import { toSearchIndexThreadPayload } from "../services/searchIndexPayload";
import {
  addLocalDevice,
  addSshDevice,
  connectDevice,
  disconnectDevice,
  listDevices,
  removeDevice,
  searchBootstrapStatus,
  searchIndexRemoveDevice,
  searchIndexUpsertThread,
  searchQuery
} from "../services/tauriBridge";
import type {
  SearchHydrationWorkerRequest,
  SearchHydrationWorkerResponse
} from "../workers/searchHydrationProtocol";
import { mergeSessions } from "./sessionMerge";

interface AppStore {
  loading: boolean;
  devices: DeviceRecord[];
  sessions: SessionSummary[];
  selectedSessionKey: string | null;
  messagesBySession: Record<string, ChatMessage[]>;
  tokenUsageBySession: Record<string, ThreadTokenUsageState>;
  modelBySession: Record<string, string>;
  costUsdBySession: Record<string, number | null>;
  availableModelsByDevice: Record<string, string[]>;
  composerPrefsBySession: Record<string, ComposerPreference>;
  searchResults: SearchSessionHit[];
  searchTotalHits: number;
  searchLoading: boolean;
  searchHydrating: boolean;
  searchHydratedCount: number;
  searchHydrationTotal: number;
  searchError: string | null;
  globalError: string | null;
  initializing: boolean;
  initialize: () => Promise<void>;
  selectSession: (sessionKey: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshDeviceSessions: (deviceId: string) => Promise<void>;
  refreshThread: (
    deviceId: string,
    threadId: string,
    options?: { preserveSummary?: boolean; skipMessages?: boolean }
  ) => Promise<void>;
  browseDeviceDirectories: (
    deviceId: string,
    cwd: string
  ) => Promise<DirectoryBrowseResult>;
  startNewSession: (request: NewSessionRequest) => Promise<string | null>;
  submitComposer: (submission: ComposerSubmission) => Promise<void>;
  setComposerModel: (sessionKey: string, model: string) => void;
  setComposerThinkingEffort: (sessionKey: string, effort: ThinkingEffort) => void;
  addSsh: (request: DeviceAddSshRequest) => Promise<void>;
  connect: (deviceId: string) => Promise<void>;
  disconnect: (deviceId: string) => Promise<void>;
  remove: (deviceId: string) => Promise<void>;
  runChatSearch: (query: string, deviceId: string | null) => Promise<void>;
  clearChatSearch: () => void;
  clearError: () => void;
}

const fallbackLocalName = "Local Device";
const NOTIFICATION_REFRESH_MIN_INTERVAL_MS = 350;
const STREAMING_MERGE_WINDOW_MS = 10_000;
const POST_SEND_REFRESH_BURST_MS = 45_000;
const POST_SEND_REFRESH_INTERVAL_MS = 1_200;
const POST_SEND_REFRESH_INITIAL_DELAYS_MS = [250, 700, 1_300];
const USAGE_BACKFILL_MIN_INTERVAL_MS = 5_000;
const PENDING_OPTIMISTIC_RETAIN_MS = 120_000;
const OPTIMISTIC_ACK_CLOCK_SKEW_MS = 8_000;
const OPTIMISTIC_ACK_MAX_DELAY_MS = 45_000;
const SERVER_DUPLICATE_WINDOW_MS = 120_000;
const SEARCH_SIMILARITY_THRESHOLD = 0.9;
const SEARCH_MAX_SESSIONS = 10;
const BACKGROUND_SEARCH_HYDRATION_DELAY_MS = 30;

const pickSelectedSession = (
  preferred: string | null,
  sessions: SessionSummary[]
): string | null => {
  if (preferred && sessions.some((session) => session.key === preferred)) {
    return preferred;
  }
  return sessions[0]?.key ?? null;
};

const resolveSessionKeyForThread = (
  sessions: SessionSummary[],
  deviceId: string,
  threadId: string
): string => {
  const directKey = makeSessionKey(deviceId, threadId);
  if (sessions.some((session) => session.key === directKey)) {
    return directKey;
  }

  const sameThreadSameDevice = sessions.find(
    (session) => session.deviceId === deviceId && session.threadId === threadId
  );
  if (sameThreadSameDevice) {
    return sameThreadSameDevice.key;
  }

  const sameThreadAnyDevice = sessions.find((session) => session.threadId === threadId);
  return sameThreadAnyDevice?.key ?? directKey;
};

const upsertDevice = (
  devices: DeviceRecord[],
  incoming: DeviceRecord
): DeviceRecord[] => {
  const exists = devices.some((device) => device.id === incoming.id);
  if (!exists) {
    return [...devices, incoming].sort((a, b) => a.name.localeCompare(b.name));
  }
  return devices
    .map((device) => (device.id === incoming.id ? incoming : device))
    .sort((a, b) => a.name.localeCompare(b.name));
};

const upsertMessage = (
  existing: ChatMessage[],
  incoming: ChatMessage
): ChatMessage[] => {
  const existingIndex = existing.findIndex((entry) =>
    isSameLogicalMessage(entry, incoming) ||
    hasAcknowledgedEquivalent(entry, incoming) ||
    isEquivalentServerMessage(entry, incoming)
  );
  if (existingIndex === -1) {
    return dedupeEquivalentServerMessages([...existing, incoming]);
  }

  const current = existing[existingIndex];
  const merged: ChatMessage = {
    ...current,
    ...incoming,
    content: mergeMessageContent(current, incoming),
    createdAt: pickLatestTimestamp(current.createdAt, incoming.createdAt)
  };

  const next = [...existing];
  next[existingIndex] = merged;
  return dedupeEquivalentServerMessages(next);
};

const isStreamingMergeCandidate = (
  current: ChatMessage,
  incoming: ChatMessage
): boolean =>
  current.role !== "user" &&
  incoming.role !== "user" &&
  (current.eventType === "reasoning" ||
    incoming.eventType === "reasoning" ||
    current.role === "system" ||
    incoming.role === "system");

const appendStreamingChunk = (
  currentContent: string,
  incomingContent: string
): string => {
  if (incomingContent.length === 0) {
    return currentContent;
  }
  if (currentContent.length === 0) {
    return incomingContent;
  }
  if (
    currentContent === incomingContent ||
    currentContent.endsWith(incomingContent) ||
    incomingContent.startsWith(currentContent)
  ) {
    return incomingContent.length >= currentContent.length
      ? incomingContent
      : currentContent;
  }

  return `${currentContent}${incomingContent}`;
};

const mergeMessageContent = (
  current: ChatMessage,
  incoming: ChatMessage
): string => {
  const currentContent = current.content;
  const incomingContent = incoming.content;
  if (incomingContent.length === 0) {
    return currentContent;
  }
  if (currentContent.length === 0) {
    return incomingContent;
  }
  if (incomingContent === currentContent) {
    return incomingContent;
  }
  if (incomingContent.startsWith(currentContent)) {
    return incomingContent;
  }
  if (currentContent.startsWith(incomingContent)) {
    return currentContent;
  }

  if (isStreamingMergeCandidate(current, incoming)) {
    return appendStreamingChunk(currentContent, incomingContent);
  }

  return incomingContent.length >= currentContent.length
    ? incomingContent
    : currentContent;
};

const normalizeMessageText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const isOptimisticMessage = (message: ChatMessage): boolean =>
  message.id.startsWith("local-");

const imageSignature = (message: ChatMessage): string =>
  (message.images ?? [])
    .map((image) => image.url.trim())
    .filter((url) => url.length > 0)
    .join("|");

const isLikelyOptimisticAcknowledgement = (
  optimisticIso: string,
  incomingIso: string
): boolean => {
  const optimisticMs = Date.parse(optimisticIso);
  const incomingMs = Date.parse(incomingIso);
  if (Number.isNaN(optimisticMs) || Number.isNaN(incomingMs)) {
    return false;
  }

  return (
    incomingMs >= optimisticMs - OPTIMISTIC_ACK_CLOCK_SKEW_MS &&
    incomingMs <= optimisticMs + OPTIMISTIC_ACK_MAX_DELAY_MS
  );
};

const areServerTimestampsClose = (aIso: string, bIso: string): boolean => {
  const aMs = Date.parse(aIso);
  const bMs = Date.parse(bIso);
  if (Number.isNaN(aMs) || Number.isNaN(bMs)) {
    return false;
  }
  return Math.abs(aMs - bMs) <= SERVER_DUPLICATE_WINDOW_MS;
};

const hasAcknowledgedEquivalent = (
  current: ChatMessage,
  incoming: ChatMessage
): boolean => {
  if (current.role !== "user" || incoming.role !== "user") {
    return false;
  }

  const currentOptimistic = isOptimisticMessage(current);
  const incomingOptimistic = isOptimisticMessage(incoming);
  // Ack matching should only merge one optimistic local message with one
  // server-backed message; two optimistic sends with same text must remain distinct.
  if (currentOptimistic === incomingOptimistic) {
    return false;
  }

  const optimistic = currentOptimistic ? current : incoming;
  const server = currentOptimistic ? incoming : current;

  const optimisticText = normalizeMessageText(optimistic.content);
  const serverText = normalizeMessageText(server.content);
  if (optimisticText !== serverText) {
    return false;
  }

  if (imageSignature(optimistic) !== imageSignature(server)) {
    return false;
  }

  return isLikelyOptimisticAcknowledgement(optimistic.createdAt, server.createdAt);
};

const isEquivalentServerMessage = (
  current: ChatMessage,
  incoming: ChatMessage
): boolean => {
  if (isOptimisticMessage(current) || isOptimisticMessage(incoming)) {
    return false;
  }

  const sameContent =
    normalizeMessageText(current.content) === normalizeMessageText(incoming.content);
  const sameImages = imageSignature(current) === imageSignature(incoming);
  if (!sameContent || !sameImages) {
    return false;
  }

  const sameRoleAndType =
    current.role === incoming.role &&
    (current.eventType ?? "") === (incoming.eventType ?? "");
  if (sameRoleAndType) {
    return areServerTimestampsClose(current.createdAt, incoming.createdAt);
  }

  const assistantReasoningDuplicate =
    ((current.eventType === "reasoning" && incoming.role === "assistant") ||
      (incoming.eventType === "reasoning" && current.role === "assistant")) &&
    areServerTimestampsClose(current.createdAt, incoming.createdAt);

  return assistantReasoningDuplicate;
};

const isSameLogicalMessage = (
  current: ChatMessage,
  incoming: ChatMessage
): boolean => {
  if (
    current.id !== incoming.id ||
    current.role !== incoming.role ||
    (current.eventType ?? "") !== (incoming.eventType ?? "")
  ) {
    return false;
  }

  if (current.createdAt === incoming.createdAt) {
    return true;
  }

  const currentMs = Date.parse(current.createdAt);
  const incomingMs = Date.parse(incoming.createdAt);
  const streamingCandidate = isStreamingMergeCandidate(current, incoming);
  if (streamingCandidate) {
    if (Number.isNaN(currentMs) || Number.isNaN(incomingMs)) {
      return true;
    }
    if (Math.abs(currentMs - incomingMs) <= STREAMING_MERGE_WINDOW_MS * 2) {
      return true;
    }
  }

  if (Number.isNaN(currentMs) || Number.isNaN(incomingMs)) {
    return false;
  }

  if (Math.abs(currentMs - incomingMs) > STREAMING_MERGE_WINDOW_MS) {
    return false;
  }

  const currentContent = normalizeMessageText(current.content);
  const incomingContent = normalizeMessageText(incoming.content);
  if (currentContent.length === 0 || incomingContent.length === 0) {
    return true;
  }

  return (
    currentContent === incomingContent ||
    currentContent.startsWith(incomingContent) ||
    incomingContent.startsWith(currentContent)
  );
};

const pickLatestTimestamp = (a: string, b: string): string => {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);

  if (Number.isNaN(aMs)) {
    return b;
  }
  if (Number.isNaN(bMs)) {
    return a;
  }
  return bMs >= aMs ? b : a;
};

const sortMessagesAscending = (a: ChatMessage, b: ChatMessage): number => {
  const aMs = Date.parse(a.createdAt);
  const bMs = Date.parse(b.createdAt);
  if (Number.isNaN(aMs) && Number.isNaN(bMs)) {
    return 0;
  }
  if (Number.isNaN(aMs)) {
    return 1;
  }
  if (Number.isNaN(bMs)) {
    return -1;
  }
  if (aMs === bMs) {
    return 0;
  }
  return aMs - bMs;
};

const preferCanonicalMessage = (
  current: ChatMessage,
  incoming: ChatMessage
): ChatMessage => {
  const currentReasoning = current.eventType === "reasoning";
  const incomingReasoning = incoming.eventType === "reasoning";
  if (currentReasoning !== incomingReasoning) {
    return incomingReasoning ? current : incoming;
  }

  const currentImages = current.images?.length ?? 0;
  const incomingImages = incoming.images?.length ?? 0;
  if (incomingImages !== currentImages) {
    return incomingImages > currentImages ? incoming : current;
  }

  return pickLatestTimestamp(current.createdAt, incoming.createdAt) === incoming.createdAt
    ? incoming
    : current;
};

const dedupeEquivalentServerMessages = (
  messages: ChatMessage[]
): ChatMessage[] => {
  const deduped: ChatMessage[] = [];
  for (const message of messages) {
    const existingIndex = deduped.findIndex((entry) =>
      isEquivalentServerMessage(entry, message)
    );
    if (existingIndex === -1) {
      deduped.push(message);
      continue;
    }
    deduped[existingIndex] = preferCanonicalMessage(deduped[existingIndex], message);
  }
  return deduped.sort(sortMessagesAscending);
};

const mergeThreadMessages = (
  existing: ChatMessage[],
  incoming: ChatMessage[]
): ChatMessage[] => {
  let merged: ChatMessage[] = [];
  const incomingSorted = [...incoming].sort(sortMessagesAscending);
  for (const message of incomingSorted) {
    merged = upsertMessage(merged, message);
  }
  const nowMs = Date.now();

  for (const message of existing) {
    const alreadyPresent = merged.some(
      (entry) =>
        isSameLogicalMessage(entry, message) ||
        hasAcknowledgedEquivalent(message, entry) ||
        isEquivalentServerMessage(entry, message)
    );
    if (alreadyPresent) {
      continue;
    }

    const createdAtMs = Date.parse(message.createdAt);
    const ageMs = Number.isNaN(createdAtMs) ? 0 : nowMs - createdAtMs;
    const keepOptimisticPending =
      isOptimisticMessage(message) &&
      message.role === "user" &&
      ageMs <= PENDING_OPTIMISTIC_RETAIN_MS;
    const keepServerMessage = !isOptimisticMessage(message);

    if (!keepOptimisticPending && !keepServerMessage) {
      continue;
    }

    merged = upsertMessage(merged, message);
  }

  return dedupeEquivalentServerMessages(merged);
};

const normalizeSubmissionImages = (
  images: ComposerSubmission["images"]
): ComposerSubmission["images"] =>
  images
    .filter((image) => typeof image.url === "string" && image.url.trim().length > 0)
    .map((image) => ({
      ...image,
      url: image.url.trim()
    }));

const toComposerPreference = (params: {
  model: string | undefined;
  effort: ThinkingEffort | undefined;
}): ComposerPreference => {
  const model = resolveComposerModel(params.model);
  return {
    model,
    thinkingEffort: resolveThinkingEffortForModel(model, params.effort)
  };
};

const upsertComposerPreference = (
  current: Record<string, ComposerPreference>,
  sessionKey: string,
  model: string | undefined,
  effort: ThinkingEffort | undefined
): Record<string, ComposerPreference> => {
  const previous = current[sessionKey];
  const next = toComposerPreference({
    model: model ?? previous?.model,
    effort: effort ?? previous?.thinkingEffort
  });
  if (
    previous &&
    previous.model === next.model &&
    previous.thinkingEffort === next.thinkingEffort
  ) {
    return current;
  }

  return {
    ...current,
    [sessionKey]: next
  };
};

const findLocalDevice = (devices: DeviceRecord[]): DeviceRecord | null =>
  devices.find((device) => device.config.kind === "local") ?? null;

const isValidIsoTimestamp = (value: string): boolean =>
  !Number.isNaN(Date.parse(value));

const shouldIgnoreResumeError = (error: unknown): boolean => {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("no rollout found for thread id");
};

const computeSessionCostUsd = (
  model: string | undefined,
  tokenUsage: ThreadTokenUsageState | undefined
): number | null => {
  if (!model || !tokenUsage) {
    return null;
  }

  const pricing = resolveModelPricing(model);
  if (!pricing) {
    return null;
  }

  return computeCostUsdFromUsage(tokenUsage.total, pricing);
};

const makeUsageDeltaEventKey = (
  turnId: string | undefined,
  lastUsage: TokenUsageBreakdown
): string =>
  [
    turnId ?? "no-turn",
    lastUsage.totalTokens,
    lastUsage.inputTokens,
    lastUsage.cachedInputTokens,
    lastUsage.outputTokens,
    lastUsage.reasoningOutputTokens
  ].join(":");

const accumulateSessionCostFromLast = (params: {
  currentCostUsd: number | null | undefined;
  model: string | undefined;
  tokenUsage: ThreadTokenUsageState;
  lastAppliedEventKey: string | undefined;
}): { nextCostUsd: number | null; nextAppliedEventKey: string | undefined } => {
  const currentCostUsd =
    typeof params.currentCostUsd === "number" ? params.currentCostUsd : null;
  if (!params.model) {
    return {
      nextCostUsd: currentCostUsd,
      nextAppliedEventKey: params.lastAppliedEventKey
    };
  }

  const pricing = resolveModelPricing(params.model);
  if (!pricing) {
    return {
      nextCostUsd: currentCostUsd,
      nextAppliedEventKey: params.lastAppliedEventKey
    };
  }

  const totalCostUsd = computeCostUsdFromUsage(params.tokenUsage.total, pricing);
  const withTotalBaseline = (value: number | null): number | null => {
    if (totalCostUsd === null) {
      return value;
    }
    if (value === null) {
      return totalCostUsd;
    }
    return totalCostUsd > value ? totalCostUsd : value;
  };

  const usageEventKey = makeUsageDeltaEventKey(params.tokenUsage.turnId, params.tokenUsage.last);
  if (usageEventKey === params.lastAppliedEventKey) {
    return {
      nextCostUsd: withTotalBaseline(currentCostUsd),
      nextAppliedEventKey: params.lastAppliedEventKey
    };
  }

  const lastCostUsd = computeCostUsdFromUsage(params.tokenUsage.last, pricing);
  if (lastCostUsd === null) {
    return {
      nextCostUsd: withTotalBaseline(currentCostUsd),
      nextAppliedEventKey: params.lastAppliedEventKey
    };
  }

  return {
    nextCostUsd: withTotalBaseline((currentCostUsd ?? 0) + lastCostUsd),
    nextAppliedEventKey: usageEventKey
  };
};

const sessionsEqual = (
  current: SessionSummary[],
  next: SessionSummary[]
): boolean => {
  if (current.length !== next.length) {
    return false;
  }

  for (let index = 0; index < current.length; index += 1) {
    const a = current[index];
    const b = next[index];
    if (
      a.key !== b.key ||
      a.threadId !== b.threadId ||
      a.deviceId !== b.deviceId ||
      a.title !== b.title ||
      a.preview !== b.preview ||
      a.updatedAt !== b.updatedAt ||
      a.cwd !== b.cwd ||
      a.folderName !== b.folderName
    ) {
      return false;
    }
  }

  return true;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const pickString = (
  value: Record<string, unknown> | null | undefined,
  keys: string[]
): string | null => {
  if (!value) {
    return null;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return null;
};

let shutdownSearchHydrationWorkerCallback: (() => void) | null = null;

export const useAppStore = create<AppStore>((set, get) => {
  const notificationRefreshAtMs = new Map<string, number>();
  const postSendRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastAppliedCostEventKeyBySession = new Map<string, string>();
  const usageBackfillAtMsBySession = new Map<string, number>();
  const hydratedSearchSessions = new Set<string>();
  const queuedSearchHydrationSessions = new Set<string>();
  let searchHydrationPromise: Promise<void> | null = null;
  let activeHydrationSessionKey: string | null = null;
  let completedHydrations = 0;
  let activeSearchRequestId = 0;
  let searchHydrationWorker: Worker | null = null;
  let searchHydrationWorkerUnavailable = false;
  let nextSearchHydrationWorkerRequestId = 1;
  const pendingSearchHydrationWorkerRequests = new Map<
    number,
    {
      sessionKey: string;
      resolve: (payload: SearchIndexThreadPayload) => void;
      reject: (error: Error) => void;
    }
  >();

  const rejectPendingSearchHydrationWorkerRequests = (error: Error): void => {
    for (const pending of pendingSearchHydrationWorkerRequests.values()) {
      pending.reject(error);
    }
    pendingSearchHydrationWorkerRequests.clear();
  };

  const handleSearchHydrationWorkerResponse = (
    response: SearchHydrationWorkerResponse
  ): void => {
    const pending = pendingSearchHydrationWorkerRequests.get(response.requestId);
    if (!pending) {
      return;
    }
    pendingSearchHydrationWorkerRequests.delete(response.requestId);

    if (response.type === "hydrated-session") {
      pending.resolve(response.payload);
      return;
    }

    pending.reject(
      new Error(
        response.error || `Failed to hydrate search session ${response.sessionKey}.`
      )
    );
  };

  const ensureSearchHydrationWorker = (): Worker | null => {
    if (searchHydrationWorkerUnavailable) {
      return null;
    }
    if (searchHydrationWorker) {
      return searchHydrationWorker;
    }
    if (typeof Worker !== "function") {
      searchHydrationWorkerUnavailable = true;
      return null;
    }

    try {
      searchHydrationWorker = new Worker(
        new URL("../workers/searchHydrationWorker.ts", import.meta.url),
        { type: "module" }
      );
      searchHydrationWorker.onmessage = (
        event: MessageEvent<SearchHydrationWorkerResponse>
      ) => {
        handleSearchHydrationWorkerResponse(event.data);
      };
      searchHydrationWorker.onerror = (event): void => {
        const message =
          event.message?.trim() || "Search hydration worker crashed unexpectedly.";
        searchHydrationWorkerUnavailable = true;
        rejectPendingSearchHydrationWorkerRequests(new Error(message));
        searchHydrationWorker?.terminate();
        searchHydrationWorker = null;
      };
      return searchHydrationWorker;
    } catch {
      searchHydrationWorkerUnavailable = true;
      return null;
    }
  };

  const requestHydrationFromWorker = async (
    device: DeviceRecord,
    session: SessionSummary
  ): Promise<SearchIndexThreadPayload | null> => {
    const worker = ensureSearchHydrationWorker();
    if (!worker) {
      return null;
    }

    const requestId = nextSearchHydrationWorkerRequestId;
    nextSearchHydrationWorkerRequestId += 1;
    const request: SearchHydrationWorkerRequest = {
      type: "hydrate-session",
      requestId,
      device,
      session
    };

    return new Promise<SearchIndexThreadPayload>((resolve, reject) => {
      pendingSearchHydrationWorkerRequests.set(requestId, {
        sessionKey: session.key,
        resolve,
        reject
      });
      try {
        worker.postMessage(request);
      } catch (error) {
        pendingSearchHydrationWorkerRequests.delete(requestId);
        reject(
          error instanceof Error
            ? error
            : new Error("Failed to post search hydration request to worker.")
        );
      }
    });
  };

  const closeSearchHydrationWorkerDevice = (deviceId: string): void => {
    if (!searchHydrationWorker) {
      return;
    }
    const request: SearchHydrationWorkerRequest = {
      type: "close-device",
      deviceId
    };
    try {
      searchHydrationWorker.postMessage(request);
    } catch {
      // Non-critical cleanup.
    }
  };

  const shutdownSearchHydrationWorker = (): void => {
    if (!searchHydrationWorker) {
      return;
    }
    try {
      const request: SearchHydrationWorkerRequest = { type: "shutdown" };
      searchHydrationWorker.postMessage(request);
    } catch {
      // Ignore shutdown message failures and terminate directly.
    }
    rejectPendingSearchHydrationWorkerRequests(
      new Error("Search hydration worker was shut down.")
    );
    searchHydrationWorker.terminate();
    searchHydrationWorker = null;
  };

  const hydrateSessionOnMainThread = async (
    device: DeviceRecord,
    session: SessionSummary
  ): Promise<SearchIndexThreadPayload> => {
    const payload = await readThread(device, session.threadId);
    return toSearchIndexThreadPayload(payload.session, payload.messages);
  };

  const hydrateSessionSearchPayload = async (
    device: DeviceRecord,
    session: SessionSummary
  ): Promise<SearchIndexThreadPayload> => {
    const workerPayload = await requestHydrationFromWorker(device, session);
    if (workerPayload) {
      return workerPayload;
    }
    return hydrateSessionOnMainThread(device, session);
  };

  shutdownSearchHydrationWorkerCallback = shutdownSearchHydrationWorker;

  const stopPostSendRefresh = (sessionKey: string): void => {
    const pendingTimer = postSendRefreshTimers.get(sessionKey);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      postSendRefreshTimers.delete(sessionKey);
    }
  };

  const stopPostSendRefreshesForDevice = (deviceId: string): void => {
    const prefix = `${deviceId}::`;
    for (const sessionKey of postSendRefreshTimers.keys()) {
      if (sessionKey.startsWith(prefix)) {
        stopPostSendRefresh(sessionKey);
      }
    }
  };

  const clearAppliedCostEventKeysForDevice = (deviceId: string): void => {
    const prefix = `${deviceId}::`;
    for (const sessionKey of lastAppliedCostEventKeyBySession.keys()) {
      if (sessionKey.startsWith(prefix)) {
        lastAppliedCostEventKeyBySession.delete(sessionKey);
      }
    }
  };

  const clearUsageBackfillStateForDevice = (deviceId: string): void => {
    const prefix = `${deviceId}::`;
    for (const sessionKey of usageBackfillAtMsBySession.keys()) {
      if (sessionKey.startsWith(prefix)) {
        usageBackfillAtMsBySession.delete(sessionKey);
      }
    }
  };

  const clearHydratedSearchSessionsForDevice = (deviceId: string): void => {
    const prefix = `${deviceId}::`;
    for (const sessionKey of [...hydratedSearchSessions]) {
      if (sessionKey.startsWith(prefix)) {
        hydratedSearchSessions.delete(sessionKey);
      }
    }
  };

  const clearQueuedSearchHydrationForDevice = (deviceId: string): void => {
    const prefix = `${deviceId}::`;
    for (const sessionKey of [...queuedSearchHydrationSessions]) {
      if (sessionKey.startsWith(prefix)) {
        queuedSearchHydrationSessions.delete(sessionKey);
      }
    }
  };

  const rejectPendingSearchHydrationWorkerRequestsForDevice = (
    deviceId: string
  ): void => {
    const prefix = `${deviceId}::`;
    for (const [requestId, pending] of pendingSearchHydrationWorkerRequests) {
      if (!pending.sessionKey.startsWith(prefix)) {
        continue;
      }
      pendingSearchHydrationWorkerRequests.delete(requestId);
      pending.reject(new Error(`Device ${deviceId} disconnected during search hydration.`));
    }
  };

  const refreshAvailableModelsForDevice = (deviceId: string): void => {
    void (async () => {
      const snapshot = get();
      const device = snapshot.devices.find((entry) => entry.id === deviceId);
      if (!device || !device.connected) {
        return;
      }

      try {
        const rawAvailableModels = await listModels(device);
        const normalized = [...new Set(
          rawAvailableModels
            .map((modelId) => resolveSupportedModelId(modelId))
            .filter((modelId): modelId is string => modelId !== null)
        )];
        if (normalized.length === 0) {
          return;
        }

        set((state) => {
          const previous = state.availableModelsByDevice[deviceId] ?? null;
          if (
            previous &&
            previous.length === normalized.length &&
            previous.every((entry, index) => entry === normalized[index])
          ) {
            return {};
          }

          return {
            availableModelsByDevice: {
              ...state.availableModelsByDevice,
              [deviceId]: normalized
            }
          };
        });
      } catch {
        // Keep current availability state if model listing fails.
      }
    })();
  };

  const ensureComposerPreferenceForSession = (sessionKey: string): void => {
    set((state) => {
      const nextComposerPrefs = upsertComposerPreference(
        state.composerPrefsBySession,
        sessionKey,
        undefined,
        undefined
      );
      if (nextComposerPrefs === state.composerPrefsBySession) {
        return {};
      }

      return {
        composerPrefsBySession: nextComposerPrefs
      };
    });
  };

  const upsertThreadIntoSearchIndex = (
    session: SessionSummary,
    messages: ChatMessage[]
  ): void => {
    hydratedSearchSessions.add(session.key);
    const payload = toSearchIndexThreadPayload(session, messages);
    void searchIndexUpsertThread(payload).catch(() => {
      // Keep search functional even if persistence/indexing fails on one update.
    });
  };

  const syncSearchHydrationProgress = (): void => {
    const pendingCount =
      queuedSearchHydrationSessions.size + (activeHydrationSessionKey ? 1 : 0);
    const total = completedHydrations + pendingCount;
    set({
      searchHydrating: pendingCount > 0,
      searchHydratedCount: completedHydrations,
      searchHydrationTotal: total
    });
  };

  const startBackgroundSearchHydration = (): void => {
    if (searchHydrationPromise || queuedSearchHydrationSessions.size === 0) {
      return;
    }

    completedHydrations = 0;
    syncSearchHydrationProgress();

    searchHydrationPromise = (async () => {
      while (queuedSearchHydrationSessions.size > 0) {
        const nextSessionKey = queuedSearchHydrationSessions.values().next()
          .value as string | undefined;
        if (!nextSessionKey) {
          break;
        }

        queuedSearchHydrationSessions.delete(nextSessionKey);
        activeHydrationSessionKey = nextSessionKey;
        syncSearchHydrationProgress();

        const session = get().sessions.find((entry) => entry.key === nextSessionKey);
        if (
          session &&
          !hydratedSearchSessions.has(session.key) &&
          session.threadId.trim().length > 0
        ) {
          const device = get().devices.find(
            (entry) => entry.id === session.deviceId && entry.connected
          );
          if (device) {
            try {
              const payload = await hydrateSessionSearchPayload(device, session);
              const stillConnected = get().devices.some(
                (entry) => entry.id === session.deviceId && entry.connected
              );
              if (stillConnected) {
                await searchIndexUpsertThread(payload);
                hydratedSearchSessions.add(session.key);
              }
            } catch {
              // Search hydration is best-effort; keep queue progressing on failures.
            }
          }
        }

        completedHydrations += 1;
        activeHydrationSessionKey = null;
        syncSearchHydrationProgress();

        await new Promise<void>((resolve) => {
          setTimeout(resolve, BACKGROUND_SEARCH_HYDRATION_DELAY_MS);
        });
      }
    })()
      .catch(() => {
        // Search hydration is best-effort; refreshThread already records user-visible errors.
      })
      .finally(() => {
        activeHydrationSessionKey = null;
        searchHydrationPromise = null;
        completedHydrations = 0;
        set({
          searchHydrating: false,
          searchHydratedCount: 0,
          searchHydrationTotal: 0
        });

        if (queuedSearchHydrationSessions.size > 0) {
          startBackgroundSearchHydration();
        }
      });
  };

  const scheduleBackgroundSearchHydration = (sessions: SessionSummary[]): void => {
    let added = false;
    for (const session of sessions) {
      if (hydratedSearchSessions.has(session.key)) {
        continue;
      }
      if (queuedSearchHydrationSessions.has(session.key)) {
        continue;
      }
      if (session.threadId.trim().length === 0) {
        continue;
      }
      queuedSearchHydrationSessions.add(session.key);
      added = true;
    }

    if (!added && !searchHydrationPromise) {
      return;
    }

    syncSearchHydrationProgress();
    startBackgroundSearchHydration();
  };

  const startPostSendRefreshBurst = (params: {
    sessionKey: string;
    deviceId: string;
    threadId: string;
  }): void => {
    stopPostSendRefresh(params.sessionKey);

    for (const delayMs of POST_SEND_REFRESH_INITIAL_DELAYS_MS) {
      setTimeout(() => {
        void get().refreshThread(params.deviceId, params.threadId, {
          preserveSummary: true
        });
      }, delayMs);
    }

    const startedAt = Date.now();
    const tick = (): void => {
      void get().refreshThread(params.deviceId, params.threadId, {
        preserveSummary: true
      });

      if (Date.now() - startedAt >= POST_SEND_REFRESH_BURST_MS) {
        stopPostSendRefresh(params.sessionKey);
        return;
      }

      const pendingTimer = setTimeout(tick, POST_SEND_REFRESH_INTERVAL_MS);
      postSendRefreshTimers.set(params.sessionKey, pendingTimer);
    };

    const pendingTimer = setTimeout(tick, POST_SEND_REFRESH_INTERVAL_MS);
    postSendRefreshTimers.set(params.sessionKey, pendingTimer);
  };

  const backfillUsageFromRollout = (params: {
    sessionKey: string;
    deviceId: string;
    threadId: string;
  }): void => {
    const nowMs = Date.now();
    const lastBackfillMs = usageBackfillAtMsBySession.get(params.sessionKey) ?? 0;
    if (nowMs - lastBackfillMs < USAGE_BACKFILL_MIN_INTERVAL_MS) {
      return;
    }
    usageBackfillAtMsBySession.set(params.sessionKey, nowMs);

    void (async () => {
      const snapshot = get();
      const existingUsage = snapshot.tokenUsageBySession[params.sessionKey];
      if (existingUsage && existingUsage.threadId === params.threadId) {
        return;
      }

      const device = snapshot.devices.find((entry) => entry.id === params.deviceId);
      if (!device || !device.connected) {
        return;
      }

      try {
        const usageSnapshot = await readThreadUsageFromRollout(device, params.threadId);
        if (!usageSnapshot) {
          return;
        }

        set((state) => {
          const sessionKey = resolveSessionKeyForThread(
            state.sessions,
            params.deviceId,
            params.threadId
          );
          const tokenUsageState: ThreadTokenUsageState = {
            threadId: usageSnapshot.threadId,
            ...(usageSnapshot.turnId ? { turnId: usageSnapshot.turnId } : {}),
            total: usageSnapshot.tokenUsage.total,
            last: usageSnapshot.tokenUsage.last,
            modelContextWindow: usageSnapshot.tokenUsage.modelContextWindow ?? null,
            updatedAt: new Date().toISOString()
          };

          const nextModelBySession = usageSnapshot.model
            ? {
                ...state.modelBySession,
                [sessionKey]: usageSnapshot.model
              }
            : state.modelBySession;
          const model = usageSnapshot.model ?? state.modelBySession[sessionKey];
          const accumulation = accumulateSessionCostFromLast({
            currentCostUsd: state.costUsdBySession[sessionKey],
            model,
            tokenUsage: tokenUsageState,
            lastAppliedEventKey: lastAppliedCostEventKeyBySession.get(sessionKey)
          });
          if (accumulation.nextAppliedEventKey) {
            lastAppliedCostEventKeyBySession.set(
              sessionKey,
              accumulation.nextAppliedEventKey
            );
          }

          return {
            modelBySession: nextModelBySession,
            tokenUsageBySession: {
              ...state.tokenUsageBySession,
              [sessionKey]: tokenUsageState
            },
            costUsdBySession: {
              ...state.costUsdBySession,
              [sessionKey]: accumulation.nextCostUsd
            }
          };
        });
      } catch {
        // Best-effort fallback; ignore rollout read failures.
      }
    })();
  };

  const refreshThreadFromNotification = (
    deviceId: string,
    notification: RpcNotification
  ): void => {
    const method = notification.method.replaceAll(".", "/").toLowerCase();
    if (
      !method.startsWith("turn/") &&
      !method.startsWith("message/") &&
      !method.startsWith("item/") &&
      !method.startsWith("codex/event/")
    ) {
      return;
    }

    const params = asRecord(notification.params);
    const msg = asRecord(params?.msg);
    const threadId =
      pickString(params, ["threadId", "thread_id"]) ??
      pickString(params, ["conversationId", "conversation_id"]) ??
      pickString(asRecord(params?.message), ["threadId", "thread_id"]) ??
      pickString(asRecord(params?.item), ["threadId", "thread_id"]) ??
      pickString(asRecord(params?.turn), ["threadId", "thread_id"]) ??
      pickString(msg, ["thread_id", "threadId", "session_id", "sessionId"]) ??
      pickString(msg, ["conversationId", "conversation_id"]);
    if (!threadId) {
      return;
    }

    const sessionKey = makeSessionKey(deviceId, threadId);
    const nowMs = Date.now();
    const lastRefreshMs = notificationRefreshAtMs.get(sessionKey) ?? 0;
    if (nowMs - lastRefreshMs < NOTIFICATION_REFRESH_MIN_INTERVAL_MS) {
      return;
    }
    notificationRefreshAtMs.set(sessionKey, nowMs);

    void get().refreshThread(deviceId, threadId, { preserveSummary: true });
  };

  const applyNotification = (deviceId: string, notification: RpcNotification): void => {
    const parsedModel = parseThreadModelNotification(notification);
    if (parsedModel) {
      set((state) => {
        const sessionKey = resolveSessionKeyForThread(
          state.sessions,
          deviceId,
          parsedModel.threadId
        );
        const nextModelBySession = {
          ...state.modelBySession,
          [sessionKey]: parsedModel.model
        };
        const tokenUsage = state.tokenUsageBySession[sessionKey];
        const currentCostUsd = state.costUsdBySession[sessionKey];
        let nextCostUsd =
          typeof currentCostUsd === "number" ? currentCostUsd : null;

        // If we did not have model pricing at the time token usage arrived,
        // bootstrap from cumulative total once the model is known.
        if (nextCostUsd === null) {
          nextCostUsd = computeSessionCostUsd(parsedModel.model, tokenUsage);
          if (nextCostUsd !== null && tokenUsage) {
            lastAppliedCostEventKeyBySession.set(
              sessionKey,
              makeUsageDeltaEventKey(tokenUsage.turnId, tokenUsage.last)
            );
          }
        }

        return {
          modelBySession: nextModelBySession,
          costUsdBySession: {
            ...state.costUsdBySession,
            [sessionKey]: nextCostUsd
          }
        };
      });
    }

    const selectedSession =
      get().sessions.find((session) => session.key === get().selectedSessionKey) ?? null;
    const parsedTokenUsage = parseThreadTokenUsageNotification(
      notification,
      selectedSession?.threadId
    );
    if (parsedTokenUsage) {
      const tokenUsageState: ThreadTokenUsageState = {
        threadId: parsedTokenUsage.threadId,
        ...(parsedTokenUsage.turnId ? { turnId: parsedTokenUsage.turnId } : {}),
        total: parsedTokenUsage.tokenUsage.total,
        last: parsedTokenUsage.tokenUsage.last,
        modelContextWindow: parsedTokenUsage.tokenUsage.modelContextWindow ?? null,
        updatedAt: new Date().toISOString()
      };

      set((state) => {
        const sessionKey = resolveSessionKeyForThread(
          state.sessions,
          deviceId,
          parsedTokenUsage.threadId
        );
        const model = state.modelBySession[sessionKey];
        const accumulation = accumulateSessionCostFromLast({
          currentCostUsd: state.costUsdBySession[sessionKey],
          model,
          tokenUsage: tokenUsageState,
          lastAppliedEventKey: lastAppliedCostEventKeyBySession.get(sessionKey)
        });
        if (accumulation.nextAppliedEventKey) {
          lastAppliedCostEventKeyBySession.set(
            sessionKey,
            accumulation.nextAppliedEventKey
          );
        }
        const nextCostUsd = accumulation.nextCostUsd;
        return {
          tokenUsageBySession: {
            ...state.tokenUsageBySession,
            [sessionKey]: tokenUsageState
          },
          costUsdBySession: {
            ...state.costUsdBySession,
            [sessionKey]: nextCostUsd
          }
        };
      });
      return;
    }

    const parsed = parseRpcNotification(deviceId, notification);
    if (!parsed) {
      refreshThreadFromNotification(deviceId, notification);
      return;
    }

    set((state) => {
      const resolvedSessionKey = resolveSessionKeyForThread(
        state.sessions,
        deviceId,
        parsed.threadId
      );
      const current = state.messagesBySession[resolvedSessionKey] ?? [];
      const next = upsertMessage(current, parsed.message);
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [resolvedSessionKey]: next
        }
      };
    });
    refreshThreadFromNotification(deviceId, notification);
  };

  const ensureDeviceConnected = async (device: DeviceRecord): Promise<void> => {
    if (!device.connected) {
      return;
    }

    const authenticated = await readAccount(device);
    if (!authenticated) {
      throw new Error(
        `${device.name} is not authenticated. Run \`codex login\` on that device and reconnect.`
      );
    }
  };

  return {
    loading: false,
    initializing: false,
    devices: [],
    sessions: [],
    selectedSessionKey: null,
    messagesBySession: {},
    tokenUsageBySession: {},
    modelBySession: {},
    costUsdBySession: {},
    availableModelsByDevice: {},
    composerPrefsBySession: {},
    searchResults: [],
    searchTotalHits: 0,
    searchLoading: false,
    searchHydrating: false,
    searchHydratedCount: 0,
    searchHydrationTotal: 0,
    searchError: null,
    globalError: null,
    initialize: async () => {
      if (get().initializing) {
        return;
      }

      set({ initializing: true, loading: true, globalError: null });
      setNotificationSink(applyNotification);

      try {
        try {
          const status = await searchBootstrapStatus();
          if (
            status.indexedSessions > 0 ||
            status.indexedMessages > 0
          ) {
            // Persisted index exists; new/updated threads will be upserted as they load.
            set({
              searchHydratedCount: status.indexedSessions,
              searchHydrationTotal: status.indexedSessions
            });
          }
        } catch {
          // Search bootstrap status is optional; ignore failures.
        }

        let devices = await listDevices();

        const localDevices = devices.filter(
          (device) => device.config.kind === "local"
        );
        if (localDevices.length > 1) {
          for (const duplicate of localDevices.slice(1)) {
            await removeDevice(duplicate.id);
          }
          devices = await listDevices();
        }

        let localDevice = findLocalDevice(devices);
        if (!localDevice) {
          localDevice = await addLocalDevice({ name: fallbackLocalName });
          devices = upsertDevice(devices, localDevice);
        }

        if (localDevice && !localDevice.connected) {
          try {
            const connectedLocal = await connectDevice(localDevice.id);
            devices = upsertDevice(devices, connectedLocal);
            localDevice = connectedLocal;
          } catch (error) {
            const message = toErrorMessage(error);
            devices = upsertDevice(devices, {
              ...localDevice,
              connected: false,
              lastError: message
            });
          }
        }

        set({ devices, globalError: null });

        for (const device of devices) {
          if (device.connected) {
            try {
              await ensureDeviceConnected(device);
              refreshAvailableModelsForDevice(device.id);
            } catch (error) {
              const message = toErrorMessage(error);
              set((state) => ({
                devices: state.devices.map((entry) =>
                  entry.id === device.id ? { ...entry, lastError: message } : entry
                )
              }));
            }
          }
        }

        await get().refreshSessions();
        scheduleBackgroundSearchHydration(get().sessions);
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      } finally {
        set({ loading: false, initializing: false });
      }
    },
    selectSession: async (sessionKey) => {
      set({ selectedSessionKey: sessionKey });
      ensureComposerPreferenceForSession(sessionKey);
      const selected = get().sessions.find((session) => session.key === sessionKey);
      if (!selected) {
        return;
      }

      await get().refreshThread(selected.deviceId, selected.threadId, {
        preserveSummary: true
      });
    },
    refreshSessions: async () => {
      const devices = get().devices;
      const sessionBuckets: SessionSummary[] = [];

      for (const device of devices) {
        if (!device.connected) {
          continue;
        }

        try {
          await ensureDeviceConnected(device);
          const threads = await listThreads(device);
          sessionBuckets.push(...threads);
          refreshAvailableModelsForDevice(device.id);
          set((state) => ({
            devices: state.devices.map((entry) =>
              entry.id === device.id ? { ...entry, lastError: undefined } : entry
            )
          }));
        } catch (error) {
          const message = toErrorMessage(error);
          set((state) => ({
            devices: state.devices.map((entry) =>
              entry.id === device.id ? { ...entry, lastError: message } : entry
            )
          }));
        }
      }

      const previousState = get();
      const incomingKeys = new Set(sessionBuckets.map((session) => session.key));
      const selectedKey = previousState.selectedSessionKey;
      const preserved = previousState.sessions.filter((session) =>
        incomingKeys.has(session.key) || session.key === selectedKey
      );
      const sessions = mergeSessions(preserved, sessionBuckets);
      const selectedSessionKey = pickSelectedSession(
        previousState.selectedSessionKey,
        sessions
      );

      if (
        !sessionsEqual(previousState.sessions, sessions) ||
        previousState.selectedSessionKey !== selectedSessionKey
      ) {
        set({ sessions, selectedSessionKey });
      }

      const selected = get().selectedSessionKey;
      if (selected) {
        ensureComposerPreferenceForSession(selected);
        const session = get().sessions.find((entry) => entry.key === selected);
        if (session) {
          await get().refreshThread(session.deviceId, session.threadId, {
            preserveSummary: true
          });
        }
      }

      const hydrationCandidates = get()
        .sessions.filter((session) => !isValidIsoTimestamp(session.updatedAt))
        .slice(0, 3);
      for (const candidate of hydrationCandidates) {
        void get().refreshThread(candidate.deviceId, candidate.threadId, {
          skipMessages: true
        });
      }

      scheduleBackgroundSearchHydration(get().sessions);
    },
    refreshDeviceSessions: async (deviceId) => {
      const device = get().devices.find((entry) => entry.id === deviceId);
      if (!device || !device.connected) {
        return;
      }

      try {
        await ensureDeviceConnected(device);
        const threads = await listThreads(device);
        refreshAvailableModelsForDevice(deviceId);
        set((state) => {
          const incomingKeys = new Set(threads.map((session) => session.key));
          const otherDevices = state.sessions.filter(
            (session) => session.deviceId !== deviceId
          );
          const selectedKey = state.selectedSessionKey;
          const preservedForDevice = state.sessions.filter(
            (session) =>
              session.deviceId === deviceId &&
              (incomingKeys.has(session.key) || session.key === selectedKey)
          );
          const mergedSessions = mergeSessions(
            [...otherDevices, ...preservedForDevice],
            threads
          );
          const selectedSessionKey = pickSelectedSession(
            state.selectedSessionKey,
            mergedSessions
          );

          return {
            sessions: mergedSessions,
            selectedSessionKey,
            devices: state.devices.map((entry) =>
              entry.id === deviceId ? { ...entry, lastError: undefined } : entry
            )
          };
        });

        const selected = get().selectedSessionKey;
        if (selected) {
          ensureComposerPreferenceForSession(selected);
        }

        const hydrationCandidates = get()
          .sessions.filter(
            (session) =>
              session.deviceId === deviceId && !isValidIsoTimestamp(session.updatedAt)
          )
          .slice(0, 3);
        for (const candidate of hydrationCandidates) {
          void get().refreshThread(candidate.deviceId, candidate.threadId, {
            skipMessages: true
          });
        }

        scheduleBackgroundSearchHydration(
          get().sessions.filter((session) => session.deviceId === deviceId)
        );
      } catch (error) {
        const message = toErrorMessage(error);
        set((state) => ({
          devices: state.devices.map((entry) =>
            entry.id === deviceId ? { ...entry, lastError: message } : entry
          )
        }));
      }
    },
    refreshThread: async (deviceId, threadId, options) => {
      const device = get().devices.find((entry) => entry.id === deviceId);
      if (!device || !device.connected) {
        return;
      }

      try {
        const payload = await readThread(device, threadId);
        set((state) => {
          const nextSessions =
            options?.preserveSummary &&
            state.sessions.some((session) => session.key === payload.session.key)
              ? state.sessions
              : mergeSessions(state.sessions, [payload.session]);
          const nextModelBySession = payload.model
            ? {
                ...state.modelBySession,
                [payload.session.key]: payload.model
              }
            : state.modelBySession;
          const nextCostUsdBySession = payload.model
            ? {
                ...state.costUsdBySession,
                [payload.session.key]: computeSessionCostUsd(
                  payload.model,
                  state.tokenUsageBySession[payload.session.key]
                )
              }
            : state.costUsdBySession;
          return {
            sessions: nextSessions,
            modelBySession: nextModelBySession,
            costUsdBySession: nextCostUsdBySession,
            messagesBySession: options?.skipMessages
              ? state.messagesBySession
              : {
                  ...state.messagesBySession,
                  [payload.session.key]: mergeThreadMessages(
                    state.messagesBySession[payload.session.key] ?? [],
                    payload.messages
                  )
            }
          };
        });

        backfillUsageFromRollout({
          sessionKey: payload.session.key,
          deviceId,
          threadId
        });

        if (!options?.skipMessages) {
          const indexedMessages =
            get().messagesBySession[payload.session.key] ?? payload.messages;
          upsertThreadIntoSearchIndex(payload.session, indexedMessages);
        }
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      }
    },
    browseDeviceDirectories: async (deviceId, cwd) => {
      const device = get().devices.find((entry) => entry.id === deviceId);
      if (!device || !device.connected) {
        throw new Error(`Device ${deviceId} is not connected.`);
      }

      return listDirectories(device, cwd);
    },
    startNewSession: async ({ deviceId, cwd }) => {
      const device = get().devices.find((entry) => entry.id === deviceId);
      if (!device || !device.connected) {
        throw new Error(`Device ${deviceId} is not connected.`);
      }

      const started = await startThread(device, cwd);
      const payload = await readThread(device, started.threadId);
      const model = payload.model ?? started.model;

      set((state) => ({
        sessions: mergeSessions(state.sessions, [payload.session]),
        selectedSessionKey: payload.session.key,
        modelBySession: model
          ? {
              ...state.modelBySession,
              [payload.session.key]: model
            }
          : state.modelBySession,
        costUsdBySession: model
          ? {
              ...state.costUsdBySession,
              [payload.session.key]: computeSessionCostUsd(
                model,
                state.tokenUsageBySession[payload.session.key]
              )
            }
          : state.costUsdBySession,
        messagesBySession: {
          ...state.messagesBySession,
          [payload.session.key]: mergeThreadMessages(
            state.messagesBySession[payload.session.key] ?? [],
            payload.messages
          )
        },
        composerPrefsBySession: upsertComposerPreference(
          state.composerPrefsBySession,
          payload.session.key,
          undefined,
          undefined
        ),
        globalError: null
      }));

      const indexedMessages =
        get().messagesBySession[payload.session.key] ?? payload.messages;
      upsertThreadIntoSearchIndex(payload.session, indexedMessages);

      return payload.session.key;
    },
    submitComposer: async (submissionInput) => {
      const state = get();
      const session = state.sessions.find(
        (entry) => entry.key === state.selectedSessionKey
      );
      const prompt = submissionInput.prompt.trim();
      const images = normalizeSubmissionImages(submissionInput.images);
      const model = resolveComposerModel(submissionInput.model);
      const thinkingEffort = resolveThinkingEffortForModel(
        model,
        submissionInput.thinkingEffort
      );
      if (!session || (prompt.length === 0 && images.length === 0)) {
        return;
      }

      const threadId = session.threadId.trim();
      if (threadId.length === 0) {
        set({
          globalError: "Cannot send message: session is missing a thread id."
        });
        return;
      }

      const device = state.devices.find((entry) => entry.id === session.deviceId);
      if (!device || !device.connected) {
        set({
          globalError: `Device ${session.deviceLabel} is not connected.`
        });
        return;
      }

      const optimisticUserMessage: ChatMessage = {
        id: `local-${Date.now().toString(36)}`,
        key: session.key,
        threadId,
        deviceId: session.deviceId,
        role: "user",
        content: prompt,
        createdAt: new Date().toISOString(),
        ...(images.length > 0 ? { images } : {})
      };

      set((prev) => ({
        messagesBySession: {
          ...prev.messagesBySession,
          [session.key]: upsertMessage(
            prev.messagesBySession[session.key] ?? [],
            optimisticUserMessage
          )
        },
        composerPrefsBySession: upsertComposerPreference(
          prev.composerPrefsBySession,
          session.key,
          model,
          thinkingEffort
        ),
        globalError: null
      }));

      startPostSendRefreshBurst({
        sessionKey: session.key,
        deviceId: session.deviceId,
        threadId
      });

      void (async () => {
        try {
          try {
            const resumed = await resumeThread(device, threadId);
            if (resumed.model) {
              const resumedModel = resumed.model;
              set((state) => ({
                modelBySession: {
                  ...state.modelBySession,
                  [session.key]: resumedModel
                },
                costUsdBySession: {
                  ...state.costUsdBySession,
                  [session.key]:
                    state.costUsdBySession[session.key] ??
                    computeSessionCostUsd(
                      resumedModel,
                      state.tokenUsageBySession[session.key]
                    )
                }
              }));
            }
          } catch (error) {
            if (!shouldIgnoreResumeError(error)) {
              throw error;
            }
          }

          await startTurn(device, threadId, {
            prompt,
            images,
            model,
            thinkingEffort
          });
        } catch (error) {
          stopPostSendRefresh(session.key);
          set({ globalError: toErrorMessage(error) });
        }
      })();
    },
    setComposerModel: (sessionKey, model) => {
      set((state) => {
        const nextComposerPrefs = upsertComposerPreference(
          state.composerPrefsBySession,
          sessionKey,
          model,
          undefined
        );
        if (nextComposerPrefs === state.composerPrefsBySession) {
          return {};
        }

        return {
          composerPrefsBySession: nextComposerPrefs
        };
      });
    },
    setComposerThinkingEffort: (sessionKey, effort) => {
      set((state) => {
        const sessionModel =
          state.composerPrefsBySession[sessionKey]?.model ??
          state.modelBySession[sessionKey];
        const nextComposerPrefs = upsertComposerPreference(
          state.composerPrefsBySession,
          sessionKey,
          sessionModel,
          effort
        );
        if (nextComposerPrefs === state.composerPrefsBySession) {
          return {};
        }

        return {
          composerPrefsBySession: nextComposerPrefs
        };
      });
    },
    addSsh: async (request) => {
      try {
        const device = await addSshDevice(request);
        set((state) => ({
          devices: upsertDevice(state.devices, device),
          globalError: null
        }));
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      }
    },
    connect: async (deviceId) => {
      try {
        set({ loading: true });
        const connected = await connectDevice(deviceId);
        await ensureDeviceConnected(connected);
        set((state) => ({
          devices: upsertDevice(state.devices, connected),
          globalError: null
        }));
        refreshAvailableModelsForDevice(deviceId);
        await get().refreshDeviceSessions(deviceId);
        scheduleBackgroundSearchHydration(
          get().sessions.filter((session) => session.deviceId === deviceId)
        );
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      } finally {
        set({ loading: false });
      }
    },
    disconnect: async (deviceId) => {
      try {
        const device = get().devices.find((entry) => entry.id === deviceId);
        if (!device || device.config.kind === "local") {
          return;
        }

        stopPostSendRefreshesForDevice(deviceId);
        clearAppliedCostEventKeysForDevice(deviceId);
        clearUsageBackfillStateForDevice(deviceId);
        clearQueuedSearchHydrationForDevice(deviceId);
        clearHydratedSearchSessionsForDevice(deviceId);
        rejectPendingSearchHydrationWorkerRequestsForDevice(deviceId);
        closeSearchHydrationWorkerDevice(deviceId);
        syncSearchHydrationProgress();
        const disconnected = await disconnectDevice(deviceId);
        closeDeviceClient(deviceId);
        set((state) => ({
          devices: upsertDevice(state.devices, disconnected)
        }));
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      }
    },
    remove: async (deviceId) => {
      try {
        const device = get().devices.find((entry) => entry.id === deviceId);
        if (!device || device.config.kind === "local") {
          return;
        }

        stopPostSendRefreshesForDevice(deviceId);
        clearAppliedCostEventKeysForDevice(deviceId);
        clearUsageBackfillStateForDevice(deviceId);
        clearQueuedSearchHydrationForDevice(deviceId);
        rejectPendingSearchHydrationWorkerRequestsForDevice(deviceId);
        closeSearchHydrationWorkerDevice(deviceId);
        const devices = await removeDevice(deviceId);
        clearHydratedSearchSessionsForDevice(deviceId);
        syncSearchHydrationProgress();
        void searchIndexRemoveDevice(deviceId).catch(() => {
          // Best-effort cleanup; search index can be rebuilt from thread hydration.
        });
        closeDeviceClient(deviceId);
        set((state) => {
          const sessions = state.sessions.filter((session) => session.deviceId !== deviceId);
          const messagesBySession = Object.fromEntries(
            Object.entries(state.messagesBySession).filter(
              ([key]) => !key.startsWith(`${deviceId}::`)
            )
          );
          const modelBySession = Object.fromEntries(
            Object.entries(state.modelBySession).filter(
              ([key]) => !key.startsWith(`${deviceId}::`)
            )
          );
          const tokenUsageBySession = Object.fromEntries(
            Object.entries(state.tokenUsageBySession).filter(
              ([key]) => !key.startsWith(`${deviceId}::`)
            )
          );
          const costUsdBySession = Object.fromEntries(
            Object.entries(state.costUsdBySession).filter(
              ([key]) => !key.startsWith(`${deviceId}::`)
            )
          );
          const composerPrefsBySession = Object.fromEntries(
            Object.entries(state.composerPrefsBySession).filter(
              ([key]) => !key.startsWith(`${deviceId}::`)
            )
          );
          const availableModelsByDevice = Object.fromEntries(
            Object.entries(state.availableModelsByDevice).filter(
              ([id]) => id !== deviceId
            )
          );
          const searchResults = state.searchResults.filter(
            (sessionHit) => sessionHit.deviceId !== deviceId
          );
          const searchTotalHits = searchResults.reduce(
            (count, sessionHit) => count + sessionHit.hitCount,
            0
          );

          return {
            devices,
            sessions,
            messagesBySession,
            modelBySession,
            tokenUsageBySession,
            costUsdBySession,
            composerPrefsBySession,
            availableModelsByDevice,
            searchResults,
            searchTotalHits,
            selectedSessionKey: pickSelectedSession(state.selectedSessionKey, sessions)
          };
        });
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      }
    },
    runChatSearch: async (query, deviceId) => {
      const trimmedQuery = query.trim();
      if (trimmedQuery.length === 0) {
        set({
          searchResults: [],
          searchTotalHits: 0,
          searchLoading: false,
          searchError: null
        });
        return;
      }

      scheduleBackgroundSearchHydration(get().sessions);

      const requestId = activeSearchRequestId + 1;
      activeSearchRequestId = requestId;
      set({
        searchLoading: true,
        searchError: null
      });

      const request = {
        query: trimmedQuery,
        ...(deviceId ? { deviceId } : {}),
        threshold: SEARCH_SIMILARITY_THRESHOLD,
        maxSessions: SEARCH_MAX_SESSIONS
      };

      try {
        const immediate = await searchQuery(request);
        if (requestId !== activeSearchRequestId) {
          return;
        }
        set({
          searchResults: immediate.sessionHits,
          searchTotalHits: immediate.totalHits,
          searchLoading: false,
          searchError: null
        });
      } catch (error) {
        if (requestId !== activeSearchRequestId) {
          return;
        }
        set({
          searchLoading: false,
          searchError: toErrorMessage(error)
        });
        return;
      }

      void (async () => {
        const hydrationPromise = searchHydrationPromise;
        if (!hydrationPromise) {
          return;
        }
        await hydrationPromise;
        if (requestId !== activeSearchRequestId) {
          return;
        }

        try {
          const hydrated = await searchQuery(request);
          if (requestId !== activeSearchRequestId) {
            return;
          }

          set({
            searchResults: hydrated.sessionHits,
            searchTotalHits: hydrated.totalHits,
            searchError: null
          });
        } catch {
          // Keep immediate search results if hydration rerun fails.
        }
      })();
    },
    clearChatSearch: () => {
      activeSearchRequestId += 1;
      set({
        searchResults: [],
        searchTotalHits: 0,
        searchLoading: false,
        searchError: null
      });
    },
    clearError: () => {
      set({ globalError: null });
    }
  };
});

export const shutdownRpcClients = (): void => {
  shutdownSearchHydrationWorkerCallback?.();
  setNotificationSink(null);
  closeAllClients();
};

export const __TEST_ONLY__ = {
  upsertMessage,
  mergeThreadMessages,
  hasAcknowledgedEquivalent,
  toComposerPreference,
  upsertComposerPreference,
  computeSessionCostUsd,
  makeUsageDeltaEventKey,
  accumulateSessionCostFromLast
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const directMessage = record.message;
    if (typeof directMessage === "string" && directMessage.trim().length > 0) {
      return directMessage;
    }

    const cause = record.cause;
    if (typeof cause === "string" && cause.trim().length > 0) {
      return cause;
    }
    if (typeof cause === "object" && cause !== null) {
      const causeRecord = cause as Record<string, unknown>;
      const nestedMessage = causeRecord.message;
      if (typeof nestedMessage === "string" && nestedMessage.trim().length > 0) {
        return nestedMessage;
      }
    }

    try {
      const serialized = JSON.stringify(record);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // Ignore serialization errors and use fallback below.
    }
  }

  return "Unknown error";
};
