import { makeSessionKey } from "../domain/sessionKey";
import type {
  ChatImageAttachment,
  ChatMessage,
  ChatRole,
  ComposerSubmission,
  DeviceRecord,
  RpcNotification,
  SessionSummary,
  ThreadPayload
} from "../domain/types";
import { extractImageAttachments, extractItemMessagePayload } from "./eventParser";
import { JsonRpcClient } from "./jsonRpcClient";

type ClientState = {
  endpoint: string;
  client: JsonRpcClient;
  initialized: boolean;
  unsubscribe: (() => void) | null;
};

const clients = new Map<string, ClientState>();

let notificationSink: ((deviceId: string, notification: RpcNotification) => void) | null =
  null;

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
    (a, b) => parseTimestampMs(b.updatedAt) - parseTimestampMs(a.updatedAt)
  );
};

export const readThread = async (
  device: DeviceRecord,
  threadId: string
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
  const folderName = folderNameFromPath(cwd);

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

  const messages = parseMessagesFromThread(device.id, threadId, thread);
  const firstUserMessage = messages.find((message) => message.role === "user");
  const latest = messages.at(-1);
  session.title = formatSessionTitle(
    firstUserMessage ? truncateForTitle(firstUserMessage.content.trim()) : baseTitle,
    threadId
  );
  session.preview = latest?.content?.trim() || session.preview;
  session.updatedAt = session.updatedAt || latest?.createdAt || "";

  return { session, messages };
};

export const resumeThread = async (
  device: DeviceRecord,
  threadId: string
): Promise<void> => {
  const client = await ensureInitialized(device);
  await callWithFallback(client, "thread/resume", [{ threadId }, { id: threadId }]);
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

const buildTurnStartAttempts = (
  threadId: string,
  submission: ComposerSubmission
): Array<Record<string, unknown>> => {
  const normalizedPrompt = submission.prompt.trim();
  const normalizedImages = normalizeOutgoingImages(submission.images);

  const sequenceShapes = buildTurnInputShapes(normalizedPrompt, normalizedImages);

  const attempts: Array<Record<string, unknown>> = [];
  for (const input of sequenceShapes) {
    attempts.push({ threadId, input });
    attempts.push({ thread_id: threadId, input });
  }

  // Keep legacy fallbacks for older app-server variants.
  if (normalizedPrompt.length > 0) {
    attempts.push({ threadId, input: normalizedPrompt });
    attempts.push({ thread_id: threadId, input: normalizedPrompt });
    attempts.push({ input: normalizedPrompt });
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
    shapes.push([{ role: "user", content }]);
    shapes.push(content);
  }

  if (prompt.length > 0) {
    shapes.push([{ role: "user", content: prompt }]);
    shapes.push([{ type: "input_text", text: prompt }]);
    shapes.push([{ type: "text", text: prompt }]);
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
      ? [
          { type: "text", text: prompt },
          { type: "input_text", text: prompt }
        ]
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

  return [
    images.map((image) => ({
      type: "image_url",
      image_url: { url: image.url }
    })),
    images.map((image) => ({
      type: "input_image",
      image_url: { url: image.url }
    })),
    images.map((image) => ({ type: "input_image", image_url: image.url })),
    images.map((image) => ({ type: "image_url", image_url: image.url }))
  ];
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

  const fromMessages = ensureArray(thread.messages).flatMap((entry) =>
    parseMessageLike(deviceId, threadId, entry)
  );

  const turns = ensureArray(thread.turns);
  const fromTurns = turns.flatMap((turn) => {
    const turnRecord = asRecord(turn);
    const turnCreatedAt =
      normalizeIso(
        pickString(turnRecord, ["createdAt", "created_at", "startedAt", "started_at"])
      ) ?? new Date().toISOString();

    const messages = ensureArray(turnRecord?.messages).flatMap((entry) =>
      parseMessageLike(deviceId, threadId, entry)
    );

    const items = ensureArray(turnRecord?.items).flatMap((item) =>
      parseItemLike(deviceId, threadId, item, turnCreatedAt)
    );

    return [...messages, ...items];
  });

  const combined = [...fromMessages, ...fromTurns];
  const deduped = new Map<string, ChatMessage>();
  for (const message of combined) {
    const key = messageIdentityKey(message);
    const current = deduped.get(key);
    deduped.set(key, current ? mergeMessages(current, message) : message);
  }

  return [...deduped.values()].sort(sortMessagesAscending);
};

const messageIdentityKey = (message: ChatMessage): string => {
  const normalizedTimestamp = normalizeIso(message.createdAt) ?? message.createdAt;
  return [
    message.id,
    message.role,
    message.eventType ?? "",
    normalizedTimestamp
  ].join("::");
};

const mergeMessages = (current: ChatMessage, incoming: ChatMessage): ChatMessage => {
  const content =
    incoming.content.length >= current.content.length ? incoming.content : current.content;
  const createdAt = pickLatestTimestamp(current.createdAt, incoming.createdAt);

  return {
    ...current,
    ...incoming,
    content,
    createdAt
  };
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
  const aMs = parseTimestampMs(a.createdAt);
  const bMs = parseTimestampMs(b.createdAt);
  if (aMs === bMs) {
    return a.id.localeCompare(b.id);
  }
  return aMs - bMs;
};

const parseMessageLike = (
  deviceId: string,
  threadId: string,
  value: unknown
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
    normalizeIso(pickString(record, ["createdAt", "created_at", "completedAt"])) ??
    new Date().toISOString();

  const id =
    pickString(record, ["id", "messageId", "itemId"]) ??
    `${threadId}-${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return [
    {
      id,
      key: makeSessionKey(deviceId, threadId),
      threadId,
      deviceId,
      role,
      content: payload.content,
      createdAt,
      ...(images.length > 0 ? { images } : {}),
      ...(payload.eventType ? { eventType: payload.eventType } : {})
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

  const status = pickString(record, ["status", "state"]);
  if (status && status.toLowerCase() === "started") {
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
      pickString(record, ["completedAt", "completed_at", "createdAt", "created_at"])
    ) ?? fallbackCreatedAt;

  const id =
    pickString(record, ["id", "itemId"]) ??
    `${threadId}-${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return [
    {
      id,
      key: makeSessionKey(deviceId, threadId),
      threadId,
      deviceId,
      role,
      content: payload.content,
      createdAt,
      ...(images.length > 0 ? { images } : {}),
      ...(payload.eventType ? { eventType: payload.eventType } : {})
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

const parseTimestampMs = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? -1 : parsed;
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
