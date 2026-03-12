import { makeSessionKey } from "../domain/sessionKey";
import {
  normalizeCatalogModelId,
  resolveComposerModel,
  resolveSupportedModelId,
  resolveThinkingEffortForModel
} from "../domain/modelCatalog";
import type {
  ChatImageAttachment,
  ChatMessage,
  ChatRole,
  ComposerSubmission,
  DirectoryBrowseResult,
  DirectoryEntry,
  DeviceRecord,
  RpcNotification,
  SessionSummary,
  ThreadPayload,
  ThreadTokenUsage
} from "../domain/types";
import {
  buildStableMessageId,
  extractImageAttachments,
  extractItemMessagePayload,
  toTimelineMessageId,
  parseThreadTokenUsageNotification
} from "./eventParser";
import { JsonRpcClient } from "./jsonRpcClient";
import {
  assignNumericFlatSnapshotTimelineOrder,
  assignMissingTimelineOrder,
  parseMessageTimestampMs,
  sortMessagesAscending,
  toolCallCompletenessScore
} from "./messageChronology";

type ClientState = {
  endpoint: string;
  client: JsonRpcClient;
  initialized: boolean;
  unsubscribe: (() => void) | null;
};

export interface ThreadUsageSnapshot {
  threadId: string;
  turnId?: string;
  tokenUsage: ThreadTokenUsage;
  model?: string;
}

const clients = new Map<string, ClientState>();

let notificationSink: ((deviceId: string, notification: RpcNotification) => void) | null =
  null;
const ROLLOUT_TOOL_CACHE_KEY_SEPARATOR = "\u001f";
const rolloutToolMessagesCache = new Map<string, ChatMessage[]>();
const rolloutToolMessagesInFlight = new Map<string, Promise<ChatMessage[]>>();
const rolloutToolMessagesLatestKeyByPath = new Map<string, string>();

export const setNotificationSink = (
  sink: ((deviceId: string, notification: RpcNotification) => void) | null
): void => {
  notificationSink = sink;
};

export const closeDeviceClient = (deviceId: string): void => {
  const existing = clients.get(deviceId);
  if (!existing) {
    return;
  }

  existing.unsubscribe?.();
  existing.client.close();
  clients.delete(deviceId);
  clearRolloutToolMessagesForDevice(deviceId);
};

export const closeAllClients = (): void => {
  for (const deviceId of clients.keys()) {
    closeDeviceClient(deviceId);
  }
};

const ensureClientState = async (device: DeviceRecord): Promise<ClientState> => {
  const endpoint = device.connection?.endpoint;
  if (!endpoint) {
    throw new Error(`Device ${device.name} is not connected`);
  }

  const existing = clients.get(device.id);
  if (existing && existing.endpoint === endpoint) {
    return existing;
  }

  if (existing) {
    existing.unsubscribe?.();
    existing.client.close();
  }

  const client = new JsonRpcClient(endpoint);
  const unsubscribe = client.onNotification((notification) => {
    notificationSink?.(device.id, notification);
  });

  const state: ClientState = {
    endpoint,
    client,
    initialized: false,
    unsubscribe
  };
  clients.set(device.id, state);
  return state;
};

const ensureInitialized = async (device: DeviceRecord): Promise<JsonRpcClient> => {
  const state = await ensureClientState(device);
  const client = state.client;
  await client.connect();

  if (!state.initialized) {
    try {
      await client.call("initialize", {
        clientInfo: {
          name: "codex-session-monitor",
          version: "0.1.0"
        }
      });
    } catch (error) {
      throw new Error(
        `Failed to initialize app-server for device ${device.name}: ${asErrorMessage(error)}`
      );
    }

    // `initialized` can be implemented as a request or notification depending on server version.
    try {
      await client.call("initialized", {});
    } catch {
      // Safe fallback for servers that accept only one-way notification semantics.
      try {
        await client.call("initialized");
      } catch {
        // Keep compatibility with versions where initialize already finalizes setup.
      }
    }

    state.initialized = true;
  }

  return client;
};

export const readAccount = async (device: DeviceRecord): Promise<boolean> => {
  const client = await ensureInitialized(device);

  try {
    const result = await client.call<unknown>("account/read");
    const record = asRecord(result);
    if (!record) {
      return true;
    }

    if (record.authenticated === false) {
      return false;
    }

    if (typeof record.status === "string") {
      return record.status.toLowerCase() !== "logged_out";
    }

    return true;
  } catch {
    // Some app-server versions do not expose account/read.
    return true;
  }
};

export const listThreads = async (device: DeviceRecord): Promise<SessionSummary[]> => {
  const client = await ensureInitialized(device);
  const address = deviceAddress(device);
  const collected = new Map<string, SessionSummary>();
  let cursor: string | null = null;

  for (let page = 0; page < 20; page += 1) {
    const result = await client.call<unknown>("thread/list", {
      limit: 200,
      ...(cursor ? { cursor } : {})
    });

    const envelope = asRecord(result);
    const rawThreads = ensureArray(
      envelope?.data ?? envelope?.threads ?? envelope?.items ?? result
    );

    for (const rawThread of rawThreads) {
      const normalized = toSessionSummary(device, address, rawThread);
      if (normalized) {
        collected.set(normalized.key, normalized);
      }
    }

    const nextCursor =
      pickString(envelope, ["nextCursor", "next_cursor"]) ?? null;
    if (!nextCursor) {
      break;
    }
    cursor = nextCursor;
  }

  return [...collected.values()].sort(
    (a, b) => parseMessageTimestampMs(b.updatedAt) - parseMessageTimestampMs(a.updatedAt)
  );
};

export const listModels = async (device: DeviceRecord): Promise<string[]> => {
  const client = await ensureInitialized(device);
  const collected = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < 20; page += 1) {
    const result = await callWithFallback(client, "model/list", [
      { limit: 200, ...(cursor ? { cursor } : {}) },
      cursor ? { cursor } : undefined,
      {}
    ]);
    const envelope = asRecord(result);
    const rawModels = ensureArray(
      envelope?.data ?? envelope?.models ?? envelope?.items ?? result
    );

    for (const rawModel of rawModels) {
      if (typeof rawModel === "string") {
        const normalized = normalizeCatalogModelId(rawModel);
        if (normalized) {
          collected.add(normalized);
        }
        continue;
      }

      const record = asRecord(rawModel);
      if (!record) {
        continue;
      }

      const candidate =
        pickString(record, [
          "id",
          "model",
          "modelId",
          "model_id",
          "name",
          "slug",
          "modelName",
          "model_name"
        ]) ?? pickThreadModel(record);
      const normalized = normalizeCatalogModelId(candidate);
      if (normalized) {
        collected.add(normalized);
      }
    }

    const pagination = asRecord(envelope?.pagination);
    const nextCursor =
      pickString(envelope, ["nextCursor", "next_cursor"]) ??
      pickString(pagination, ["nextCursor", "next_cursor"]);
    if (!nextCursor || nextCursor === cursor) {
      break;
    }
    cursor = nextCursor;
  }

  return [...collected];
};

export const readThread = async (
  device: DeviceRecord,
  threadId: string,
  options?: { includeRolloutMessages?: boolean; skipMessages?: boolean }
): Promise<ThreadPayload> => {
  const client = await ensureInitialized(device);
  const result = await callWithFallback(client, "thread/read", [
    { threadId, includeTurns: true },
    { threadId }
  ]);

  const root = asRecord(result);
  const thread = asRecord(root?.thread) ?? root;
  const preview = pickSummaryPreview(thread);
  const baseTitle = deriveSessionBaseTitle(thread, threadId, preview);
  const cwd = pickString(thread, ["cwd", "workingDirectory", "working_directory"]);
  const preferredRolloutPath = pickString(thread, ["path"]);
  const folderName = folderNameFromPath(cwd);
  const model = pickThreadModel(thread);

  const session: SessionSummary = {
    key: makeSessionKey(device.id, threadId),
    threadId,
    deviceId: device.id,
    deviceLabel: device.name,
    deviceAddress: deviceAddress(device),
    title: formatSessionTitle(baseTitle, threadId),
    preview,
    updatedAt: pickTimestampIso(thread) ?? "",
    cwd: cwd ?? undefined,
    folderName: folderName ?? undefined
  };

  const threadMessages = options?.skipMessages
    ? []
    : parseMessagesFromThread(device.id, threadId, thread);
  const rolloutHistory =
    options?.skipMessages || options?.includeRolloutMessages === false
      ? { rolloutPath: preferredRolloutPath?.trim() || null, messages: [] as ChatMessage[] }
      : await recoverRolloutHistoryForThread(
          device,
          threadId,
          preferredRolloutPath,
          session.updatedAt
        );
  const messages =
    options?.skipMessages
      ? []
      : rolloutHistory.messages.length > 0
      ? rolloutHistory.messages
      : dedupeHistoricalMessages(threadMessages);
  if (!options?.skipMessages) {
    const firstUserMessage = messages.find((message) => message.role === "user");
    const latestPreviewMessage =
      [...messages]
        .reverse()
        .find((message) => message.role === "assistant" || message.role === "user") ??
      messages.at(-1);
    session.title = formatSessionTitle(
      firstUserMessage ? truncateForTitle(firstUserMessage.content.trim()) : baseTitle,
      threadId
    );
    session.preview = latestPreviewMessage?.content?.trim() || session.preview;
    session.updatedAt = session.updatedAt || messages.at(-1)?.createdAt || "";
  }

  return {
    session,
    messages,
    ...(rolloutHistory.rolloutPath ? { rolloutPath: rolloutHistory.rolloutPath } : {}),
    ...(model ? { model } : {})
  };
};

export const resumeThread = async (
  device: DeviceRecord,
  threadId: string
): Promise<{ model?: string }> => {
  const client = await ensureInitialized(device);
  const result = await callWithFallback(client, "thread/resume", [{ threadId }]);
  const record = asRecord(result);
  const model =
    pickString(record, ["model", "modelId", "model_id", "modelName", "model_name"]) ??
    pickThreadModel(asRecord(record?.thread));
  return model ? { model } : {};
};

export const startThread = async (
  device: DeviceRecord,
  cwd: string
): Promise<{ threadId: string; cwd: string; model?: string }> => {
  const client = await ensureInitialized(device);
  const normalizedCwd = normalizePosixPath(cwd);
  const result = await callWithFallback(client, "thread/start", [{ cwd: normalizedCwd }]);

  const record = asRecord(result);
  const thread = asRecord(record?.thread);
  const threadId =
    pickString(thread, ["id", "threadId", "thread_id"]) ??
    pickString(record, ["threadId", "thread_id", "id"]);
  if (!threadId) {
    throw new Error("Failed to create a new session: missing thread id.");
  }

  const resolvedCwd =
    pickString(record, ["cwd", "workingDirectory", "working_directory"]) ??
    pickString(thread, ["cwd", "workingDirectory", "working_directory"]) ??
    normalizedCwd;
  const model =
    pickString(record, ["model", "modelId", "model_id", "modelName", "model_name"]) ??
    pickThreadModel(thread);

  return {
    threadId,
    cwd: normalizePosixPath(resolvedCwd),
    ...(model ? { model } : {})
  };
};

export const listDirectories = async (
  device: DeviceRecord,
  cwd: string
): Promise<DirectoryBrowseResult> => {
  const client = await ensureInitialized(device);
  const normalizedCwd = normalizePosixPath(cwd);
  const result = await client.call<unknown>("command/exec", {
    command: ["ls", "-1A", "-p"],
    cwd: normalizedCwd
  });

  const response = asRecord(result);
  const exitCodeRaw = response?.exitCode ?? response?.exit_code;
  const exitCode =
    typeof exitCodeRaw === "number"
      ? exitCodeRaw
      : typeof exitCodeRaw === "string"
        ? Number.parseInt(exitCodeRaw, 10)
        : 0;
  const stdout = typeof response?.stdout === "string" ? response.stdout : "";
  const stderr = typeof response?.stderr === "string" ? response.stderr : "";

  if (!Number.isFinite(exitCode) || exitCode !== 0) {
    const reason = stderr.trim() || `Unable to list directories at ${normalizedCwd}.`;
    throw new Error(reason);
  }

  return {
    cwd: normalizedCwd,
    entries: parseLsDirectoryEntries(stdout, normalizedCwd)
  };
};

export const readThreadUsageFromRollout = async (
  device: DeviceRecord,
  threadId: string
): Promise<ThreadUsageSnapshot | null> => {
  // Thread ids are generated UUID-like identifiers. Skip fallback for unexpected input.
  if (!/^[A-Za-z0-9-]+$/.test(threadId)) {
    return null;
  }

  const rolloutPath = await findLatestRolloutPathForThread(device, threadId);
  if (!rolloutPath) {
    return null;
  }

  const client = await ensureInitialized(device);
  const result = await client.call<unknown>("command/exec", {
    command: [
      "sh",
      "-lc",
      [
        `match=${quotePosixShell(rolloutPath)}`,
        '[ -f "$match" ] || exit 0',
        'if command -v python3 >/dev/null 2>&1; then py=python3',
        'elif command -v python >/dev/null 2>&1; then py=python',
        'else exit 0',
        "fi",
        `"${"$"}py" -c ${quotePosixShell(buildRolloutUsagePythonScript())} "$match"`
      ].join("; ")
    ],
    cwd: "."
  });

  const response = asRecord(result);
  const exitCodeRaw = response?.exitCode ?? response?.exit_code;
  const exitCode =
    typeof exitCodeRaw === "number"
      ? exitCodeRaw
      : typeof exitCodeRaw === "string"
        ? Number.parseInt(exitCodeRaw, 10)
        : 0;
  if (!Number.isFinite(exitCode) || exitCode !== 0) {
    return null;
  }

  const stdout = typeof response?.stdout === "string" ? response.stdout.trim() : "";
  if (stdout.length === 0) {
    return null;
  }

  let parsedLine: unknown;
  try {
    parsedLine = JSON.parse(stdout);
  } catch {
    return null;
  }

  const parsedRecord = asRecord(parsedLine);
  const payload = asRecord(parsedRecord?.token_payload) ?? asRecord(parsedRecord?.payload) ?? parsedRecord;
  if (!payload) {
    return null;
  }

  const usageEvent = parseThreadTokenUsageNotification({
    method: "rollout/token_count",
    params: {
      threadId,
      msg: payload
    }
  });
  if (!usageEvent) {
    return null;
  }

  const limitName = pickString(asRecord(payload.rate_limits), ["limit_name", "limitName"]);
  const normalizedModel =
    normalizeModelFromLimitName(limitName) ??
    normalizeModelIdentifier(pickString(parsedRecord, ["model"]));

  return {
    threadId: usageEvent.threadId,
    ...(usageEvent.turnId ? { turnId: usageEvent.turnId } : {}),
    tokenUsage: usageEvent.tokenUsage,
    ...(normalizedModel ? { model: normalizedModel } : {})
  };
};

export const findLatestRolloutPathForThread = async (
  device: DeviceRecord,
  threadId: string
): Promise<string | null> => {
  if (!/^[A-Za-z0-9-]+$/.test(threadId)) {
    return null;
  }

  const client = await ensureInitialized(device);
  const result = await client.call<unknown>("command/exec", {
    command: [
      "sh",
      "-lc",
      [
        'root="${HOME}/.codex/sessions"',
        '[ -d "$root" ] || exit 0',
        `match="$(find "$root" -type f -name '*${threadId}.jsonl' 2>/dev/null | LC_ALL=C sort | tail -n 1)"`,
        '[ -n "$match" ] || exit 0',
        'printf "%s" "$match"'
      ].join("; ")
    ],
    cwd: "."
  });

  const response = asRecord(result);
  const exitCodeRaw = response?.exitCode ?? response?.exit_code;
  const exitCode =
    typeof exitCodeRaw === "number"
      ? exitCodeRaw
      : typeof exitCodeRaw === "string"
        ? Number.parseInt(exitCodeRaw, 10)
        : 0;
  if (!Number.isFinite(exitCode) || exitCode !== 0) {
    return null;
  }

  const stdout = typeof response?.stdout === "string" ? response.stdout.trim() : "";
  return stdout.length > 0 ? stdout : null;
};

export const readRolloutTimelineMessages = async (
  device: DeviceRecord,
  threadId: string,
  rolloutPath: string | null,
  revision?: string
): Promise<ChatMessage[]> => {
  if (!rolloutPath || rolloutPath.trim().length === 0) {
    return [];
  }

  const normalizedPath = rolloutPath.trim();
  const pathKey = buildRolloutToolMessagesPathKey(device.id, threadId, normalizedPath);
  const cacheKey = buildRolloutToolMessagesCacheKey(pathKey, revision ?? "");
  const previousCacheKey = rolloutToolMessagesLatestKeyByPath.get(pathKey);
  if (previousCacheKey && previousCacheKey !== cacheKey) {
    rolloutToolMessagesCache.delete(previousCacheKey);
  }
  rolloutToolMessagesLatestKeyByPath.set(pathKey, cacheKey);

  const cached = rolloutToolMessagesCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const inFlight = rolloutToolMessagesInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  let pending: Promise<ChatMessage[]>;
  pending = readRolloutTimelineMessagesUncached(device, threadId, normalizedPath)
    .then((messages) => {
      if (rolloutToolMessagesLatestKeyByPath.get(pathKey) === cacheKey) {
        rolloutToolMessagesCache.set(cacheKey, messages);
      }
      return messages;
    })
    .finally(() => {
      if (rolloutToolMessagesInFlight.get(cacheKey) === pending) {
        rolloutToolMessagesInFlight.delete(cacheKey);
      }
    });

  rolloutToolMessagesInFlight.set(cacheKey, pending);
  return pending;
};

const recoverRolloutHistoryForThread = async (
  device: DeviceRecord,
  threadId: string,
  rolloutPath: string | null | undefined,
  revision?: string,
  deps: {
    findLatestRolloutPath?: typeof findLatestRolloutPathForThread;
    readRolloutMessages?: typeof readRolloutTimelineMessages;
  } = {}
): Promise<{ rolloutPath: string | null; messages: ChatMessage[] }> => {
  const findLatestRolloutPath =
    deps.findLatestRolloutPath ?? findLatestRolloutPathForThread;
  const readRolloutMessages = deps.readRolloutMessages ?? readRolloutTimelineMessages;
  const normalizedPreferredPath = rolloutPath?.trim() || null;
  const initialMessages = await readRolloutMessages(
    device,
    threadId,
    normalizedPreferredPath,
    revision
  );
  if (initialMessages.length > 0) {
    return {
      rolloutPath: normalizedPreferredPath,
      messages: initialMessages
    };
  }

  const recoveredPath = await findLatestRolloutPath(device, threadId);
  const normalizedRecoveredPath = recoveredPath?.trim() || null;
  if (!normalizedRecoveredPath) {
    return {
      rolloutPath: normalizedPreferredPath,
      messages: initialMessages
    };
  }

  if (normalizedRecoveredPath === normalizedPreferredPath) {
    return {
      rolloutPath: normalizedRecoveredPath,
      messages: initialMessages
    };
  }

  return {
    rolloutPath: normalizedRecoveredPath,
    messages: await readRolloutMessages(
      device,
      threadId,
      normalizedRecoveredPath,
      revision
    )
  };
};

const readRolloutTimelineMessagesUncached = async (
  device: DeviceRecord,
  threadId: string,
  rolloutPath: string
): Promise<ChatMessage[]> => {
  if (rolloutPath.trim().length === 0) {
    return [];
  }

  const client = await ensureInitialized(device);
  const result = await client.call<unknown>("command/exec", {
    command: [
      "sh",
      "-lc",
      [
        `path=${quotePosixShell(rolloutPath)}`,
        '[ -f "$path" ] || exit 0',
        'if command -v python3 >/dev/null 2>&1; then py=python3',
        'elif command -v python >/dev/null 2>&1; then py=python',
        'else exit 0',
        "fi",
        `"${"$"}py" -c ${quotePosixShell(buildCompactRolloutPythonScript())} "$path"`
      ].join("; ")
    ],
    cwd: "."
  });

  const response = asRecord(result);
  const exitCodeRaw = response?.exitCode ?? response?.exit_code;
  const exitCode =
    typeof exitCodeRaw === "number"
      ? exitCodeRaw
      : typeof exitCodeRaw === "string"
        ? Number.parseInt(exitCodeRaw, 10)
        : 0;
  if (!Number.isFinite(exitCode) || exitCode !== 0) {
    return [];
  }

  const stdout = typeof response?.stdout === "string" ? response.stdout.trim() : "";
  if (stdout.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((value) => toTimelineMessageFromRolloutRecord(device.id, threadId, asRecord(value)))
    .filter((value): value is ChatMessage => value !== null)
    .map((message, index) => ({
      ...message,
      ...(typeof message.timelineOrder === "number"
        ? {}
        : { timelineOrder: index })
    }))
    .sort(sortMessagesAscending);
};

const clearRolloutToolMessagesForDevice = (deviceId: string): void => {
  const devicePrefix = `${deviceId}${ROLLOUT_TOOL_CACHE_KEY_SEPARATOR}`;

  for (const key of rolloutToolMessagesCache.keys()) {
    if (key.startsWith(devicePrefix)) {
      rolloutToolMessagesCache.delete(key);
    }
  }

  for (const key of rolloutToolMessagesInFlight.keys()) {
    if (key.startsWith(devicePrefix)) {
      rolloutToolMessagesInFlight.delete(key);
    }
  }

  for (const [pathKey] of rolloutToolMessagesLatestKeyByPath) {
    if (pathKey.startsWith(devicePrefix)) {
      rolloutToolMessagesLatestKeyByPath.delete(pathKey);
    }
  }
};

const buildRolloutToolMessagesPathKey = (
  deviceId: string,
  threadId: string,
  rolloutPath: string
): string =>
  [deviceId, threadId, rolloutPath].join(ROLLOUT_TOOL_CACHE_KEY_SEPARATOR);

const buildRolloutToolMessagesCacheKey = (
  pathKey: string,
  revision: string
): string =>
  [pathKey, revision].join(ROLLOUT_TOOL_CACHE_KEY_SEPARATOR);

interface RolloutToolEntry {
  id: string;
  name: string;
  input?: string;
  output?: string;
  status?: "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  order?: number;
}

export const parseToolMessagesFromRolloutJsonl = (
  deviceId: string,
  threadId: string,
  jsonl: string
): ChatMessage[] => {
  const entries = new Map<string, RolloutToolEntry>();

  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const record = asRecord(parsed);
    const payload = asRecord(record?.payload);
    const topLevelType = pickString(record, ["type"]);
    const payloadType = pickString(payload, ["type"]);
    const timestamp =
      normalizeIso(pickString(record, ["timestamp"])) ?? new Date().toISOString();

    upsertRolloutToolEntry(entries, payload, topLevelType, payloadType, timestamp);
  }

  return [...entries.values()]
    .map((entry) => toToolMessageFromRolloutEntry(deviceId, threadId, entry))
    .map((message, index) => ({ ...message, timelineOrder: index }))
    .sort(sortMessagesAscending);
};

const toTimelineMessageFromRolloutRecord = (
  deviceId: string,
  threadId: string,
  record: Record<string, unknown> | null
): ChatMessage | null => {
  if (!record) {
    return null;
  }

  const kind = pickString(record, ["kind"]);
  if (kind === "message") {
    return toHistoryMessageFromRolloutRecord(deviceId, threadId, record);
  }

  const id = pickString(record, ["id"]);
  const name = pickString(record, ["name"]);
  const createdAt =
    normalizeIso(pickString(record, ["createdAt"])) ?? new Date().toISOString();
  if (!id || !name) {
    return null;
  }

  const entry: RolloutToolEntry = {
    id,
    name,
    createdAt,
    updatedAt:
      normalizeIso(pickString(record, ["updatedAt"])) ?? createdAt,
    ...(typeof pickNumber(record, ["order"]) === "number"
      ? { order: pickNumber(record, ["order"]) ?? undefined }
      : {}),
    ...(pickString(record, ["input"]) ? { input: pickString(record, ["input"]) ?? undefined } : {}),
    ...(pickString(record, ["output"]) ? { output: pickString(record, ["output"]) ?? undefined } : {}),
    ...(normalizeToolStatus(pickString(record, ["status"])) ? { status: normalizeToolStatus(pickString(record, ["status"])) } : {})
  };

  return toToolMessageFromRolloutEntry(deviceId, threadId, entry);
};

const toHistoryMessageFromRolloutRecord = (
  deviceId: string,
  threadId: string,
  record: Record<string, unknown>
): ChatMessage | null => {
  const id = pickString(record, ["id"]);
  const role = pickString(record, ["role"]);
  const createdAt =
    normalizeIso(pickString(record, ["createdAt"])) ?? new Date().toISOString();
  if (!id || (role !== "user" && role !== "assistant" && role !== "system")) {
    return null;
  }
  const sourceType = pickString(record, ["sourceType", "source_type"]);
  // Rollout `response_item` user entries carry hidden prompt scaffolding
  // (AGENTS/environment context, subagent notifications, etc.). Base
  // `thread/read` history is authoritative for user messages, so rollout
  // enrichment should only surface assistant-side `response_item` history.
  if (sourceType === "response_item" && role !== "assistant") {
    return null;
  }

  const images = toImagesFromRolloutRecord(record);
  const eventType = pickString(record, ["eventType"]);

  return {
    id,
    key: makeSessionKey(deviceId, threadId),
    threadId,
    deviceId,
    role,
    content: pickString(record, ["content"]) ?? "",
    createdAt,
    chronologySource: "rollout",
    ...(typeof pickNumber(record, ["order"]) === "number"
      ? { timelineOrder: pickNumber(record, ["order"]) ?? undefined }
      : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(eventType === "reasoning" || eventType === "activity" || eventType === "tool_call"
      ? { eventType }
      : {})
  };
};

const toImagesFromRolloutRecord = (
  record: Record<string, unknown>
): ChatImageAttachment[] => {
  const rawImages = Array.isArray(record.images) ? record.images : [];
  const seen = new Set<string>();
  const images: ChatImageAttachment[] = [];

  for (const rawImage of rawImages) {
    const imageRecord = asRecord(rawImage);
    const url = pickString(imageRecord, ["url"]);
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    images.push({
      id: pickString(imageRecord, ["id"]) ?? `image-${images.length + 1}`,
      url,
      mimeType: pickString(imageRecord, ["mimeType", "mime_type"]) ?? undefined,
      fileName: pickString(imageRecord, ["fileName", "filename", "name"]) ?? undefined
    });
  }

  return images;
};

const toToolMessageFromRolloutEntry = (
  deviceId: string,
  threadId: string,
  entry: RolloutToolEntry
): ChatMessage => ({
  id: entry.id,
  key: makeSessionKey(deviceId, threadId),
  threadId,
  deviceId,
  role: "tool",
  eventType: "tool_call",
  content: formatRolloutToolMessageContent(entry),
  createdAt: entry.createdAt,
  chronologySource: "rollout",
  ...(typeof entry.order === "number" ? { timelineOrder: entry.order } : {}),
  toolCall: {
    name: entry.name,
    ...(entry.input ? { input: entry.input } : {}),
    ...(entry.output ? { output: entry.output } : {}),
    ...(entry.status ? { status: entry.status } : {})
  }
});

const upsertRolloutToolEntry = (
  entries: Map<string, RolloutToolEntry>,
  payload: Record<string, unknown> | null,
  topLevelType: string | null,
  payloadType: string | null,
  timestamp: string
): void => {
  if (!payload) {
    return;
  }

  const effectiveType = payloadType ?? topLevelType;
  if (
    effectiveType !== "function_call" &&
    effectiveType !== "function_call_output" &&
    effectiveType !== "custom_tool_call" &&
    effectiveType !== "custom_tool_call_output" &&
    effectiveType !== "web_search_call"
  ) {
    return;
  }

  const callId =
    effectiveType === "web_search_call"
      ? buildRolloutWebSearchEntryId(payload, timestamp)
      : pickString(payload, ["call_id", "callId"]);
  if (!callId) {
    return;
  }

  const existing = entries.get(callId);
  const entry: RolloutToolEntry = existing ?? {
    id: callId,
    name: "tool",
    createdAt: timestamp,
    updatedAt: timestamp
  };

  if (effectiveType === "web_search_call") {
    const input = formatRolloutWebSearchAction(asRecord(payload.action));
    const status = normalizeToolStatus(pickString(payload, ["status"])) ?? "completed";

    entries.set(callId, {
      ...entry,
      name: "web_search",
      ...(input ? { input } : {}),
      status,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    });
    return;
  }

  if (effectiveType === "function_call" || effectiveType === "custom_tool_call") {
    const name = pickString(payload, ["name"]);
    const input =
      effectiveType === "function_call"
        ? formatFunctionArguments(pickString(payload, ["arguments"]))
        : formatCustomToolInput(pickString(payload, ["input"]));
    const status =
      effectiveType === "custom_tool_call"
        ? normalizeToolStatus(pickString(payload, ["status"]))
        : entry.status;

    entries.set(callId, {
      ...entry,
      ...(name ? { name } : {}),
      ...(input ? { input } : {}),
      ...(status ? { status } : {}),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    });
    return;
  }

  const output =
    effectiveType === "function_call_output"
      ? normalizeFunctionCallOutput(pickString(payload, ["output"]))
      : normalizeCustomToolOutput(pickString(payload, ["output"]));
  const status =
    effectiveType === "custom_tool_call_output"
      ? "completed"
      : normalizeToolStatus(pickString(payload, ["status"])) ?? "completed";

  entries.set(callId, {
    ...entry,
    ...(output ? { output } : {}),
    status,
    updatedAt: timestamp
  });
};

const buildRolloutWebSearchEntryId = (
  payload: Record<string, unknown>,
  timestamp: string
): string | null => {
  const action = asRecord(payload.action);
  const fragment =
    sanitizeRolloutToolIdFragment(
      pickString(action, ["query", "url", "pattern"]) ??
        pickString(action, ["type"]) ??
        "search"
    ) ?? "search";
  return `web_search::${fragment}::${timestamp}`;
};

const sanitizeRolloutToolIdFragment = (value: string): string | null => {
  const normalized = value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 80);
  return normalized.length > 0 ? normalized : null;
};

const formatRolloutWebSearchAction = (
  action: Record<string, unknown> | null
): string | undefined => {
  if (!action) {
    return undefined;
  }

  const type = pickString(action, ["type"]) ?? "search";
  const query = pickString(action, ["query"]);
  const url = pickString(action, ["url"]);
  const pattern = pickString(action, ["pattern"]);
  const queries = ensureArray(action.queries)
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const serialized = JSON.stringify(
    {
      type,
      ...(query ? { query } : {}),
      ...(url ? { url } : {}),
      ...(pattern ? { pattern } : {}),
      ...(queries.length > 0 ? { queries } : {})
    },
    null,
    2
  );

  return serialized !== "{}" ? serialized : undefined;
};

const formatFunctionArguments = (value: string | null): string | undefined => {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
};

const formatCustomToolInput = (value: string | null): string | undefined => {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  return value;
};

const normalizeFunctionCallOutput = (value: string | null): string | undefined => {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  return sanitizeExecutionText(value);
};

const normalizeCustomToolOutput = (value: string | null): string | undefined => {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    const record = asRecord(parsed);
    if (!record) {
      return sanitizeExecutionText(value);
    }
    const output = pickString(record, ["output"]);
    if (output) {
      return sanitizeExecutionText(output);
    }
    return sanitizeExecutionText(JSON.stringify(parsed, null, 2));
  } catch {
    return sanitizeExecutionText(value);
  }
};

const sanitizeExecutionText = (value: string): string =>
  value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const normalizeToolStatus = (
  value: string | null
): "running" | "completed" | "failed" | undefined => {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("fail") || normalized.includes("error")) {
    return "failed";
  }
  if (
    normalized.includes("complete") ||
    normalized.includes("success") ||
    normalized.includes("done")
  ) {
    return "completed";
  }
  if (
    normalized.includes("run") ||
    normalized.includes("progress") ||
    normalized.includes("pending") ||
    normalized.includes("start")
  ) {
    return "running";
  }
  return undefined;
};

const formatRolloutToolMessageContent = (entry: RolloutToolEntry): string => {
  const parts = [`Tool: ${entry.name}`];
  if (entry.input) {
    parts.push(`Input:\n${entry.input}`);
  }
  if (entry.output) {
    parts.push(`Output:\n${entry.output}`);
  }
  return parts.join("\n\n");
};

export const startTurn = async (
  device: DeviceRecord,
  threadId: string,
  submission: ComposerSubmission
): Promise<string | null> => {
  const client = await ensureInitialized(device);
  const result = await callWithFallback(
    client,
    "turn/start",
    buildTurnStartAttempts(threadId, submission)
  );

  const record = asRecord(result);
  const turnId = pickString(record, ["turnId", "id"]);
  return turnId;
};

export const buildTurnStartAttempts = (
  threadId: string,
  submission: ComposerSubmission
): Array<Record<string, unknown>> => {
  const normalizedPrompt = submission.prompt.trim();
  const normalizedImages = normalizeOutgoingImages(submission.images);
  const hasImages = normalizedImages.length > 0;
  const selectedModel = resolveComposerModel(submission.model);
  const selectedEffort = resolveThinkingEffortForModel(
    selectedModel,
    submission.thinkingEffort
  );
  const resolvedModelForPayload =
    resolveSupportedModelId(selectedModel) ?? selectedModel;
  const requestBaseParams = {
    threadId,
    model: resolvedModelForPayload,
    reasoning: { effort: selectedEffort }
  };

  const sequenceShapes = buildTurnInputShapes(normalizedPrompt, normalizedImages);

  const attempts: Array<Record<string, unknown>> = [];
  for (const input of sequenceShapes) {
    attempts.push({ ...requestBaseParams, input });
  }

  // Keep legacy fallbacks for older app-server variants.
  if (!hasImages && normalizedPrompt.length > 0) {
    attempts.push({ ...requestBaseParams, input: normalizedPrompt });
  }

  return attempts;
};

const buildTurnInputShapes = (
  prompt: string,
  images: ChatImageAttachment[]
): unknown[] => {
  const richContentShapes = buildRichContentShapes(prompt, images);
  const shapes: unknown[] = [];

  for (const content of richContentShapes) {
    // Prefer direct input-item arrays for newer app-server variants.
    shapes.push(content);
    shapes.push([{ role: "user", content }]);
  }

  if (images.length === 0 && prompt.length > 0) {
    shapes.push([{ type: "text", text: prompt }]);
    shapes.push([{ role: "user", content: [{ type: "text", text: prompt }] }]);
    shapes.push([{ role: "user", content: prompt }]);
    shapes.push([prompt]);
  }

  return shapes;
};

const buildRichContentShapes = (
  prompt: string,
  images: ChatImageAttachment[]
): unknown[][] => {
  const imageShapes = buildImageContentShapes(images);
  const textParts: Array<Record<string, unknown> | null> =
    prompt.length > 0
      ? [{ type: "text", text: prompt }]
      : [null];

  const contents: unknown[][] = [];
  for (const textPart of textParts) {
    for (const imageParts of imageShapes) {
      const content = [
        ...(textPart ? [textPart] : []),
        ...imageParts
      ];
      if (content.length > 0) {
        contents.push(content);
      }
    }
  }

  return dedupeByJson(contents);
};

const buildImageContentShapes = (images: ChatImageAttachment[]): unknown[][] => {
  if (images.length === 0) {
    return [[]];
  }

  const dataUrlParsed = images.map((image) => parseDataUrlImage(image.url));

  return dedupeByJson([
    images.map((image) => ({
      type: "image",
      url: image.url
    })),
    images.map((image) => ({
      type: "image",
      image_url: image.url
    })),
    images.map((image) => ({
      type: "image",
      image_url: { url: image.url }
    })),
    images
      .map((_, index) => {
        const parsed = dataUrlParsed[index];
        if (!parsed) {
          return null;
        }
        return {
          type: "image",
          data: parsed.base64,
          mimeType: parsed.mimeType
        };
      })
      .filter(
        (
          value
        ): value is {
          type: "image";
          data: string;
          mimeType: string;
        } => value !== null
      ),
    images
      .map((_, index) => {
        const parsed = dataUrlParsed[index];
        if (!parsed) {
          return null;
        }
        return {
          type: "image",
          data: parsed.base64,
          mime_type: parsed.mimeType
        };
      })
      .filter(
        (
          value
        ): value is {
          type: "image";
          data: string;
          mime_type: string;
        } => value !== null
      )
  ]);
};

const normalizeOutgoingImages = (
  images: ComposerSubmission["images"]
): ChatImageAttachment[] =>
  images
    .filter((image) => isSupportedOutgoingImageUrl(image.url))
    .map((image) => ({ ...image, url: image.url.trim() }));

const isSupportedOutgoingImageUrl = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("data:image/") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("http://")
  );
};

const parseDataUrlImage = (
  value: string
): { mimeType: string; base64: string } | null => {
  const trimmed = value.trim();
  const match = trimmed.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) {
    return null;
  }
  const mimeType = match[1].toLowerCase();
  const base64 = match[2];
  if (base64.length === 0) {
    return null;
  }
  return { mimeType, base64 };
};

const dedupeByJson = <T>(values: T[]): T[] => {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
};

const quotePosixShell = (value: string): string => {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
};

const buildCompactRolloutPythonScript = (): string =>
  [
    "import hashlib, json, re, sys",
    "path = sys.argv[1]",
    "tool_entries = {}",
    "message_entries = {}",
    "order_counter = 0",
    "",
    "def fmt_args(value):",
    "    if not isinstance(value, str) or not value.strip():",
    "        return None",
    "    try:",
    "        return json.dumps(json.loads(value), indent=2)",
    "    except Exception:",
    "        return value",
    "",
    "def fmt_output(name, value):",
    "    if value is None:",
    "        return None",
    "    if name == 'view_image':",
    "        return '[image output omitted]'",
    "    text = value if isinstance(value, str) else json.dumps(value)",
    "    try:",
    "        parsed = json.loads(text)",
    "        if isinstance(parsed, dict) and isinstance(parsed.get('output'), str):",
    "            text = parsed['output']",
    "        elif isinstance(parsed, list):",
    "            return '[structured output omitted]'",
    "    except Exception:",
    "        pass",
    "    text = re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]', '', text)",
    "    text = text.replace('\\r', '')",
    "    text = re.sub(r'\\n{3,}', '\\n\\n', text).strip()",
    "    return text if len(text) <= 4000 else text[:4000] + '\\n...[truncated]'",
    "",
    "def fmt_search_action(action):",
    "    if not isinstance(action, dict):",
    "        return None",
    "    result = {'type': action.get('type') or 'search'}",
    "    if isinstance(action.get('query'), str) and action['query'].strip():",
    "        result['query'] = action['query']",
    "    if isinstance(action.get('url'), str) and action['url'].strip():",
    "        result['url'] = action['url']",
    "    if isinstance(action.get('pattern'), str) and action['pattern'].strip():",
    "        result['pattern'] = action['pattern']",
    "    queries = [",
    "        entry.strip()",
    "        for entry in (action.get('queries') or [])",
    "        if isinstance(entry, str) and entry.strip()",
    "    ]",
    "    if queries:",
    "        result['queries'] = queries",
    "    return json.dumps(result, indent=2) if result else None",
    "",
    "def extract_text(value):",
    "    if isinstance(value, str):",
    "        return value",
    "    if isinstance(value, list):",
    "        parts = [extract_text(item).strip() for item in value]",
    "        return '\\n'.join(part for part in parts if part)",
    "    if isinstance(value, dict):",
    "        for key in ('text', 'message', 'content', 'output_text', 'input_text', 'summary'):",
    "            if key in value:",
    "                text = extract_text(value.get(key))",
    "                if isinstance(text, str) and text.strip():",
    "                    return text",
    "    return ''",
    "",
    "def normalize_image_url(value):",
    "    if not isinstance(value, str) or not value.strip():",
    "        return None",
    "    text = value.strip()",
    "    if text.startswith('/'):",
    "        return 'file://' + text",
    "    return text",
    "",
    "def add_message(timestamp, role, content, raw_images, event_type=None, source_type=None):",
    "    global order_counter",
    "    if role not in {'user', 'assistant'}:",
    "        return",
    "    text = content if isinstance(content, str) else ''",
    "    text = text if len(text) <= 8000 else text[:8000] + '\\n...[truncated]'",
    "    normalized_images = []",
    "    if isinstance(raw_images, list):",
    "        for raw in raw_images:",
    "            image_url = normalize_image_url(raw)",
    "            if image_url and image_url not in normalized_images:",
    "                normalized_images.append(image_url)",
    "    if not text.strip() and not normalized_images:",
    "        return",
    "    digest = hashlib.sha1(json.dumps({",
    "        'timestamp': timestamp,",
    "        'role': role,",
    "        'content': text,",
    "        'images': normalized_images,",
    "        'eventType': event_type",
    "    }, sort_keys=True).encode('utf-8')).hexdigest()[:16]",
    "    entry = {",
    "        'kind': 'message',",
    "        'id': f'message-{digest}',",
    "        'role': role,",
    "        'content': text,",
    "        'createdAt': timestamp,",
    "        'order': order_counter",
    "    }",
    "    order_counter += 1",
    "    if event_type:",
    "        entry['eventType'] = event_type",
    "    if source_type:",
    "        entry['sourceType'] = source_type",
    "    if normalized_images:",
    "        entry['images'] = [",
    "            {'id': f'image-{index + 1}', 'url': image_url}",
    "            for index, image_url in enumerate(normalized_images)",
    "        ]",
    "    message_entries[entry['id']] = entry",
    "",
    "with open(path, encoding='utf-8') as handle:",
    "    for raw_line in handle:",
    "        try:",
    "            obj = json.loads(raw_line)",
    "        except Exception:",
    "            continue",
    "        payload = obj.get('payload') if isinstance(obj.get('payload'), dict) else None",
    "        if not payload:",
    "            continue",
    "        payload_type = payload.get('type')",
    "        if obj.get('type') == 'event_msg' and payload_type in {'user_message', 'agent_message'}:",
    "            add_message(",
    "                obj.get('timestamp'),",
    "                'user' if payload_type == 'user_message' else 'assistant',",
    "                payload.get('message'),",
    "                (payload.get('images') or []) + (payload.get('local_images') or []),",
    "                None,",
    "                'event_msg'",
    "            )",
    "            continue",
    "        if obj.get('type') == 'response_item' and payload_type == 'message':",
    "            if payload.get('role') != 'assistant':",
    "                continue",
    "            add_message(",
    "                obj.get('timestamp'),",
    "                payload.get('role'),",
    "                extract_text(payload.get('content')),",
    "                [],",
    "                None,",
    "                'response_item'",
    "            )",
    "            continue",
    "        if obj.get('type') == 'response_item' and payload_type == 'reasoning':",
    "            reasoning_text = extract_text(payload.get('summary'))",
    "            if isinstance(reasoning_text, str) and reasoning_text.strip():",
    "                add_message(",
    "                    obj.get('timestamp'),",
    "                    'assistant',",
    "                    reasoning_text,",
    "                    [],",
    "                    'reasoning',",
    "                    'response_item'",
    "                )",
    "            continue",
    "        if payload_type == 'web_search_call':",
    "            search_input = fmt_search_action(payload.get('action'))",
    "            digest_source = json.dumps({",
    "                'timestamp': obj.get('timestamp'),",
    "                'action': payload.get('action')",
    "            }, sort_keys=True, default=str)",
    "            call_id = 'web_search-' + hashlib.sha1(digest_source.encode('utf-8')).hexdigest()[:16]",
    "            tool_entries[call_id] = {",
    "                'id': call_id,",
    "                'kind': 'tool',",
    "                'name': 'web_search',",
    "                'createdAt': obj.get('timestamp'),",
    "                'updatedAt': obj.get('timestamp'),",
    "                'order': order_counter,",
    "                'status': payload.get('status') or 'completed'",
    "            }",
    "            if isinstance(search_input, str) and search_input:",
    "                tool_entries[call_id]['input'] = search_input",
    "            order_counter += 1",
    "            continue",
    "        if payload_type not in {'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'}:",
    "            continue",
    "        call_id = payload.get('call_id') or payload.get('callId')",
    "        if not call_id:",
    "            continue",
    "        entry = tool_entries.setdefault(call_id, {",
    "            'id': call_id,",
    "            'kind': 'tool',",
    "            'name': 'tool',",
    "            'createdAt': obj.get('timestamp'),",
    "            'updatedAt': obj.get('timestamp'),",
    "            'order': order_counter",
    "        })",
    "        if entry.get('order') == order_counter:",
    "            order_counter += 1",
    "        if payload_type in {'function_call', 'custom_tool_call'}:",
    "            if isinstance(payload.get('name'), str) and payload['name'].strip():",
    "                entry['name'] = payload['name']",
    "            tool_input = fmt_args(payload.get('arguments')) if payload_type == 'function_call' else payload.get('input')",
    "            if isinstance(tool_input, str) and tool_input:",
    "                entry['input'] = tool_input",
    "            if isinstance(payload.get('status'), str) and payload['status'].strip():",
    "                entry['status'] = payload['status']",
    "        else:",
    "            tool_output = fmt_output(entry.get('name'), payload.get('output'))",
    "            if isinstance(tool_output, str) and tool_output:",
    "                entry['output'] = tool_output",
    "            entry['status'] = 'completed'",
    "            entry['updatedAt'] = obj.get('timestamp')",
    "",
    "timeline = list(message_entries.values()) + list(tool_entries.values())",
    "timeline.sort(key=lambda entry: ((entry.get('createdAt') or ''), int(entry.get('order') or 0)))",
    "if len(timeline) > 300:",
    "    timeline = timeline[-300:]",
    "print(json.dumps(timeline))"
  ].join("\n");

const buildRolloutUsagePythonScript = (): string =>
  [
    "import json, sys",
    "path = sys.argv[1]",
    "latest_token_payload = None",
    "latest_model = None",
    "with open(path, 'r', encoding='utf-8') as handle:",
    "    for raw in handle:",
    "        line = raw.strip()",
    "        if not line:",
    "            continue",
    "        try:",
    "            obj = json.loads(line)",
    "        except Exception:",
    "            continue",
    "        payload = obj.get('payload') if isinstance(obj.get('payload'), dict) else {}",
    "        payload_type = payload.get('type') if isinstance(payload, dict) else None",
    "        record_type = obj.get('type')",
    "        if payload_type == 'token_count':",
    "            latest_token_payload = payload",
    "            rate_limits = payload.get('rate_limits') if isinstance(payload.get('rate_limits'), dict) else {}",
    "            limit_name = rate_limits.get('limit_name') or rate_limits.get('limitName')",
    "            if isinstance(limit_name, str) and limit_name.strip():",
    "                latest_model = limit_name.strip()",
    "        candidate_models = []",
    "        if record_type == 'turn_context':",
    "            candidate_models.append(payload.get('model'))",
    "        candidate_models.extend([payload.get('model'), payload.get('to_model'), payload.get('toModel')])",
    "        for candidate in candidate_models:",
    "            if isinstance(candidate, str) and candidate.strip():",
    "                latest_model = candidate.strip()",
    "        if record_type == 'response_item' and payload_type == 'message':",
    "            model = payload.get('model')",
    "            if isinstance(model, str) and model.strip():",
    "                latest_model = model.strip()",
    "if not latest_token_payload:",
    "    raise SystemExit(0)",
    "result = {'token_payload': latest_token_payload}",
    "if latest_model:",
    "    result['model'] = latest_model",
    "print(json.dumps(result))"
  ].join("\n");

const callWithFallback = async (
  client: JsonRpcClient,
  method: string,
  attempts: Array<Record<string, unknown> | undefined>
): Promise<unknown> => {
  let lastError: unknown = null;
  for (const params of attempts) {
    try {
      return await client.call(method, params);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`RPC call failed: ${method}`);
};

const toSessionSummary = (
  device: DeviceRecord,
  address: string,
  value: unknown
): SessionSummary | null => {
  const entry = asRecord(value);
  if (!entry) {
    return null;
  }

  const threadId = pickString(entry, ["id", "threadId", "thread_id"]);
  if (!threadId) {
    return null;
  }

  const preview = pickSummaryPreview(entry);
  const baseTitle = deriveSessionBaseTitle(entry, threadId, preview);
  const cwd = pickString(entry, ["cwd", "workingDirectory", "working_directory"]);
  const folderName = folderNameFromPath(cwd);

  return {
    key: makeSessionKey(device.id, threadId),
    threadId,
    deviceId: device.id,
    deviceLabel: device.name,
    deviceAddress: address,
    title: formatSessionTitle(baseTitle, threadId),
    preview,
    updatedAt: pickTimestampIso(entry) ?? "",
    cwd: cwd ?? undefined,
    folderName: folderName ?? undefined
  };
};

const parseMessagesFromThread = (
  deviceId: string,
  threadId: string,
  thread: Record<string, unknown> | null
): ChatMessage[] => {
  if (!thread) {
    return [];
  }

  const threadFallbackCreatedAt = pickTimestampIso(thread) ?? new Date().toISOString();

  const fromMessages = ensureArray(thread.messages).flatMap((entry) =>
    parseMessageLike(deviceId, threadId, entry, threadFallbackCreatedAt)
  );

  const turns = ensureArray(thread.turns);
  const fromTurns = turns.flatMap((turn) => {
    const turnRecord = asRecord(turn);
    const turnCreatedAt =
      normalizeIso(
        pickString(turnRecord, ["createdAt", "created_at", "startedAt", "started_at"])
      ) ?? threadFallbackCreatedAt;

    const messages = ensureArray(turnRecord?.messages).flatMap((entry) =>
      parseMessageLike(deviceId, threadId, entry, turnCreatedAt)
    );

    const items = ensureArray(turnRecord?.items).flatMap((item) =>
      parseItemLike(deviceId, threadId, item, turnCreatedAt)
    );

    return [...messages, ...items].map((message) => ({
      ...message,
      chronologySource: "turn" as const
    }));
  });

  if (fromTurns.length === 0) {
    return dedupeHistoricalMessages(
      assignNumericFlatSnapshotTimelineOrder(fromMessages).map((message) => ({
        ...message,
        chronologySource: "flat_fallback" as const
      }))
    );
  }

  const turnMessageKeys = new Set(
    fromTurns.map((message) => messageIdentityWithoutTimestamp(message))
  );
  const supplementalTopLevelMessages = fromMessages.filter(
    (message) => !turnMessageKeys.has(messageIdentityWithoutTimestamp(message))
  );

  return dedupeHistoricalMessages([
    ...fromTurns,
    ...supplementalTopLevelMessages.map((message) => ({
      ...message,
      chronologySource: "flat_fallback" as const
    }))
  ]);
};

const dedupeHistoricalMessages = (messages: ChatMessage[]): ChatMessage[] => {
  const deduped = new Map<string, ChatMessage>();
  for (const message of messages) {
    const key = strictMessageIdentityKey(message);
    const existing = deduped.get(key);
    deduped.set(key, existing ? preferRicherMessage(existing, message) : message);
  }

  return assignMissingTimelineOrder([...deduped.values()]).sort(sortMessagesAscending);
};

const strictMessageIdentityKey = (message: ChatMessage): string => {
  const normalizedTimestamp = normalizeIso(message.createdAt) ?? message.createdAt;
  const imageSignature = (message.images ?? [])
    .map((image) => image.url.trim())
    .filter((url) => url.length > 0)
    .join("|");
  return [
    message.id,
    message.role,
    message.eventType ?? "",
    normalizedTimestamp,
    imageSignature
  ].join("::");
};

const messageIdentityWithoutTimestamp = (message: ChatMessage): string =>
  [message.id, message.role, message.eventType ?? ""].join("::");

const preferRicherMessage = (
  current: ChatMessage,
  incoming: ChatMessage
): ChatMessage => {
  const currentToolScore = toolCallCompletenessScore(current);
  const incomingToolScore = toolCallCompletenessScore(incoming);
  if (currentToolScore !== incomingToolScore) {
    return incomingToolScore > currentToolScore ? incoming : current;
  }

  const currentImageCount = current.images?.length ?? 0;
  const incomingImageCount = incoming.images?.length ?? 0;
  if (currentImageCount !== incomingImageCount) {
    return incomingImageCount > currentImageCount ? incoming : current;
  }

  return incoming.content.length >= current.content.length ? incoming : current;
};

const parseMessageLike = (
  deviceId: string,
  threadId: string,
  value: unknown,
  fallbackCreatedAt: string
): ChatMessage[] => {
  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const role = inferRole(record);
  const payload = extractItemMessagePayload(record, "message/read", role);
  if (!payload) {
    return [];
  }
  const images = extractImageAttachments(record);
  const createdAt =
    normalizeIso(
      pickString(record, [
        "completedAt",
        "completed_at",
        "updatedAt",
        "updated_at",
        "createdAt",
        "created_at",
        "startedAt",
        "started_at"
      ])
    ) ??
    fallbackCreatedAt;

  const baseId =
    pickString(record, ["id", "messageId", "itemId"]) ??
    buildStableMessageId({
      threadId,
      role,
      eventType: payload.eventType,
      method: "message/read",
      createdAt,
      record,
      payload
    });

  return [
    {
      id: toTimelineMessageId({
        baseId,
        eventType: payload.eventType,
        createdAt
      }),
      key: makeSessionKey(deviceId, threadId),
      threadId,
      deviceId,
      role,
      content: payload.content,
      createdAt,
      ...(images.length > 0 ? { images } : {}),
      ...(payload.eventType ? { eventType: payload.eventType } : {}),
      ...(payload.toolCall ? { toolCall: payload.toolCall } : {})
    }
  ];
};

const parseItemLike = (
  deviceId: string,
  threadId: string,
  value: unknown,
  fallbackCreatedAt: string
): ChatMessage[] => {
  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const role = inferRole(record);
  const payload = extractItemMessagePayload(record, "item/read", role);
  if (!payload) {
    return [];
  }
  const images = extractImageAttachments(record);

  const createdAt =
    normalizeIso(
      pickString(record, [
        "completedAt",
        "completed_at",
        "updatedAt",
        "updated_at",
        "createdAt",
        "created_at",
        "startedAt",
        "started_at"
      ])
    ) ?? fallbackCreatedAt;

  const baseId =
    pickString(record, ["id", "itemId"]) ??
    buildStableMessageId({
      threadId,
      role,
      eventType: payload.eventType,
      method: "item/read",
      createdAt,
      record,
      payload
    });

  return [
    {
      id: toTimelineMessageId({
        baseId,
        eventType: payload.eventType,
        createdAt
      }),
      key: makeSessionKey(deviceId, threadId),
      threadId,
      deviceId,
      role,
      content: payload.content,
      createdAt,
      ...(images.length > 0 ? { images } : {}),
      ...(payload.eventType ? { eventType: payload.eventType } : {}),
      ...(payload.toolCall ? { toolCall: payload.toolCall } : {})
    }
  ];
};

const inferRole = (record: Record<string, unknown>): ChatRole => {
  const role = pickString(record, ["role", "author"]);
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") {
    return role;
  }

  const type = (pickString(record, ["type", "itemType"]) ?? "").toLowerCase();
  if (type.includes("user")) {
    return "user";
  }
  if (type.includes("assistant") || type.includes("agent")) {
    return "assistant";
  }
  if (type.includes("tool")) {
    return "tool";
  }
  return "system";
};

const ensureArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
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

const pickNumber = (
  value: Record<string, unknown> | null | undefined,
  keys: string[]
): number | null => {
  if (!value) {
    return null;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string") {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
};

const normalizeIso = (value: string | number | null): string | null => {
  if (value === null) {
    return null;
  }

  let normalizedValue: string | number = value;
  if (typeof normalizedValue === "number") {
    normalizedValue = normalizedValue < 1_000_000_000_000 ? normalizedValue * 1000 : normalizedValue;
  }

  if (typeof normalizedValue === "string" && normalizedValue.trim().length === 0) {
    return null;
  }

  const date = new Date(normalizedValue);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
};

const pickTimestampIso = (
  value: Record<string, unknown> | null | undefined,
  depth = 0
): string | null => {
  if (!value || depth > 1) {
    return null;
  }

  const isoDirect = normalizeIso(
    pickString(value, [
      "updatedAt",
      "updated_at",
      "updated",
      "updatedDate",
      "updated_date",
      "lastActivityAt",
      "last_activity_at",
      "lastActiveAt",
      "last_active_at",
      "lastModifiedAt",
      "last_modified_at",
      "lastMessageAt",
      "last_message_at",
      "lastTurnAt",
      "last_turn_at",
      "modifiedAt",
      "modified_at",
      "mtime",
      "createdAt",
      "created_at"
    ])
  );
  if (isoDirect) {
    return isoDirect;
  }

  const isoNumeric = normalizeIso(
    pickNumber(value, [
      "updatedAtMs",
      "updated_at_ms",
      "updatedMs",
      "updated_ms",
      "lastActivityMs",
      "last_activity_ms",
      "lastActiveMs",
      "last_active_ms",
      "lastMessageMs",
      "last_message_ms",
      "lastTurnMs",
      "last_turn_ms",
      "modifiedAtMs",
      "modified_at_ms",
      "mtimeMs",
      "mtime_ms",
      "updatedAt",
      "updated_at",
      "lastActivityAt",
      "last_activity_at",
      "lastMessageAt",
      "last_message_at"
    ])
  );
  if (isoNumeric) {
    return isoNumeric;
  }

  const nestedCandidates = [
    "lastMessage",
    "last_message",
    "latestMessage",
    "latest_message",
    "lastTurn",
    "last_turn",
    "activity",
    "metadata"
  ];
  for (const key of nestedCandidates) {
    const nested = asRecord(value[key]);
    const nestedTimestamp = pickTimestampIso(nested, depth + 1);
    if (nestedTimestamp) {
      return nestedTimestamp;
    }
  }

  return null;
};

const pickSummaryPreview = (
  value: Record<string, unknown> | null | undefined
): string =>
  truncateForPreview(
    pickString(value, [
      "preview",
      "lastMessage",
      "last_message",
      "snippet",
      "summary"
    ]) ?? ""
  );

const deriveSessionBaseTitle = (
  value: Record<string, unknown> | null | undefined,
  threadId: string,
  preview: string
): string => {
  const candidate =
    pickString(value, [
      "title",
      "name",
      "summary",
      "firstUserMessage",
      "first_user_message",
      "firstPrompt",
      "first_prompt"
    ]) ?? preview;

  const normalized = truncateForTitle(candidate.trim());
  if (normalized.length === 0) {
    return threadId;
  }
  if (normalized.toLowerCase() === "thread" || normalized.startsWith("Thread ")) {
    return threadId;
  }
  return normalized;
};

const pickThreadModel = (
  value: Record<string, unknown> | null | undefined,
  depth = 0
): string | null => {
  if (!value || depth > 2) {
    return null;
  }

  const direct = pickString(value, ["model", "modelId", "model_id", "modelName", "model_name"]);
  if (direct) {
    return direct;
  }

  const nestedCandidates = [
    "config",
    "settings",
    "metadata",
    "modelInfo",
    "model_info",
    "turn",
    "lastTurn",
    "last_turn",
    "latestMessage",
    "latest_message"
  ];
  for (const key of nestedCandidates) {
    const nested = asRecord(value[key]);
    const nestedModel = pickThreadModel(nested, depth + 1);
    if (nestedModel) {
      return nestedModel;
    }
  }

  return null;
};

const normalizeModelFromLimitName = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  return normalized.length > 0 ? normalized : null;
};

const normalizeModelIdentifier = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

const truncateForPreview = (value: string): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) {
    return normalized;
  }
  return `${normalized.slice(0, 177)}...`;
};

const truncateForTitle = (value: string): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
};

const formatSessionTitle = (baseTitle: string, threadId: string): string =>
  `${baseTitle || threadId} (${threadId})`;

export const normalizePosixPath = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return ".";
  }

  const normalizedSeparators = trimmed.replace(/\\/g, "/");
  const isAbsolute = normalizedSeparators.startsWith("/");
  const parts = normalizedSeparators.split("/");
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!isAbsolute) {
        stack.push("..");
      }
      continue;
    }
    stack.push(part);
  }

  if (isAbsolute) {
    return stack.length === 0 ? "/" : `/${stack.join("/")}`;
  }

  if (stack.length === 0) {
    return ".";
  }

  return stack.join("/");
};

export const joinPosixPath = (base: string, child: string): string => {
  if (child.trim().startsWith("/")) {
    return normalizePosixPath(child);
  }

  const normalizedBase = normalizePosixPath(base);
  if (normalizedBase === "/") {
    return normalizePosixPath(`/${child}`);
  }
  if (normalizedBase === ".") {
    return normalizePosixPath(child);
  }
  return normalizePosixPath(`${normalizedBase}/${child}`);
};

export const parentPosixPath = (value: string): string => {
  const normalized = normalizePosixPath(value);
  if (normalized === "/") {
    return "/";
  }
  if (normalized === "." || normalized === "..") {
    return normalized;
  }

  const parts = normalized.split("/");
  parts.pop();

  if (normalized.startsWith("/")) {
    const joined = parts.filter((segment) => segment.length > 0).join("/");
    return joined.length === 0 ? "/" : `/${joined}`;
  }

  const joined = parts.filter((segment) => segment.length > 0).join("/");
  return joined.length === 0 ? "." : joined;
};

export const parseLsDirectoryEntries = (
  stdout: string,
  cwd: string
): DirectoryEntry[] => {
  const normalizedCwd = normalizePosixPath(cwd);
  const parent = parentPosixPath(normalizedCwd);
  const entries: DirectoryEntry[] = [];

  if (normalizedCwd !== "/" && parent !== normalizedCwd) {
    entries.push({
      kind: "parent",
      name: "..",
      path: parent
    });
  }

  const directories = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.endsWith("/"))
    .map((line) => line.replace(/\/+$/, ""))
    .filter((line) => line.length > 0 && line !== "." && line !== "..")
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  for (const directoryName of directories) {
    entries.push({
      kind: "directory",
      name: directoryName,
      path: joinPosixPath(normalizedCwd, directoryName)
    });
  }

  return entries;
};

const folderNameFromPath = (value: string | null): string | null => {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) {
    return null;
  }

  const segments = normalized.split("/");
  return segments[segments.length - 1] || null;
};

const deviceAddress = (device: DeviceRecord): string => {
  if (device.config.kind === "ssh") {
    return `${device.config.user}@${device.config.host}:${device.config.sshPort}`;
  }
  return "127.0.0.1";
};

const asErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error";

export const __TEST_ONLY__ = {
  parseMessagesFromThread,
  toTimelineMessageFromRolloutRecord,
  recoverRolloutHistoryForThread
};
