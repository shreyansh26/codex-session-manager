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
  ThreadHydrationState,
  ThreadPayload,
  ThreadRolloutPayload,
  TokenUsageBreakdown,
  ThreadTokenUsageState
} from "../domain/types";
import {
  closeAllClients,
  closeDeviceClient,
  findLatestRolloutPathForThread,
  listDirectories,
  listModels,
  listThreads,
  readThreadUsageFromRollout,
  readRolloutTimelineMessages,
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
import {
  sortMessagesAscending,
  toolCallCompletenessScore
} from "../services/messageChronology";
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
import type {
  ThreadReadWorkerRequest,
  ThreadReadWorkerResponse
} from "../workers/threadReadProtocol";
import { mergeSessions } from "./sessionMerge";

interface AppStore {
  loading: boolean;
  devices: DeviceRecord[];
  sessions: SessionSummary[];
  selectedSessionKey: string | null;
  messagesBySession: Record<string, ChatMessage[]>;
  threadHydrationBySession: Record<string, ThreadHydrationState>;
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
    options?: {
      preserveSummary?: boolean;
      skipMessages?: boolean;
      hydrateRollout?: boolean;
    }
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
const SERVER_DUPLICATE_WINDOW_MS = 10_000;
const SEARCH_SIMILARITY_THRESHOLD = 0.9;
const SEARCH_MAX_SESSIONS = 10;
const BACKGROUND_SEARCH_HYDRATION_DELAY_MS = 30;
const BACKGROUND_SEARCH_HYDRATION_START_DELAY_MS = 1_500;
const SEARCH_INDEX_FLUSH_DELAY_MS = 150;

const DEFAULT_THREAD_HYDRATION_STATE: ThreadHydrationState = {
  baseLoading: false,
  baseLoaded: false,
  toolHistoryLoading: false
};

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
  const normalizedIncoming = ensureTimelineOrder(existing, incoming);
  const existingIndex = existing.findIndex((entry) =>
    isSameLogicalMessage(entry, normalizedIncoming) ||
    hasAcknowledgedEquivalent(entry, normalizedIncoming) ||
    isEquivalentServerMessage(entry, normalizedIncoming)
  );
  if (existingIndex === -1) {
    return dedupeEquivalentServerMessages([...existing, normalizedIncoming]);
  }

  const current = existing[existingIndex];
  const merged = mergeStoredMessage(current, normalizedIncoming);

  const next = [...existing];
  next[existingIndex] = merged;
  return dedupeEquivalentServerMessages(next);
};

const mergeStoredMessage = (
  current: ChatMessage,
  incoming: ChatMessage
): ChatMessage => ({
  ...current,
  ...incoming,
  content: mergeMessageContent(current, incoming),
  createdAt: pickMergedTimestamp(current, incoming),
  timelineOrder: pickMergedTimelineOrder(current, incoming),
  chronologySource: pickMergedChronologySource(current, incoming),
  toolCall: mergeToolCalls(current.toolCall, incoming.toolCall)
});

const ensureTimelineOrder = (
  existing: ChatMessage[],
  incoming: ChatMessage
): ChatMessage =>
  typeof incoming.timelineOrder === "number"
    ? incoming
    : {
        ...incoming,
        timelineOrder: nextTimelineOrder(existing)
      };

const nextTimelineOrder = (messages: ChatMessage[]): number =>
  messages.reduce((maxOrder, message, index) => {
    const candidate =
      typeof message.timelineOrder === "number" ? message.timelineOrder : index;
    return Math.max(maxOrder, candidate);
  }, -1) + 1;

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

const toolCallSignature = (message: ChatMessage): string =>
  [
    message.toolCall?.name?.trim() ?? "",
    message.toolCall?.input?.trim() ?? "",
    message.toolCall?.output?.trim() ?? "",
    message.toolCall?.status ?? ""
  ].join("|");

const messageIdentityKey = (message: ChatMessage): string =>
  [
    message.id,
    message.role,
    message.eventType ?? "",
    ...(message.eventType === "tool_call" ? [message.createdAt] : [])
  ].join("::");

const shouldPreserveEarliestUserTimestamp = (
  current: ChatMessage,
  incoming: ChatMessage
): boolean =>
  current.role === "user" &&
  incoming.role === "user" &&
  normalizeMessageText(current.content) === normalizeMessageText(incoming.content) &&
  imageSignature(current) === imageSignature(incoming) &&
  !current.toolCall &&
  !incoming.toolCall;

const isCompactedRolloutHistoryMessage = (message: ChatMessage): boolean =>
  message.eventType !== "tool_call" &&
  (message.chronologySource === "rollout" || message.id.startsWith("message-"));

const chronologyRank = (
  source: ChatMessage["chronologySource"]
): number => {
  switch (source) {
    case "rollout":
      return 3;
    case "turn":
      return 2;
    case "live":
      return 1;
    case "flat_fallback":
      return 0;
    default:
      return -1;
  }
};

const isAuthoritativeChronologySource = (
  source: ChatMessage["chronologySource"]
): boolean => source === "turn" || source === "rollout";

const shouldPromoteIncomingChronology = (
  current: ChatMessage,
  incoming: ChatMessage
): boolean =>
  current.chronologySource === "flat_fallback" &&
  isAuthoritativeChronologySource(incoming.chronologySource);

const shouldPreserveCurrentChronology = (
  current: ChatMessage,
  incoming: ChatMessage
): boolean =>
  isAuthoritativeChronologySource(current.chronologySource) &&
  incoming.chronologySource === "flat_fallback";

const pickMergedChronologySource = (
  current: ChatMessage,
  incoming: ChatMessage
): ChatMessage["chronologySource"] =>
  chronologyRank(incoming.chronologySource) >= chronologyRank(current.chronologySource)
    ? incoming.chronologySource ?? current.chronologySource
    : current.chronologySource;

const isRestampedHistoryTwinCandidate = (
  current: ChatMessage,
  incoming: ChatMessage
): boolean => {
  if (isOptimisticMessage(current) || isOptimisticMessage(incoming)) {
    return false;
  }

  if (
    current.role !== incoming.role ||
    (current.eventType ?? "") !== (incoming.eventType ?? "")
  ) {
    return false;
  }

  if (current.eventType === "tool_call" || incoming.eventType === "tool_call") {
    return false;
  }

  if (current.id === incoming.id) {
    return false;
  }

  const sameContent =
    normalizeMessageText(current.content) === normalizeMessageText(incoming.content);
  const sameImages = imageSignature(current) === imageSignature(incoming);
  const sameToolCall = toolCallSignature(current) === toolCallSignature(incoming);
  if (!sameContent || !sameImages || !sameToolCall) {
    return false;
  }

  return (
    isCompactedRolloutHistoryMessage(current) !==
    isCompactedRolloutHistoryMessage(incoming)
  );
};

const mergeToolCalls = (
  current: ChatMessage["toolCall"],
  incoming: ChatMessage["toolCall"]
): ChatMessage["toolCall"] => {
  if (!current) {
    return incoming;
  }
  if (!incoming) {
    return current;
  }

  return {
    name: choosePreferredToolName(current.name, incoming.name),
    input:
      preferLongerField(current.input, incoming.input) ??
      incoming.input ??
      current.input,
    output:
      preferLongerField(current.output, incoming.output) ??
      incoming.output ??
      current.output,
    status: incoming.status ?? current.status
  };
};

const choosePreferredToolName = (current: string, incoming: string): string => {
  const currentGeneric = isGenericToolName(current);
  const incomingGeneric = isGenericToolName(incoming);
  if (!currentGeneric && incomingGeneric) {
    return current;
  }
  if (currentGeneric && !incomingGeneric) {
    return incoming;
  }
  return incoming.trim().length >= current.trim().length ? incoming : current;
};

const isGenericToolName = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "tool" ||
    normalized === "function_call" ||
    normalized === "function_call_output" ||
    normalized === "custom_tool_call" ||
    normalized === "custom_tool_call_output" ||
    normalized === "tool_call" ||
    normalized === "tool_call_output"
  );
};

const preferLongerField = (
  current: string | undefined,
  incoming: string | undefined
): string | undefined => {
  if (!current) {
    return incoming;
  }
  if (!incoming) {
    return current;
  }
  return incoming.length >= current.length ? incoming : current;
};

const buildServerChatOrdinalLookup = (
  messages: ChatMessage[]
): Map<ChatMessage, number> => {
  const ordered = [...messages].sort(sortMessagesAscending);
  const lookup = new Map<ChatMessage, number>();
  let ordinal = 0;
  for (const message of ordered) {
    if (message.eventType === "tool_call" || isOptimisticMessage(message)) {
      continue;
    }
    lookup.set(message, ordinal);
    ordinal += 1;
  }
  return lookup;
};

const findRestampedHistoryTwin = (
  existing: ChatMessage[],
  incoming: ChatMessage,
  incomingChatOrdinal: number | undefined
): ChatMessage | undefined => {
  if (typeof incomingChatOrdinal !== "number") {
    return undefined;
  }

  const orderedExisting = [...existing].sort(sortMessagesAscending);
  const existingChatOrdinals = buildServerChatOrdinalLookup(orderedExisting);
  const candidates = orderedExisting.filter((entry) =>
    isRestampedHistoryTwinCandidate(entry, incoming)
  );
  if (candidates.length === 0) {
    return undefined;
  }

  const sameOrdinal = candidates.find(
    (entry) => existingChatOrdinals.get(entry) === incomingChatOrdinal
  );
  if (sameOrdinal) {
    return sameOrdinal;
  }

  return candidates.length === 1 ? candidates[0] : undefined;
};

const mergeRestampedHistoryTwin = (
  current: ChatMessage,
  incoming: ChatMessage
): ChatMessage => {
  const merged = mergeStoredMessage(current, incoming);
  const preserveTimestampFrom =
    isCompactedRolloutHistoryMessage(current) && !isCompactedRolloutHistoryMessage(incoming)
      ? current
      : !isCompactedRolloutHistoryMessage(current) &&
          isCompactedRolloutHistoryMessage(incoming)
        ? incoming
        : merged;
  const preserveIdFrom =
    isCompactedRolloutHistoryMessage(current) && !isCompactedRolloutHistoryMessage(incoming)
      ? incoming
      : !isCompactedRolloutHistoryMessage(current) &&
          isCompactedRolloutHistoryMessage(incoming)
        ? current
        : merged;

  return {
    ...merged,
    id: preserveIdFrom.id,
    createdAt: preserveTimestampFrom.createdAt
  };
};

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

  if (current.eventType === "tool_call" || incoming.eventType === "tool_call") {
    return false;
  }

  const sameContent =
    normalizeMessageText(current.content) === normalizeMessageText(incoming.content);
  const sameImages = imageSignature(current) === imageSignature(incoming);
  const sameToolCall = toolCallSignature(current) === toolCallSignature(incoming);
  if (!sameContent || !sameImages || !sameToolCall) {
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

  if (current.eventType === "tool_call" && incoming.eventType === "tool_call") {
    return isLikelySameToolCall(current, incoming);
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

const normalizeToolField = (value: string | undefined): string =>
  normalizeMessageText(value ?? "");

const areCompatibleToolFields = (
  current: string | undefined,
  incoming: string | undefined
): boolean => {
  const currentNormalized = normalizeToolField(current);
  const incomingNormalized = normalizeToolField(incoming);
  if (currentNormalized.length === 0 || incomingNormalized.length === 0) {
    return true;
  }

  return (
    currentNormalized === incomingNormalized ||
    currentNormalized.includes(incomingNormalized) ||
    incomingNormalized.includes(currentNormalized)
  );
};

const isTerminalToolMessage = (message: ChatMessage): boolean =>
  message.toolCall?.status === "completed" ||
  message.toolCall?.status === "failed" ||
  Boolean(message.toolCall?.output?.trim().length);

const isLikelySameToolCall = (
  current: ChatMessage,
  incoming: ChatMessage
): boolean => {
  if (!current.toolCall || !incoming.toolCall) {
    return current.createdAt === incoming.createdAt;
  }

  const currentName = current.toolCall.name.trim();
  const incomingName = incoming.toolCall.name.trim();
  if (
    currentName.length > 0 &&
    incomingName.length > 0 &&
    !isGenericToolName(currentName) &&
    !isGenericToolName(incomingName) &&
    currentName !== incomingName
  ) {
    return false;
  }

  if (
    !areCompatibleToolFields(current.toolCall.input, incoming.toolCall.input) ||
    !areCompatibleToolFields(current.toolCall.output, incoming.toolCall.output)
  ) {
    return false;
  }

  const currentMs = Date.parse(current.createdAt);
  const incomingMs = Date.parse(incoming.createdAt);
  if (Number.isNaN(currentMs) || Number.isNaN(incomingMs)) {
    return true;
  }

  const currentTerminal = isTerminalToolMessage(current);
  const incomingTerminal = isTerminalToolMessage(incoming);
  if (currentTerminal && !incomingTerminal) {
    return incomingMs < currentMs || incomingMs - currentMs <= STREAMING_MERGE_WINDOW_MS;
  }

  if (!currentTerminal && incomingTerminal) {
    return true;
  }

  if (!currentTerminal && !incomingTerminal) {
    return Math.abs(currentMs - incomingMs) <= STREAMING_MERGE_WINDOW_MS;
  }

  return areServerTimestampsClose(current.createdAt, incoming.createdAt);
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

const pickEarliestTimestamp = (a: string, b: string): string => {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);

  if (Number.isNaN(aMs)) {
    return b;
  }
  if (Number.isNaN(bMs)) {
    return a;
  }
  return aMs <= bMs ? a : b;
};

const pickMergedTimestamp = (
  current: ChatMessage,
  incoming: ChatMessage
): string => {
  if (shouldPromoteIncomingChronology(current, incoming)) {
    return incoming.createdAt;
  }
  if (shouldPreserveCurrentChronology(current, incoming)) {
    return current.createdAt;
  }
  if (shouldPreserveCurrentTimestamp(current, incoming)) {
    return current.createdAt;
  }

  if (
    hasAcknowledgedEquivalent(current, incoming) ||
    shouldPreserveEarliestUserTimestamp(current, incoming)
  ) {
    return pickEarliestTimestamp(current.createdAt, incoming.createdAt);
  }

  return pickLatestTimestamp(current.createdAt, incoming.createdAt);
};

const pickMergedTimelineOrder = (
  current: ChatMessage,
  incoming: ChatMessage
): number | undefined => {
  if (shouldPromoteIncomingChronology(current, incoming)) {
    return incoming.timelineOrder ?? current.timelineOrder;
  }
  if (shouldPreserveCurrentChronology(current, incoming)) {
    return current.timelineOrder ?? incoming.timelineOrder;
  }
  return typeof current.timelineOrder === "number"
    ? current.timelineOrder
    : incoming.timelineOrder;
};

const shouldPreserveCurrentTimestamp = (
  current: ChatMessage,
  incoming: ChatMessage
): boolean =>
  current.id === incoming.id &&
  current.role === incoming.role &&
  (current.eventType ?? "") === (incoming.eventType ?? "");

const normalizeLiveNotificationMessage = (
  existing: ChatMessage[],
  incoming: ChatMessage
): ChatMessage => {
  if (incoming.role === "user") {
    return incoming;
  }

  const latest = existing.at(-1);
  if (!latest) {
    return incoming;
  }

  const latestMs = Date.parse(latest.createdAt);
  const incomingMs = Date.parse(incoming.createdAt);
  if (!Number.isFinite(latestMs) || !Number.isFinite(incomingMs) || incomingMs > latestMs) {
    return incoming;
  }

  return {
    ...incoming,
    createdAt: new Date(latestMs + 1).toISOString()
  };
};

const preferCanonicalMessage = (
  current: ChatMessage,
  incoming: ChatMessage
): ChatMessage => {
  const preserveTimelineOrder = (winner: ChatMessage): ChatMessage => ({
    ...winner,
    ...(typeof pickMergedTimelineOrder(current, incoming) === "number"
      ? { timelineOrder: pickMergedTimelineOrder(current, incoming) }
      : {}),
    ...(pickMergedChronologySource(current, incoming)
      ? { chronologySource: pickMergedChronologySource(current, incoming) }
      : {})
  });
  const currentReasoning = current.eventType === "reasoning";
  const incomingReasoning = incoming.eventType === "reasoning";
  if (currentReasoning !== incomingReasoning) {
    return preserveTimelineOrder(incomingReasoning ? current : incoming);
  }

  const currentImages = current.images?.length ?? 0;
  const incomingImages = incoming.images?.length ?? 0;
  if (incomingImages !== currentImages) {
    return preserveTimelineOrder(incomingImages > currentImages ? incoming : current);
  }

  const currentToolRichness = toolCallCompletenessScore(current);
  const incomingToolRichness = toolCallCompletenessScore(incoming);
  if (incomingToolRichness !== currentToolRichness) {
    return preserveTimelineOrder(
      incomingToolRichness > currentToolRichness ? incoming : current
    );
  }

  if (shouldPreserveEarliestUserTimestamp(current, incoming)) {
    return preserveTimelineOrder(
      pickEarliestTimestamp(current.createdAt, incoming.createdAt) === incoming.createdAt
        ? incoming
        : current
    );
  }

  return preserveTimelineOrder(
    pickLatestTimestamp(current.createdAt, incoming.createdAt) === incoming.createdAt
      ? incoming
      : current
  );
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

const dedupeMessagesByIdentity = (messages: ChatMessage[]): ChatMessage[] => {
  const mergedByIdentity = new Map<string, ChatMessage>();
  const ordered = [...messages].sort(sortMessagesAscending);
  for (const message of ordered) {
    const identity = messageIdentityKey(message);
    const existing = mergedByIdentity.get(identity);
    mergedByIdentity.set(
      identity,
      existing ? mergeStoredMessage(existing, message) : message
    );
  }
  return [...mergedByIdentity.values()].sort(sortMessagesAscending);
};

const normalizeSnapshotMessages = (messages: ChatMessage[]): ChatMessage[] =>
  dedupeEquivalentServerMessages(dedupeMessagesByIdentity(messages));

const hasMatchingMessage = (
  messages: ChatMessage[],
  candidate: ChatMessage
): boolean =>
  messages.some(
    (entry) =>
      isSameLogicalMessage(entry, candidate) ||
      hasAcknowledgedEquivalent(candidate, entry) ||
      isEquivalentServerMessage(entry, candidate)
  );

const pendingOptimisticUserMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.filter((message) => {
    if (!isOptimisticMessage(message) || message.role !== "user") {
      return false;
    }

    const createdAtMs = Date.parse(message.createdAt);
    if (Number.isNaN(createdAtMs)) {
      return false;
    }

    return Date.now() - createdAtMs <= PENDING_OPTIMISTIC_RETAIN_MS;
  });

const mergeSnapshotAcknowledgements = (
  snapshotMessages: ChatMessage[],
  existing: ChatMessage[]
): {
  snapshotMessages: ChatMessage[];
  retainedOptimistic: ChatMessage[];
} => {
  const pendingOptimistic = pendingOptimisticUserMessages(existing);
  if (pendingOptimistic.length === 0) {
    return {
      snapshotMessages,
      retainedOptimistic: []
    };
  }

  const matchedOptimisticIds = new Set<string>();
  const mergedSnapshotMessages = snapshotMessages.map((message) => {
    const optimisticMatch = pendingOptimistic.find((optimistic) =>
      hasAcknowledgedEquivalent(optimistic, message)
    );
    if (!optimisticMatch) {
      return message;
    }

    matchedOptimisticIds.add(optimisticMatch.id);
    return mergeStoredMessage(optimisticMatch, message);
  });

  return {
    snapshotMessages: mergedSnapshotMessages,
    retainedOptimistic: pendingOptimistic.filter(
      (message) => !matchedOptimisticIds.has(message.id)
    )
  };
};

const mergeThreadMessages = (
  existing: ChatMessage[],
  incoming: ChatMessage[]
): ChatMessage[] => {
  const normalizedSnapshotMessages = normalizeSnapshotMessages(incoming);
  const { snapshotMessages, retainedOptimistic } = mergeSnapshotAcknowledgements(
    normalizedSnapshotMessages,
    existing
  );
  return dedupeEquivalentServerMessages([
    ...snapshotMessages,
    ...retainedOptimistic
  ]);
};

const mergeSnapshotMessagesIntoExisting = (
  existing: ChatMessage[],
  snapshotMessages: ChatMessage[]
): ChatMessage[] => {
  const snapshotChatOrdinals = buildServerChatOrdinalLookup(snapshotMessages);

  return snapshotMessages.map((message) => {
    const exact = existing.find(
      (entry) => messageIdentityKey(entry) === messageIdentityKey(message)
    );
    if (exact) {
      return mergeStoredMessage(exact, message);
    }

    const historyTwin = findRestampedHistoryTwin(
      existing,
      message,
      snapshotChatOrdinals.get(message)
    );
    if (historyTwin) {
      return mergeRestampedHistoryTwin(historyTwin, message);
    }

    const logicalMatch = existing.find(
      (entry) =>
        isSameLogicalMessage(entry, message) || hasAcknowledgedEquivalent(entry, message)
    );
    if (logicalMatch) {
      return mergeStoredMessage(logicalMatch, message);
    }

    return message;
  });
};

const mergeSnapshotMessages = (
  existing: ChatMessage[],
  snapshot: ChatMessage[]
): ChatMessage[] => {
  const normalizedSnapshotMessages = normalizeSnapshotMessages(snapshot);
  const { snapshotMessages: acknowledgedSnapshotMessages, retainedOptimistic } =
    mergeSnapshotAcknowledgements(
      normalizedSnapshotMessages,
      existing
    );
  const snapshotMessages = mergeSnapshotMessagesIntoExisting(
    existing,
    acknowledgedSnapshotMessages
  );
  const retainedToolCalls = existing.filter(
    (message) =>
      message.eventType === "tool_call" && !hasMatchingMessage(snapshotMessages, message)
  );

  return dedupeEquivalentServerMessages([
    ...snapshotMessages,
    ...retainedToolCalls,
    ...retainedOptimistic
  ]);
};

const mergeRolloutEnrichmentMessages = (
  existing: ChatMessage[],
  enrichment: ChatMessage[]
): ChatMessage[] => {
  const normalizedExisting = dedupeMessagesByIdentity(existing);
  const mergedByIdentity = new Map<string, ChatMessage>();
  for (const message of normalizedExisting) {
    mergedByIdentity.set(messageIdentityKey(message), message);
  }

  const normalizedEnrichment = normalizeSnapshotMessages(enrichment);
  const enrichmentChatOrdinals = buildServerChatOrdinalLookup(normalizedEnrichment);

  for (const message of normalizedEnrichment) {
    const identity = messageIdentityKey(message);
    const exact = mergedByIdentity.get(identity);
    if (exact) {
      mergedByIdentity.set(identity, mergeStoredMessage(exact, message));
      continue;
    }

    const historyTwin = findRestampedHistoryTwin(
      [...mergedByIdentity.values()],
      message,
      enrichmentChatOrdinals.get(message)
    );
    if (historyTwin) {
      mergedByIdentity.set(
        messageIdentityKey(historyTwin),
        mergeRestampedHistoryTwin(historyTwin, message)
      );
      continue;
    }

    const logicalMatch = [...mergedByIdentity.values()].find((entry) =>
      isSameLogicalMessage(entry, message) ||
      hasAcknowledgedEquivalent(entry, message) ||
      isEquivalentServerMessage(entry, message)
    );

    if (!logicalMatch) {
      mergedByIdentity.set(identity, message);
      continue;
    }

    mergedByIdentity.set(
      messageIdentityKey(logicalMatch),
      mergeStoredMessage(logicalMatch, message)
    );
  }

  return dedupeEquivalentServerMessages([...mergedByIdentity.values()]);
};

const sameThreadHydrationState = (
  current: ThreadHydrationState,
  next: ThreadHydrationState
): boolean =>
  current.baseLoading === next.baseLoading &&
  current.baseLoaded === next.baseLoaded &&
  current.toolHistoryLoading === next.toolHistoryLoading &&
  current.toolHistoryRevision === next.toolHistoryRevision;

const updateThreadHydrationState = (
  current: Record<string, ThreadHydrationState>,
  sessionKey: string,
  patch: Partial<ThreadHydrationState>
): Record<string, ThreadHydrationState> => {
  const previous = current[sessionKey] ?? DEFAULT_THREAD_HYDRATION_STATE;
  const next: ThreadHydrationState = {
    ...previous,
    ...patch
  };
  if (sameThreadHydrationState(previous, next)) {
    return current;
  }

  return {
    ...current,
    [sessionKey]: next
  };
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

let shutdownWorkersCallback: (() => void) | null = null;

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
  const activeSendSessionKeys = new Set<string>();
  const activeThreadBaseLoads = new Set<string>();
  const activeThreadRolloutLoads = new Set<string>();
  let searchHydrationStartTimer: ReturnType<typeof setTimeout> | null = null;
  let searchIndexFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const queuedSearchIndexPayloads = new Map<string, SearchIndexThreadPayload>();
  let searchHydrationWorker: Worker | null = null;
  let searchHydrationWorkerUnavailable = false;
  let nextSearchHydrationWorkerRequestId = 1;
  let threadReadWorker: Worker | null = null;
  let threadReadWorkerUnavailable = false;
  let nextThreadReadWorkerRequestId = 1;
  let nextThreadBaseLoadToken = 1;
  let nextThreadRolloutLoadToken = 1;
  const latestThreadBaseRequestIdBySession = new Map<string, number>();
  const latestThreadRolloutRequestIdBySession = new Map<string, number>();
  const pendingSearchHydrationWorkerRequests = new Map<
    number,
    {
      sessionKey: string;
      resolve: (payload: SearchIndexThreadPayload) => void;
      reject: (error: Error) => void;
    }
  >();
  const pendingThreadBaseWorkerRequests = new Map<
    number,
    {
      sessionKey: string;
      resolve: (payload: ThreadPayload) => void;
      reject: (error: Error) => void;
    }
  >();
  const pendingThreadRolloutWorkerRequests = new Map<
    number,
    {
      sessionKey: string;
      revision?: string;
      resolve: (payload: ThreadRolloutPayload) => void;
      reject: (error: Error) => void;
    }
  >();

  const hasInteractiveThreadWork = (): boolean =>
    activeThreadBaseLoads.size > 0 ||
    activeThreadRolloutLoads.size > 0 ||
    activeSendSessionKeys.size > 0;

  const shouldPublishSearchHydrationProgress = (): boolean => {
    const state = get();
    return state.searchLoading || state.searchResults.length > 0 || state.searchTotalHits > 0;
  };

  const rejectPendingSearchHydrationWorkerRequests = (error: Error): void => {
    for (const pending of pendingSearchHydrationWorkerRequests.values()) {
      pending.reject(error);
    }
    pendingSearchHydrationWorkerRequests.clear();
  };

  const rejectPendingThreadReadWorkerRequests = (error: Error): void => {
    for (const pending of pendingThreadBaseWorkerRequests.values()) {
      pending.reject(error);
    }
    pendingThreadBaseWorkerRequests.clear();
    for (const pending of pendingThreadRolloutWorkerRequests.values()) {
      pending.reject(error);
    }
    pendingThreadRolloutWorkerRequests.clear();
  };

  const handleSearchHydrationWorkerResponse = (
    response: SearchHydrationWorkerResponse
  ): void => {
    if (response.type === "hydrated-session") {
      const pending = pendingSearchHydrationWorkerRequests.get(response.requestId);
      if (!pending) {
        return;
      }
      pendingSearchHydrationWorkerRequests.delete(response.requestId);
      pending.resolve(response.payload);
      return;
    }

    const pendingHydration = pendingSearchHydrationWorkerRequests.get(response.requestId);
    if (pendingHydration) {
      pendingSearchHydrationWorkerRequests.delete(response.requestId);
      pendingHydration.reject(
        new Error(
          response.error || `Failed to hydrate search session ${response.sessionKey}.`
        )
      );
    }
  };

  const handleThreadReadWorkerResponse = (
    response: ThreadReadWorkerResponse
  ): void => {
    if (response.type === "thread-base-read") {
      const pending = pendingThreadBaseWorkerRequests.get(response.requestId);
      if (!pending) {
        return;
      }
      pendingThreadBaseWorkerRequests.delete(response.requestId);
      pending.resolve(response.payload);
      return;
    }

    if (response.type === "thread-rollout-read") {
      const pending = pendingThreadRolloutWorkerRequests.get(response.requestId);
      if (!pending) {
        return;
      }
      pendingThreadRolloutWorkerRequests.delete(response.requestId);
      pending.resolve(response.payload);
      return;
    }

    const pendingBase = pendingThreadBaseWorkerRequests.get(response.requestId);
    if (pendingBase) {
      pendingThreadBaseWorkerRequests.delete(response.requestId);
      pendingBase.reject(
        new Error(response.error || `Failed to read thread ${response.sessionKey}.`)
      );
      return;
    }

    const pendingRollout = pendingThreadRolloutWorkerRequests.get(response.requestId);
    if (!pendingRollout) {
      return;
    }
    pendingThreadRolloutWorkerRequests.delete(response.requestId);
    pendingRollout.reject(
      new Error(response.error || `Failed to hydrate thread ${response.sessionKey}.`)
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

  const ensureThreadReadWorker = (): Worker | null => {
    if (threadReadWorkerUnavailable) {
      return null;
    }
    if (threadReadWorker) {
      return threadReadWorker;
    }
    if (typeof Worker !== "function") {
      threadReadWorkerUnavailable = true;
      return null;
    }

    try {
      threadReadWorker = new Worker(new URL("../workers/threadReadWorker.ts", import.meta.url), {
        type: "module"
      });
      threadReadWorker.onmessage = (event: MessageEvent<ThreadReadWorkerResponse>) => {
        handleThreadReadWorkerResponse(event.data);
      };
      threadReadWorker.onerror = (event): void => {
        const message = event.message?.trim() || "Thread read worker crashed unexpectedly.";
        threadReadWorkerUnavailable = true;
        rejectPendingThreadReadWorkerRequests(new Error(message));
        threadReadWorker?.terminate();
        threadReadWorker = null;
      };
      return threadReadWorker;
    } catch {
      threadReadWorkerUnavailable = true;
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

  const requestThreadBaseReadFromWorker = async (
    device: DeviceRecord,
    threadId: string,
    skipMessages = false
  ): Promise<ThreadPayload | null> => {
    const worker = ensureThreadReadWorker();
    if (!worker) {
      return null;
    }

    const requestId = nextThreadReadWorkerRequestId;
    nextThreadReadWorkerRequestId += 1;
    const request: ThreadReadWorkerRequest = {
      type: "read-thread-base",
      requestId,
      device,
      threadId,
      ...(skipMessages ? { skipMessages: true } : {})
    };

    return new Promise<ThreadPayload>((resolve, reject) => {
      pendingThreadBaseWorkerRequests.set(requestId, {
        sessionKey: makeSessionKey(device.id, threadId),
        resolve,
        reject
      });
      try {
        worker.postMessage(request);
      } catch (error) {
        pendingThreadBaseWorkerRequests.delete(requestId);
        reject(
          error instanceof Error
            ? error
            : new Error("Failed to post thread base read request to worker.")
        );
      }
    });
  };

  const requestThreadRolloutFromWorker = async (
    device: DeviceRecord,
    threadId: string,
    rolloutPath: string,
    revision?: string
  ): Promise<ThreadRolloutPayload | null> => {
    const worker = ensureThreadReadWorker();
    if (!worker) {
      return null;
    }

    const requestId = nextThreadReadWorkerRequestId;
    nextThreadReadWorkerRequestId += 1;
    const request: ThreadReadWorkerRequest = {
      type: "read-thread-rollout",
      requestId,
      device,
      threadId,
      rolloutPath,
      ...(revision ? { revision } : {})
    };

    return new Promise<ThreadRolloutPayload>((resolve, reject) => {
      pendingThreadRolloutWorkerRequests.set(requestId, {
        sessionKey: makeSessionKey(device.id, threadId),
        ...(revision ? { revision } : {}),
        resolve,
        reject
      });
      try {
        worker.postMessage(request);
      } catch (error) {
        pendingThreadRolloutWorkerRequests.delete(requestId);
        reject(
          error instanceof Error
            ? error
            : new Error("Failed to post thread rollout request to worker.")
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

  const closeThreadReadWorkerDevice = (deviceId: string): void => {
    if (!threadReadWorker) {
      return;
    }
    const request: ThreadReadWorkerRequest = {
      type: "close-device",
      deviceId
    };
    try {
      threadReadWorker.postMessage(request);
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
    rejectPendingSearchHydrationWorkerRequests(new Error("Search hydration worker was shut down."));
    searchHydrationWorker.terminate();
    searchHydrationWorker = null;
  };

  const shutdownThreadReadWorker = (): void => {
    if (!threadReadWorker) {
      return;
    }
    try {
      const request: ThreadReadWorkerRequest = { type: "shutdown" };
      threadReadWorker.postMessage(request);
    } catch {
      // Ignore shutdown message failures and terminate directly.
    }
    rejectPendingThreadReadWorkerRequests(new Error("Thread read worker was shut down."));
    threadReadWorker.terminate();
    threadReadWorker = null;
  };

  const hydrateSessionOnMainThread = async (
    device: DeviceRecord,
    session: SessionSummary
  ): Promise<SearchIndexThreadPayload> => {
    const payload = await readThread(device, session.threadId, {
      includeRolloutMessages: false
    });
    return toSearchIndexThreadPayload(payload.session, payload.messages);
  };

  const readThreadBaseOnMainThread = async (
    device: DeviceRecord,
    threadId: string,
    skipMessages = false
  ): Promise<ThreadPayload> =>
    readThread(device, threadId, {
      includeRolloutMessages: false,
      ...(skipMessages ? { skipMessages: true } : {})
    });

  const readThreadRolloutOnMainThread = async (
    device: DeviceRecord,
    threadId: string,
    rolloutPath: string,
    revision?: string
  ): Promise<ThreadRolloutPayload> => ({
    sessionKey: makeSessionKey(device.id, threadId),
    threadId,
    deviceId: device.id,
    messages: await readRolloutTimelineMessages(device, threadId, rolloutPath, revision),
    ...(revision ? { revision } : {}),
    rolloutPath
  });

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

  const shutdownWorkers = (): void => {
    if (searchHydrationStartTimer !== null) {
      clearTimeout(searchHydrationStartTimer);
      searchHydrationStartTimer = null;
    }
    if (searchIndexFlushTimer !== null) {
      clearTimeout(searchIndexFlushTimer);
      searchIndexFlushTimer = null;
    }
    queuedSearchIndexPayloads.clear();
    shutdownSearchHydrationWorker();
    shutdownThreadReadWorker();
  };

  shutdownWorkersCallback = shutdownWorkers;

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

  const clearQueuedSearchIndexPayloadsForDevice = (deviceId: string): void => {
    const prefix = `${deviceId}::`;
    for (const sessionKey of [...queuedSearchIndexPayloads.keys()]) {
      if (sessionKey.startsWith(prefix)) {
        queuedSearchIndexPayloads.delete(sessionKey);
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
    for (const [requestId, pending] of pendingThreadBaseWorkerRequests) {
      if (!pending.sessionKey.startsWith(prefix)) {
        continue;
      }
      pendingThreadBaseWorkerRequests.delete(requestId);
      pending.reject(new Error(`Device ${deviceId} disconnected during thread read.`));
    }
    for (const [requestId, pending] of pendingThreadRolloutWorkerRequests) {
      if (!pending.sessionKey.startsWith(prefix)) {
        continue;
      }
      pendingThreadRolloutWorkerRequests.delete(requestId);
      pending.reject(new Error(`Device ${deviceId} disconnected during thread read.`));
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

  const setThreadHydrationFlags = (
    sessionKey: string,
    patch: Partial<ThreadHydrationState>
  ): void => {
    set((state) => {
      const nextThreadHydrationBySession = updateThreadHydrationState(
        state.threadHydrationBySession,
        sessionKey,
        patch
      );
      if (nextThreadHydrationBySession === state.threadHydrationBySession) {
        return {};
      }

      return {
        threadHydrationBySession: nextThreadHydrationBySession
      };
    });
  };

  const flushQueuedSearchIndexPayloads = (): void => {
    if (searchIndexFlushTimer !== null) {
      clearTimeout(searchIndexFlushTimer);
      searchIndexFlushTimer = null;
    }

    if (queuedSearchIndexPayloads.size === 0) {
      return;
    }

    if (hasInteractiveThreadWork()) {
      searchIndexFlushTimer = setTimeout(
        flushQueuedSearchIndexPayloads,
        SEARCH_INDEX_FLUSH_DELAY_MS
      );
      return;
    }

    const nextEntry = queuedSearchIndexPayloads.entries().next().value as
      | [string, SearchIndexThreadPayload]
      | undefined;
    if (!nextEntry) {
      return;
    }

    const [sessionKey, payload] = nextEntry;
    queuedSearchIndexPayloads.delete(sessionKey);
    void searchIndexUpsertThread(payload)
      .catch(() => {
        // Keep search functional even if persistence/indexing fails on one update.
      })
      .finally(() => {
        if (queuedSearchIndexPayloads.size === 0) {
          searchIndexFlushTimer = null;
          return;
        }
        searchIndexFlushTimer = setTimeout(
          flushQueuedSearchIndexPayloads,
          SEARCH_INDEX_FLUSH_DELAY_MS
        );
      });
  };

  const queueThreadIntoSearchIndex = (
    session: SessionSummary,
    messages: ChatMessage[]
  ): void => {
    hydratedSearchSessions.add(session.key);
    const payload = toSearchIndexThreadPayload(session, messages);
    queuedSearchIndexPayloads.set(session.key, payload);
    if (searchIndexFlushTimer !== null) {
      return;
    }
    searchIndexFlushTimer = setTimeout(
      flushQueuedSearchIndexPayloads,
      SEARCH_INDEX_FLUSH_DELAY_MS
    );
  };

  const syncSearchHydrationProgress = (): void => {
    if (!shouldPublishSearchHydrationProgress()) {
      return;
    }
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
    if (hasInteractiveThreadWork()) {
      if (searchHydrationStartTimer === null) {
        searchHydrationStartTimer = setTimeout(() => {
          searchHydrationStartTimer = null;
          startBackgroundSearchHydration();
        }, BACKGROUND_SEARCH_HYDRATION_START_DELAY_MS);
      }
      return;
    }

    completedHydrations = 0;
    syncSearchHydrationProgress();

    searchHydrationPromise = (async () => {
      while (queuedSearchHydrationSessions.size > 0) {
        if (hasInteractiveThreadWork()) {
          break;
        }

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
        if (shouldPublishSearchHydrationProgress()) {
          set({
            searchHydrating: false,
            searchHydratedCount: 0,
            searchHydrationTotal: 0
          });
        }

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

    startBackgroundSearchHydration();
    if (shouldPublishSearchHydrationProgress()) {
      syncSearchHydrationProgress();
    }
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
          preserveSummary: true,
          hydrateRollout: false
        });
      }, delayMs);
    }

    const startedAt = Date.now();
    const tick = (): void => {
      void get().refreshThread(params.deviceId, params.threadId, {
        preserveSummary: true,
        hydrateRollout: false
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
      const existingModel = snapshot.modelBySession[params.sessionKey];
      const existingCost = snapshot.costUsdBySession[params.sessionKey];
      if (
        existingUsage &&
        existingUsage.threadId === params.threadId &&
        typeof existingModel === "string" &&
        existingModel.trim().length > 0 &&
        typeof existingCost === "number"
      ) {
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

  const hydrateSelectedThreadRollout = async (params: {
    device: DeviceRecord;
    sessionKey: string;
    threadId: string;
    rolloutPath: string;
    revision?: string;
  }): Promise<void> => {
    const requestToken = nextThreadRolloutLoadToken;
    nextThreadRolloutLoadToken += 1;
    latestThreadRolloutRequestIdBySession.set(params.sessionKey, requestToken);
    activeThreadRolloutLoads.add(params.sessionKey);
    setThreadHydrationFlags(params.sessionKey, { toolHistoryLoading: true });

    try {
      const payload =
        (await requestThreadRolloutFromWorker(
          params.device,
          params.threadId,
          params.rolloutPath,
          params.revision
        )) ??
        (await readThreadRolloutOnMainThread(
          params.device,
          params.threadId,
          params.rolloutPath,
          params.revision
        ));

      if (latestThreadRolloutRequestIdBySession.get(params.sessionKey) !== requestToken) {
        return;
      }
      if (get().selectedSessionKey !== params.sessionKey) {
        return;
      }

      set((state) => ({
        messagesBySession: {
          ...state.messagesBySession,
          [params.sessionKey]: mergeRolloutEnrichmentMessages(
            state.messagesBySession[params.sessionKey] ?? [],
            payload.messages
          )
        },
        threadHydrationBySession: updateThreadHydrationState(
          state.threadHydrationBySession,
          params.sessionKey,
          {
            toolHistoryLoading: false,
            toolHistoryRevision: payload.revision ?? params.revision
          }
        )
      }));
    } catch {
      if (latestThreadRolloutRequestIdBySession.get(params.sessionKey) === requestToken) {
        setThreadHydrationFlags(params.sessionKey, { toolHistoryLoading: false });
      }
    } finally {
      activeThreadRolloutLoads.delete(params.sessionKey);
      if (latestThreadRolloutRequestIdBySession.get(params.sessionKey) === requestToken) {
        latestThreadRolloutRequestIdBySession.delete(params.sessionKey);
        setThreadHydrationFlags(params.sessionKey, { toolHistoryLoading: false });
      }
      flushQueuedSearchIndexPayloads();
      startBackgroundSearchHydration();
    }
  };

  const refreshThreadBase = async (
    device: DeviceRecord,
    threadId: string,
    options?: { preserveSummary?: boolean; skipMessages?: boolean; hydrateRollout?: boolean }
  ): Promise<ThreadPayload> => {
    const sessionKey = makeSessionKey(device.id, threadId);
    const requestToken = nextThreadBaseLoadToken;
    nextThreadBaseLoadToken += 1;
    latestThreadBaseRequestIdBySession.set(sessionKey, requestToken);
    activeThreadBaseLoads.add(sessionKey);
    const existingMessages = get().messagesBySession[sessionKey] ?? [];
    const currentHydrationState =
      get().threadHydrationBySession[sessionKey] ?? DEFAULT_THREAD_HYDRATION_STATE;
    const shouldShowBaseLoading =
      !options?.skipMessages &&
      existingMessages.length === 0 &&
      !currentHydrationState.baseLoaded;

    setThreadHydrationFlags(sessionKey, {
      baseLoading: shouldShowBaseLoading,
      ...(options?.skipMessages
        ? {}
        : {
            toolHistoryLoading: false
          })
    });

    try {
      const payload =
        (await requestThreadBaseReadFromWorker(device, threadId, options?.skipMessages)) ??
        (await readThreadBaseOnMainThread(device, threadId, options?.skipMessages));

      if (latestThreadBaseRequestIdBySession.get(sessionKey) !== requestToken) {
        return payload;
      }

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
        const nextMessagesBySession = options?.skipMessages
          ? state.messagesBySession
          : {
              ...state.messagesBySession,
              [payload.session.key]: mergeSnapshotMessages(
                state.messagesBySession[payload.session.key] ?? [],
                payload.messages
              )
            };
        const nextThreadHydrationBySession = updateThreadHydrationState(
          state.threadHydrationBySession,
          payload.session.key,
          {
            baseLoading: false,
            baseLoaded:
              (state.messagesBySession[payload.session.key] ?? []).length > 0 ||
              !options?.skipMessages,
            toolHistoryLoading: false
          }
        );

        return {
          sessions: nextSessions,
          modelBySession: nextModelBySession,
          costUsdBySession: nextCostUsdBySession,
          messagesBySession: nextMessagesBySession,
          threadHydrationBySession: nextThreadHydrationBySession
        };
      });

      backfillUsageFromRollout({
        sessionKey: payload.session.key,
        deviceId: device.id,
        threadId
      });

      if (!options?.skipMessages) {
        const indexedMessages =
          get().messagesBySession[payload.session.key] ?? payload.messages;
        queueThreadIntoSearchIndex(payload.session, indexedMessages);
      }

      const rolloutPath =
        !options?.skipMessages && options?.hydrateRollout !== false
          ? payload.rolloutPath ?? (await findLatestRolloutPathForThread(device, threadId))
          : payload.rolloutPath;

      const shouldHydrateRollout =
        !options?.skipMessages &&
        options?.hydrateRollout !== false &&
        get().selectedSessionKey === payload.session.key &&
        get().threadHydrationBySession[payload.session.key]?.toolHistoryRevision !==
          payload.session.updatedAt &&
        typeof rolloutPath === "string" &&
        rolloutPath.trim().length > 0;

      if (shouldHydrateRollout) {
        void hydrateSelectedThreadRollout({
          device,
          sessionKey: payload.session.key,
          threadId,
          rolloutPath: rolloutPath ?? "",
          revision: payload.session.updatedAt
        });
      } else {
        setThreadHydrationFlags(payload.session.key, {
          toolHistoryLoading: false
        });
      }

      return payload;
    } finally {
      activeThreadBaseLoads.delete(sessionKey);
      if (latestThreadBaseRequestIdBySession.get(sessionKey) === requestToken) {
        latestThreadBaseRequestIdBySession.delete(sessionKey);
      }
      flushQueuedSearchIndexPayloads();
      startBackgroundSearchHydration();
    }
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
    if (get().selectedSessionKey !== sessionKey) {
      return;
    }
    const nowMs = Date.now();
    const lastRefreshMs = notificationRefreshAtMs.get(sessionKey) ?? 0;
    if (nowMs - lastRefreshMs < NOTIFICATION_REFRESH_MIN_INTERVAL_MS) {
      return;
    }
    notificationRefreshAtMs.set(sessionKey, nowMs);

    void get().refreshThread(deviceId, threadId, {
      preserveSummary: true,
      hydrateRollout: false
    });
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
      const next = upsertMessage(
        current,
        normalizeLiveNotificationMessage(current, parsed.message)
      );
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
    threadHydrationBySession: {},
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
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      } finally {
        set({ loading: false, initializing: false });
      }
    },
    selectSession: async (sessionKey) => {
      set({ selectedSessionKey: sessionKey });
      ensureComposerPreferenceForSession(sessionKey);
      setThreadHydrationFlags(sessionKey, {
        baseLoaded: (get().messagesBySession[sessionKey] ?? []).length > 0
      });
      const selected = get().sessions.find((session) => session.key === sessionKey);
      if (!selected) {
        return;
      }

      await get().refreshThread(selected.deviceId, selected.threadId, {
        preserveSummary: true,
        hydrateRollout: true
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
          void get().refreshThread(session.deviceId, session.threadId, {
            preserveSummary: true,
            hydrateRollout: true
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
        await refreshThreadBase(device, threadId, options);
      } catch (error) {
        setThreadHydrationFlags(makeSessionKey(deviceId, threadId), {
          baseLoading: false,
          toolHistoryLoading: false
        });
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
      const sessionKey = makeSessionKey(deviceId, started.threadId);

      set((state) => ({
        selectedSessionKey: sessionKey,
        composerPrefsBySession: upsertComposerPreference(
          state.composerPrefsBySession,
          sessionKey,
          started.model,
          undefined
        ),
        modelBySession: started.model
          ? {
              ...state.modelBySession,
              [sessionKey]: started.model
            }
          : state.modelBySession,
        costUsdBySession: started.model
          ? {
              ...state.costUsdBySession,
              [sessionKey]: computeSessionCostUsd(
                started.model,
                state.tokenUsageBySession[sessionKey]
              )
            }
          : state.costUsdBySession,
        globalError: null
      }));

      await get().refreshThread(deviceId, started.threadId, {
        hydrateRollout: true
      });

      return sessionKey;
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
      activeSendSessionKeys.add(session.key);

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
        } finally {
          activeSendSessionKeys.delete(session.key);
          flushQueuedSearchIndexPayloads();
          startBackgroundSearchHydration();
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
        clearQueuedSearchIndexPayloadsForDevice(deviceId);
        clearHydratedSearchSessionsForDevice(deviceId);
        rejectPendingSearchHydrationWorkerRequestsForDevice(deviceId);
        closeSearchHydrationWorkerDevice(deviceId);
        closeThreadReadWorkerDevice(deviceId);
        syncSearchHydrationProgress();
        const disconnected = await disconnectDevice(deviceId);
        closeDeviceClient(deviceId);
        set((state) => ({
          devices: upsertDevice(state.devices, disconnected),
          threadHydrationBySession: Object.fromEntries(
            Object.entries(state.threadHydrationBySession).filter(
              ([key]) => !key.startsWith(`${deviceId}::`)
            )
          )
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
        clearQueuedSearchIndexPayloadsForDevice(deviceId);
        rejectPendingSearchHydrationWorkerRequestsForDevice(deviceId);
        closeSearchHydrationWorkerDevice(deviceId);
        closeThreadReadWorkerDevice(deviceId);
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
          const threadHydrationBySession = Object.fromEntries(
            Object.entries(state.threadHydrationBySession).filter(
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
            threadHydrationBySession,
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
        searchHydrating: false,
        searchHydratedCount: 0,
        searchHydrationTotal: 0,
        searchError: null
      });
    },
    clearError: () => {
      set({ globalError: null });
    }
  };
});

export const shutdownRpcClients = (): void => {
  shutdownWorkersCallback?.();
  setNotificationSink(null);
  closeAllClients();
};

export const __TEST_ONLY__ = {
  upsertMessage,
  mergeThreadMessages,
  mergeSnapshotMessages,
  mergeRolloutEnrichmentMessages,
  normalizeLiveNotificationMessage,
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
