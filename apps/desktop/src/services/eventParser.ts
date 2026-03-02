import type {
  ChatImageAttachment,
  ChatMessage,
  ChatRole,
  RpcNotification,
  ThreadTokenUsage,
  TokenUsageBreakdown
} from "../domain/types";

export interface ParsedMessageEvent {
  kind: "message";
  threadId: string;
  message: ChatMessage;
}

export type ParsedRpcEvent = ParsedMessageEvent;

export interface ParsedThreadTokenUsageEvent {
  threadId: string;
  turnId?: string;
  tokenUsage: ThreadTokenUsage;
}

export interface ParsedThreadModelEvent {
  threadId: string;
  model: string;
}

const normalizeMethod = (method: string): string => method.replaceAll(".", "/");

const activityKeywords = [
  "tool",
  "exec",
  "command",
  "shell",
  "patch",
  "edit",
  "diff",
  "search",
  "read",
  "write",
  "file",
  "run",
  "plan",
  "explore"
];

export const parseRpcNotification = (
  deviceId: string,
  notification: RpcNotification
): ParsedRpcEvent | null => {
  const method = normalizeMethod(notification.method);
  const params = asRecord(notification.params);
  const directThreadId = pickString(params, ["threadId", "thread_id"]);

  if (method.startsWith("message/")) {
    const messageRecord = asRecord(params?.message) ?? params;
    const threadId = directThreadId ?? pickString(messageRecord, ["threadId", "thread_id"]);
    if (!threadId || !messageRecord) {
      return null;
    }

    const role = inferRole(messageRecord);
    const payload = extractItemMessagePayload(messageRecord, method, role);
    if (!payload) {
      return null;
    }
    const images = extractImageAttachments(messageRecord);

    const createdAtRaw =
      pickString(messageRecord, [
        "completedAt",
        "completed_at",
        "createdAt",
        "created_at",
        "startedAt",
        "started_at",
        "updatedAt",
        "updated_at"
      ]) ?? new Date().toISOString();

    const createdAt = normalizeTimestamp(createdAtRaw) ?? new Date().toISOString();

    return {
      kind: "message",
      threadId,
      message: {
        id:
          pickString(messageRecord, ["id", "messageId", "itemId", "eventId"]) ??
          fallbackStreamMessageId({
            threadId,
            role,
            eventType: payload.eventType,
            method,
            params,
            record: messageRecord
          }),
        key: `${deviceId}::${threadId}`,
        threadId,
        deviceId,
        role,
        content: payload.content,
        createdAt,
        ...(images.length > 0 ? { images } : {}),
        ...(payload.eventType ? { eventType: payload.eventType } : {})
      }
    };
  }

  if (!method.startsWith("item/")) {
    if (!directThreadId || !isActivityMethod(method)) {
      return null;
    }

    const summary = summarizeActivity(params ?? {}, method) ?? `Activity: ${method}`;
    return {
      kind: "message",
      threadId: directThreadId,
      message: {
        id:
          pickString(params, ["id", "eventId", "turnId"]) ??
          `${directThreadId}-activity-${Date.now().toString(36)}-${method.replace("/", "-")}`,
        key: `${deviceId}::${directThreadId}`,
        threadId: directThreadId,
        deviceId,
        role: "tool",
        content: summary,
        createdAt: new Date().toISOString(),
        eventType: "activity"
      }
    };
  }

  const item = asRecord(params?.item) ?? asRecord(params);
  const threadId = directThreadId ?? pickString(item, ["threadId", "thread_id"]);
  if (!threadId || !item) {
    return null;
  }

  const role = inferRole(item);
  const payload = extractItemMessagePayload(item, method, role);
  if (!payload) {
    return null;
  }
  const isDeltaMethod = method.toLowerCase().includes("delta");
  if (isDeltaMethod) {
    return null;
  }
  const images = extractImageAttachments(item);

  const createdAtRaw =
    pickString(item, [
      "completedAt",
      "completed_at",
      "updatedAt",
      "updated_at",
      "createdAt",
      "created_at",
      "startedAt",
      "started_at"
    ]) ?? new Date().toISOString();

  const createdAt = normalizeTimestamp(createdAtRaw);
  if (!createdAt) {
    return null;
  }

  return {
    kind: "message",
    threadId,
    message: {
      id:
        pickString(item, ["id", "itemId", "eventId"]) ??
        fallbackStreamMessageId({
          threadId,
          role,
          eventType: payload.eventType,
          method,
          params,
          record: item
        }),
      key: `${deviceId}::${threadId}`,
      threadId,
      deviceId,
      role: role,
      content: payload.content,
      createdAt,
      ...(images.length > 0 ? { images } : {}),
      ...(payload.eventType ? { eventType: payload.eventType } : {})
    }
  };
};

export const parseThreadTokenUsageNotification = (
  notification: RpcNotification,
  fallbackThreadId?: string
): ParsedThreadTokenUsageEvent | null => {
  const params = notification.params;
  const tokenUsageRecord = findNestedTokenUsageContainer(params);
  if (!tokenUsageRecord) {
    return null;
  }
  const method = normalizeMethod(notification.method).toLowerCase();
  const eventTypeHint = normalizeEventType(
    pickStringDeep(params, ["type", "eventType", "event_type", "kind"]) ??
      pickStringDeep(params, ["msgType", "msg_type"])
  );

  const threadId =
    pickStringDeep(params, [
      "threadId",
      "thread_id",
      "sessionId",
      "session_id",
      "conversationId",
      "conversation_id"
    ]) ??
    pickStringFromNamedRecordDeep(params, ["thread", "session", "conversation"], [
      "id",
      "threadId",
      "thread_id",
      "sessionId",
      "session_id"
    ]) ??
    fallbackThreadId ??
    null;
  const paramsRecord = asRecord(params);
  const turnId =
    pickStringDeep(params, ["turnId", "turn_id", "taskId", "task_id"]) ??
    pickStringFromNamedRecordDeep(params, ["turn", "task"], [
      "id",
      "turnId",
      "turn_id",
      "taskId",
      "task_id"
    ]) ??
    ((methodMatches(method, "token_count", "token/count") ||
      eventTypeHint === "token_count")
      ? pickString(paramsRecord, ["id", "turnId", "turn_id"])
      : null) ??
    undefined;
  if (!threadId || !tokenUsageRecord) {
    return null;
  }

  const total =
    parseTokenUsageBreakdown(tokenUsageRecord.total) ??
    parseTokenUsageBreakdown(tokenUsageRecord.total_usage) ??
    parseTokenUsageBreakdown(tokenUsageRecord.totalTokenUsage) ??
    parseTokenUsageBreakdown(tokenUsageRecord.total_token_usage);
  const last =
    parseTokenUsageBreakdown(tokenUsageRecord.last) ??
    parseTokenUsageBreakdown(tokenUsageRecord.last_usage) ??
    parseTokenUsageBreakdown(tokenUsageRecord.lastTokenUsage) ??
    parseTokenUsageBreakdown(tokenUsageRecord.last_token_usage);

  if (!total && !last) {
    return null;
  }
  const normalizedTotal = total ?? last!;
  const normalizedLast = last ?? total!;

  const modelContextWindow =
    pickNumberDeep(tokenUsageRecord, [
      "modelContextWindow",
      "model_context_window",
      "modelContextWindowTokens",
      "model_context_window_tokens"
    ]) ??
    pickNumberDeep(params, [
      "modelContextWindow",
      "model_context_window",
      "modelContextWindowTokens",
      "model_context_window_tokens"
    ]) ??
    null;

  return {
    threadId,
    ...(turnId ? { turnId } : {}),
    tokenUsage: {
      total: normalizedTotal,
      last: normalizedLast,
      modelContextWindow
    }
  };
};

export const parseThreadModelNotification = (
  notification: RpcNotification
): ParsedThreadModelEvent | null => {
  const method = normalizeMethod(notification.method).toLowerCase();
  const params = asRecord(notification.params);
  if (!params) {
    return null;
  }

  const msgRecord = asRecord(params.msg);
  const eventTypeHint = normalizeEventType(
    pickString(params, ["type", "eventType", "event_type", "kind"]) ??
      pickString(msgRecord, ["type", "eventType", "event_type", "kind"])
  );

  if (
    methodMatches(method, "sessionconfigured", "session/configured", "session_configured") ||
    eventTypeHint === "session_configured"
  ) {
    const threadId =
      pickStringDeep(params, [
        "threadId",
        "thread_id",
        "sessionId",
        "session_id",
        "conversationId",
        "conversation_id"
      ]) ??
      pickStringDeep(msgRecord, [
        "threadId",
        "thread_id",
        "sessionId",
        "session_id",
        "conversationId",
        "conversation_id"
      ]);
    const model =
      pickStringDeep(params, ["model", "modelId", "model_id", "toModel", "to_model"]) ??
      pickStringDeep(msgRecord, ["model", "modelId", "model_id", "toModel", "to_model"]);
    if (threadId && model) {
      return { threadId, model };
    }
    return null;
  }

  if (
    methodMatches(method, "model/rerouted", "model/reroute", "model_reroute") ||
    eventTypeHint === "model_reroute"
  ) {
    const threadId =
      pickStringDeep(params, [
        "threadId",
        "thread_id",
        "sessionId",
        "session_id",
        "conversationId",
        "conversation_id"
      ]) ??
      pickStringDeep(msgRecord, [
        "threadId",
        "thread_id",
        "sessionId",
        "session_id",
        "conversationId",
        "conversation_id"
      ]);
    const model =
      pickStringDeep(params, ["toModel", "to_model", "model", "modelId", "model_id"]) ??
      pickStringDeep(msgRecord, ["toModel", "to_model", "model", "modelId", "model_id"]);
    if (threadId && model) {
      return { threadId, model };
    }
    return null;
  }

  const threadId =
    pickString(params, ["threadId", "thread_id", "sessionId", "session_id"]) ??
    pickString(params, ["conversationId", "conversation_id"]) ??
    pickString(msgRecord, ["threadId", "thread_id", "sessionId", "session_id"]) ??
    pickString(msgRecord, ["conversationId", "conversation_id"]) ??
    pickString(asRecord(params.turn), ["threadId", "thread_id", "sessionId", "session_id"]) ??
    pickString(asRecord(params.message), ["threadId", "thread_id", "sessionId", "session_id"]) ??
    pickString(asRecord(params.item), ["threadId", "thread_id", "sessionId", "session_id"]) ??
    pickString(asRecord(msgRecord?.turn), ["threadId", "thread_id", "sessionId", "session_id"]) ??
    pickString(asRecord(msgRecord?.message), [
      "threadId",
      "thread_id",
      "sessionId",
      "session_id"
    ]) ??
    pickString(asRecord(msgRecord?.item), ["threadId", "thread_id", "sessionId", "session_id"]);
  if (!threadId) {
    return null;
  }

  const model =
    pickString(params, ["toModel", "to_model", "model", "modelId", "model_id"]) ??
    pickString(msgRecord, ["toModel", "to_model", "model", "modelId", "model_id"]) ??
    pickString(asRecord(params.turn), ["toModel", "to_model", "model", "modelId", "model_id"]) ??
    pickString(asRecord(params.message), ["toModel", "to_model", "model", "modelId", "model_id"]) ??
    pickString(asRecord(params.item), ["toModel", "to_model", "model", "modelId", "model_id"]) ??
    pickString(asRecord(msgRecord?.turn), [
      "toModel",
      "to_model",
      "model",
      "modelId",
      "model_id"
    ]) ??
    pickString(asRecord(msgRecord?.message), [
      "toModel",
      "to_model",
      "model",
      "modelId",
      "model_id"
    ]) ??
    pickString(asRecord(msgRecord?.item), [
      "toModel",
      "to_model",
      "model",
      "modelId",
      "model_id"
    ]);
  if (!model) {
    return null;
  }

  return { threadId, model };
};

export const extractItemMessagePayload = (
  item: Record<string, unknown>,
  method: string,
  role: ChatRole
): { content: string; eventType?: ChatMessage["eventType"] } | null => {
  const rawContent = extractText(item);
  const preserveRawChunk = shouldPreserveRawChunk(method, role);
  const content = preserveRawChunk ? rawContent : rawContent.trim();
  const eventType = inferEventType(item, method, role);

  if (content.trim().length > 0) {
    return {
      content,
      ...(eventType ? { eventType } : {})
    };
  }

  const activitySummary = summarizeActivity(item, method);
  if (activitySummary) {
    return {
      content: activitySummary,
      eventType: "activity"
    };
  }

  return null;
};

export const extractText = (input: unknown): string => {
  if (typeof input === "string") {
    return input;
  }

  if (Array.isArray(input)) {
    const parts = input
      .map((entry) => extractText(entry).trim())
      .filter((entry) => entry.length > 0);
    return parts.join("\n").trim();
  }

  const record = asRecord(input);
  if (!record) {
    return "";
  }

  const directFields = [
    "text",
    "delta",
    "content",
    "outputText",
    "message",
    "value",
    "summary"
  ];
  for (const key of directFields) {
    if (key in record) {
      const value = extractText(record[key]);
      if (value.trim().length > 0) {
        return value;
      }
    }
  }

  if ("parts" in record) {
    const value = extractText(record.parts);
    if (value.trim().length > 0) {
      return value;
    }
  }

  return "";
};

export const extractImageAttachments = (input: unknown): ChatImageAttachment[] => {
  const attachments: ChatImageAttachment[] = [];
  const seenUrls = new Set<string>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }

    const record = asRecord(value);
    if (!record) {
      return;
    }

    const imageUrl = extractImageUrlFromRecord(record);
    if (imageUrl) {
      const normalized = imageUrl.trim();
      if (normalized.length > 0 && !seenUrls.has(normalized)) {
        seenUrls.add(normalized);
        attachments.push({
          id: `image-${attachments.length + 1}`,
          url: normalized,
          mimeType:
            pickString(record, [
              "mimeType",
              "mime_type",
              "mediaType",
              "media_type"
            ]) ?? inferMimeTypeFromDataUrl(normalized) ?? undefined,
          fileName: pickString(record, ["fileName", "filename", "name"]) ?? undefined
        });
      }
    }

    for (const nested of Object.values(record)) {
      if (typeof nested === "object" && nested !== null) {
        visit(nested);
      }
    }
  };

  visit(input);
  return attachments;
};

const extractImageUrlFromRecord = (
  value: Record<string, unknown>
): string | null => {
  const imageUrl =
    extractImageUrlValue(value.image_url) ??
    extractImageUrlValue(value.imageUrl) ??
    extractImageUrlValue(value.image);
  if (imageUrl && isSupportedImageUrl(imageUrl)) {
    return imageUrl;
  }

  const typeHint = (pickString(value, ["type", "itemType", "kind"]) ?? "").toLowerCase();
  if (!typeHint.includes("image")) {
    return null;
  }

  const fallback =
    extractImageUrlValue(value.url) ??
    extractImageUrlValue(value.source) ??
    extractImageUrlValue(value.data);
  if (fallback && isSupportedImageUrl(fallback)) {
    return fallback;
  }

  return null;
};

const extractImageUrlValue = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const nested = record.url;
  if (typeof nested === "string") {
    return nested;
  }
  return null;
};

const isSupportedImageUrl = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("data:image/") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("http://")
  );
};

const inferMimeTypeFromDataUrl = (value: string): string | null => {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);/i);
  return match?.[1]?.toLowerCase() ?? null;
};

const inferRole = (item: Record<string, unknown>): ChatRole => {
  const role = pickString(item, ["role", "author"]);
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") {
    return role;
  }

  const itemType = (pickString(item, ["type", "itemType"]) ?? "").toLowerCase();
  if (itemType.includes("user")) {
    return "user";
  }
  if (itemType.includes("assistant") || itemType.includes("agent")) {
    return "assistant";
  }
  if (itemType.includes("tool")) {
    return "tool";
  }
  return "system";
};

const inferEventType = (
  item: Record<string, unknown>,
  method: string,
  role: ChatRole
): ChatMessage["eventType"] => {
  const normalizedMethod = method.toLowerCase();
  const methodForClassification = isSyntheticReadMethod(normalizedMethod)
    ? ""
    : normalizedMethod;
  const itemType = (
    pickString(item, ["type", "itemType", "name", "status", "action", "kind"]) ?? ""
  ).toLowerCase();
  const signal = `${itemType} ${methodForClassification}`;

  if (
    signal.includes("reasoning") ||
    signal.includes("analysis") ||
    signal.includes("thinking")
  ) {
    return "reasoning";
  }

  if (role === "tool" || activityKeywords.some((keyword) => signal.includes(keyword))) {
    return "activity";
  }

  if (
    pickString(item, ["command", "cmd", "path", "file", "filePath", "cwd", "workdir"]) !==
    null
  ) {
    return "activity";
  }

  return undefined;
};

const summarizeActivity = (
  item: Record<string, unknown>,
  method: string
): string | null => {
  const methodLower = method.toLowerCase();
  const methodForClassification = isSyntheticReadMethod(methodLower) ? "" : methodLower;
  const kind = (
    pickString(item, ["type", "itemType", "action", "kind", "name", "status"]) ?? ""
  ).toLowerCase();
  const signal = `${kind} ${methodForClassification}`;
  const isActivity =
    activityKeywords.some((keyword) => signal.includes(keyword)) ||
    pickString(item, ["command", "cmd", "path", "file", "filePath", "cwd", "workdir"]) !== null;

  if (!isActivity) {
    return null;
  }

  const command =
    pickString(item, ["cmd", "command", "shellCommand", "shell_command"]) ??
    pickString(asRecord(item.input), ["cmd", "command", "shellCommand", "shell_command"]);
  const path =
    pickString(item, ["path", "file", "filePath", "target", "cwd", "workdir", "workingDirectory"]) ??
    pickString(asRecord(item.input), [
      "path",
      "file",
      "filePath",
      "target",
      "cwd",
      "workdir",
      "workingDirectory"
    ]);
  const tool =
    pickString(item, ["toolName", "tool", "name"]) ??
    pickString(asRecord(item.input), ["toolName", "tool", "name"]);
  const added = pickNumber(item, ["additions", "added", "insertions", "linesAdded", "addedLines"]);
  const removed = pickNumber(item, ["deletions", "removed", "linesRemoved", "removedLines"]);

  let title = "Activity";
  if (signal.includes("search") || signal.includes("read")) {
    title = "Explored";
  } else if (signal.includes("edit") || signal.includes("patch") || signal.includes("write") || signal.includes("diff")) {
    title = "Edited";
  } else if (signal.includes("command") || signal.includes("exec") || signal.includes("shell") || signal.includes("run")) {
    title = "Ran";
  } else if (signal.includes("plan")) {
    title = "Planned";
  }

  const lines = [title];
  if (command) {
    lines.push(`Command: \`${truncate(command, 180)}\``);
  }
  if (path) {
    lines.push(`Path: \`${truncate(path, 140)}\``);
  }
  if (tool) {
    lines.push(`Tool: ${truncate(tool, 80)}`);
  }
  if (added !== null || removed !== null) {
    lines.push(`Changes: +${added ?? 0} -${removed ?? 0}`);
  }

  if (lines.length === 1) {
    lines.push(`Event: ${method}`);
  }

  return lines.join("\n");
};

const isActivityMethod = (method: string): boolean => {
  const normalized = method.toLowerCase();
  if (normalized.startsWith("turn/") || normalized.startsWith("thread/")) {
    return false;
  }
  return activityKeywords.some((keyword) => normalized.includes(keyword));
};

const isSyntheticReadMethod = (method: string): boolean =>
  method === "message/read" || method === "item/read";

const shouldPreserveRawChunk = (method: string, role: ChatRole): boolean => {
  const normalized = method.toLowerCase();
  return normalized.includes("delta") && role !== "user";
};

const fallbackStreamMessageId = (params: {
  threadId: string;
  role: ChatRole;
  eventType?: ChatMessage["eventType"];
  method: string;
  params: Record<string, unknown> | null;
  record: Record<string, unknown>;
}): string => {
  const turnId = extractTurnId(params.params, params.record);
  const streamKind =
    pickString(params.record, ["type", "itemType", "kind", "name"]) ??
    pickString(asRecord(params.record.item), ["type", "itemType", "kind", "name"]) ??
    "stream";

  if (turnId) {
    return [
      params.threadId,
      turnId,
      params.role,
      params.eventType ?? "message",
      params.method.replaceAll("/", "-"),
      streamKind
    ].join("::");
  }

  return `${params.threadId}-${params.role}-${Date.now().toString(36)}-${params.method.replace("/", "-")}`;
};

const extractTurnId = (
  params: Record<string, unknown> | null,
  record: Record<string, unknown>
): string | null => {
  const paramTurn = asRecord(params?.turn);
  const recordTurn = asRecord(record.turn);
  return (
    pickString(record, ["turnId", "turn_id"]) ??
    pickString(recordTurn, ["id", "turnId", "turn_id"]) ??
    pickString(params, ["turnId", "turn_id"]) ??
    pickString(paramTurn, ["id", "turnId", "turn_id"])
  );
};

const normalizeTimestamp = (value: string): string | null => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
};

const methodMatches = (method: string, ...candidates: string[]): boolean =>
  candidates.some((candidate) => method === candidate || method.endsWith(`/${candidate}`));

const normalizeEventType = (value: string | null | undefined): string => {
  if (!value) {
    return "";
  }
  return value.trim().toLowerCase().replaceAll("/", "_").replaceAll(".", "_");
};

const parseTokenUsageBreakdown = (value: unknown): TokenUsageBreakdown | null => {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const totalTokensRaw = pickNumber(record, ["totalTokens", "total_tokens"]);
  const inputTokensRaw = pickNumber(record, ["inputTokens", "input_tokens"]);
  const cachedInputTokensRaw = pickNumber(record, ["cachedInputTokens", "cached_input_tokens"]);
  const outputTokensRaw = pickNumber(record, ["outputTokens", "output_tokens"]);
  const reasoningOutputTokensRaw = pickNumber(record, [
    "reasoningOutputTokens",
    "reasoning_output_tokens"
  ]);
  const hasAnyField =
    totalTokensRaw !== null ||
    inputTokensRaw !== null ||
    cachedInputTokensRaw !== null ||
    outputTokensRaw !== null ||
    reasoningOutputTokensRaw !== null;
  if (!hasAnyField) {
    return null;
  }

  const inputTokens = Math.max(inputTokensRaw ?? 0, 0);
  const cachedInputTokens = Math.max(cachedInputTokensRaw ?? 0, 0);
  const outputTokens = Math.max(outputTokensRaw ?? 0, 0);
  const reasoningOutputTokens = Math.max(reasoningOutputTokensRaw ?? 0, 0);
  const totalTokens = Math.max(totalTokensRaw ?? inputTokens + outputTokens, 0);

  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens
  };
};

const findNestedTokenUsageContainer = (
  input: unknown,
  depth = 0
): Record<string, unknown> | null => {
  if (depth > 5) {
    return null;
  }

  const record = asRecord(input);
  if (record) {
    if (isTokenUsageContainer(record)) {
      return record;
    }

    const priorityKeys = [
      "tokenUsage",
      "token_usage",
      "usage",
      "info",
      "event",
      "payload",
      "data"
    ];
    for (const key of priorityKeys) {
      if (!(key in record)) {
        continue;
      }
      const nested = findNestedTokenUsageContainer(record[key], depth + 1);
      if (nested) {
        return nested;
      }
    }

    for (const nested of Object.values(record)) {
      const found = findNestedTokenUsageContainer(nested, depth + 1);
      if (found) {
        return found;
      }
    }
  }

  if (Array.isArray(input)) {
    for (const entry of input) {
      const nested = findNestedTokenUsageContainer(entry, depth + 1);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
};

const isTokenUsageContainer = (record: Record<string, unknown>): boolean => {
  if (parseTokenUsageBreakdown(record) !== null) {
    return true;
  }

  const totalCandidate =
    parseTokenUsageBreakdown(record.total) ??
    parseTokenUsageBreakdown(record.total_usage) ??
    parseTokenUsageBreakdown(record.totalTokenUsage) ??
    parseTokenUsageBreakdown(record.total_token_usage);
  const lastCandidate =
    parseTokenUsageBreakdown(record.last) ??
    parseTokenUsageBreakdown(record.last_usage) ??
    parseTokenUsageBreakdown(record.lastTokenUsage) ??
    parseTokenUsageBreakdown(record.last_token_usage);

  return totalCandidate !== null || lastCandidate !== null;
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

const pickStringDeep = (
  input: unknown,
  keys: string[],
  depth = 0
): string | null => {
  if (depth > 5) {
    return null;
  }

  const record = asRecord(input);
  if (record) {
    const direct = pickString(record, keys);
    if (direct) {
      return direct;
    }
    for (const nested of Object.values(record)) {
      const found = pickStringDeep(nested, keys, depth + 1);
      if (found) {
        return found;
      }
    }
  }

  if (Array.isArray(input)) {
    for (const entry of input) {
      const found = pickStringDeep(entry, keys, depth + 1);
      if (found) {
        return found;
      }
    }
  }

  return null;
};

const pickStringFromNamedRecordDeep = (
  input: unknown,
  recordKeys: string[],
  valueKeys: string[],
  depth = 0
): string | null => {
  if (depth > 5) {
    return null;
  }

  const record = asRecord(input);
  if (record) {
    for (const recordKey of recordKeys) {
      const nestedRecord = asRecord(record[recordKey]);
      const candidate = pickString(nestedRecord, valueKeys);
      if (candidate) {
        return candidate;
      }
      const nestedCandidate = pickStringFromNamedRecordDeep(
        nestedRecord,
        recordKeys,
        valueKeys,
        depth + 1
      );
      if (nestedCandidate) {
        return nestedCandidate;
      }
    }

    for (const nested of Object.values(record)) {
      const candidate = pickStringFromNamedRecordDeep(
        nested,
        recordKeys,
        valueKeys,
        depth + 1
      );
      if (candidate) {
        return candidate;
      }
    }
  }

  if (Array.isArray(input)) {
    for (const entry of input) {
      const candidate = pickStringFromNamedRecordDeep(
        entry,
        recordKeys,
        valueKeys,
        depth + 1
      );
      if (candidate) {
        return candidate;
      }
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

const pickNumberDeep = (
  input: unknown,
  keys: string[],
  depth = 0
): number | null => {
  if (depth > 5) {
    return null;
  }

  const record = asRecord(input);
  if (record) {
    const direct = pickNumber(record, keys);
    if (direct !== null) {
      return direct;
    }
    for (const nested of Object.values(record)) {
      const found = pickNumberDeep(nested, keys, depth + 1);
      if (found !== null) {
        return found;
      }
    }
  }

  if (Array.isArray(input)) {
    for (const entry of input) {
      const found = pickNumberDeep(entry, keys, depth + 1);
      if (found !== null) {
        return found;
      }
    }
  }

  return null;
};

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
