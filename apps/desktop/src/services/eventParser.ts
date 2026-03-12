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

export interface ExtractedMessagePayload {
  content: string;
  eventType?: ChatMessage["eventType"];
  toolCall?: ChatMessage["toolCall"];
}

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

const structuredToolKeywords = [
  "tool",
  "exec",
  "command",
  "shell",
  "patch",
  "search",
  "read",
  "write",
  "file",
  "diff",
  "stdin"
];

export const parseRpcNotification = (
  deviceId: string,
  notification: RpcNotification
): ParsedRpcEvent | null => {
  const method = normalizeMethod(notification.method);
  const params = asRecord(notification.params);
  const directThreadId = pickString(params, [
    "threadId",
    "thread_id",
    "conversationId",
    "conversation_id",
    "sessionId",
    "session_id"
  ]);

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
      pickNotificationTimestamp(messageRecord, params) ?? new Date().toISOString();

    const createdAt = normalizeTimestamp(createdAtRaw) ?? new Date().toISOString();

    return {
      kind: "message",
      threadId,
      message: {
        id: toTimelineMessageId({
          baseId:
            pickString(messageRecord, ["id", "messageId", "itemId", "eventId"]) ??
            buildStableMessageId({
              threadId,
              role,
              eventType: payload.eventType,
              method,
              createdAt,
              record: messageRecord,
              payload,
              turnId: extractTurnId(params, messageRecord)
            }),
          eventType: payload.eventType,
          createdAt
        }),
        key: `${deviceId}::${threadId}`,
        threadId,
        deviceId,
        role,
        content: payload.content,
        createdAt,
        chronologySource: "live",
        ...(images.length > 0 ? { images } : {}),
        ...(payload.eventType ? { eventType: payload.eventType } : {}),
        ...(payload.toolCall ? { toolCall: payload.toolCall } : {})
      }
    };
  }

  if (!method.startsWith("item/")) {
    const rawActivityRecord = asRecord(params?.msg) ?? params;
    const wrappedPayloadRecord = asRecord(rawActivityRecord?.payload);
    const activityRecord =
      pickString(rawActivityRecord, ["type"]) === "response_item" && wrappedPayloadRecord
        ? wrappedPayloadRecord
        : rawActivityRecord;
    const activityThreadId =
      directThreadId ??
      pickString(rawActivityRecord, [
        "threadId",
        "thread_id",
        "sessionId",
        "session_id",
        "conversationId",
        "conversation_id"
      ]) ??
      pickString(activityRecord, [
        "threadId",
        "thread_id",
        "sessionId",
        "session_id",
        "conversationId",
        "conversation_id"
      ]);
    if (!activityThreadId || !activityRecord) {
      return null;
    }

    const activityTypeHint = (
      pickString(activityRecord, ["type", "itemType", "kind"]) ?? ""
    ).toLowerCase();
    const inferredActivityRole: ChatRole =
      activityTypeHint.includes("function_call") ||
      activityTypeHint.includes("tool_call") ||
      activityTypeHint.includes("custom_tool") ||
      (pickString(activityRecord, ["call_id", "callId"]) !== null &&
        pickString(activityRecord, ["name"]) !== null)
        ? "tool"
        : inferRole(activityRecord);
    const activityPayload = extractItemMessagePayload(
      activityRecord,
      method,
      inferredActivityRole
    );
    if (!activityPayload) {
      return null;
    }
    if (!isActivityMethod(method) && !activityPayload.toolCall) {
      return null;
    }

    const createdAtFallbackAllowed =
      method !== "codex/event" && !method.startsWith("codex/event/");
    const createdAt =
      pickNotificationTimestamp(activityRecord, rawActivityRecord, params) ??
      (createdAtFallbackAllowed ? new Date().toISOString() : null);
    if (!createdAt) {
      return null;
    }
    const baseId =
      pickString(activityRecord, [
        "id",
        "itemId",
        "eventId",
        "event_id",
        "call_id",
        "callId",
        "turnId",
        "turn_id"
      ]) ??
      pickString(rawActivityRecord, [
        "id",
        "itemId",
        "eventId",
        "event_id",
        "call_id",
        "callId",
        "turnId",
        "turn_id"
      ]) ??
      pickString(params, ["id", "eventId", "turnId"]) ??
      buildStableMessageId({
        threadId: activityThreadId,
        role: activityPayload.toolCall ? "tool" : "system",
        eventType: activityPayload.eventType,
        method,
        createdAt,
        record: activityRecord,
        payload: activityPayload
      });

    return {
      kind: "message",
      threadId: activityThreadId,
      message: {
        id: toTimelineMessageId({
          baseId,
          eventType: activityPayload.eventType,
          createdAt
        }),
        key: `${deviceId}::${activityThreadId}`,
        threadId: activityThreadId,
        deviceId,
        role: activityPayload.toolCall ? "tool" : "system",
        content: activityPayload.content,
        createdAt,
        chronologySource: "live",
        ...(activityPayload.eventType ? { eventType: activityPayload.eventType } : {}),
        ...(activityPayload.toolCall ? { toolCall: activityPayload.toolCall } : {})
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
    pickNotificationTimestamp(item, params) ?? new Date().toISOString();

  const createdAt = normalizeTimestamp(createdAtRaw);
  if (!createdAt) {
    return null;
  }

  return {
    kind: "message",
    threadId,
    message: {
      id: toTimelineMessageId({
        baseId:
          pickString(item, ["id", "itemId", "eventId"]) ??
          buildStableMessageId({
            threadId,
            role,
            eventType: payload.eventType,
            method,
            createdAt,
            record: item,
            payload,
            turnId: extractTurnId(params, item)
          }),
        eventType: payload.eventType,
        createdAt
      }),
      key: `${deviceId}::${threadId}`,
      threadId,
      deviceId,
      role: role,
      content: payload.content,
      createdAt,
      chronologySource: "live",
      ...(images.length > 0 ? { images } : {}),
      ...(payload.eventType ? { eventType: payload.eventType } : {}),
      ...(payload.toolCall ? { toolCall: payload.toolCall } : {})
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
): ExtractedMessagePayload | null => {
  const rawContent = extractText(item);
  const preserveRawChunk = shouldPreserveRawChunk(method, role);
  const content = preserveRawChunk ? rawContent : rawContent.trim();
  const declaredToolCall = extractDeclaredToolCall(item);
  const toolCall = declaredToolCall ?? extractStructuredToolCall(item, method, role, content);
  const declaredEventType = pickString(item, ["eventType"]);
  const normalizedDeclaredEventType =
    declaredEventType === "reasoning" ||
    declaredEventType === "activity" ||
    declaredEventType === "tool_call"
      ? declaredEventType
      : undefined;
  const eventType = toolCall
    ? "tool_call"
    : normalizedDeclaredEventType ?? inferEventType(item, method, role);

  if (toolCall) {
    return {
      content: buildToolCallContent(toolCall, content),
      eventType,
      toolCall
    };
  }

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

const pickNotificationTimestamp = (
  ...records: Array<Record<string, unknown> | null | undefined>
): string | null => {
  const fieldPriority = [
    ["completedAt", "completed_at"],
    ["updatedAt", "updated_at"],
    ["timestamp"],
    ["createdAt", "created_at"],
    ["startedAt", "started_at"]
  ];

  for (const keys of fieldPriority) {
    for (const record of records) {
      const timestamp = pickString(record ?? null, keys) ?? null;
      if (!timestamp) {
        continue;
      }
      const normalized = normalizeTimestamp(timestamp);
      if (normalized) {
        return normalized;
      }
    }
  }

  return null;
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

const extractWebSearchToolCall = (
  item: Record<string, unknown>
): ChatMessage["toolCall"] | undefined => {
  const typeHint = (pickString(item, ["type", "itemType", "kind"]) ?? "").toLowerCase();
  if (typeHint !== "web_search_call") {
    return undefined;
  }

  const input = formatWebSearchActionInput(item.action);
  const status = inferToolCallStatus(item, "web_search_call", null) ?? "completed";

  return {
    name: "web_search",
    ...(input ? { input } : {}),
    status
  };
};

const formatWebSearchActionInput = (value: unknown): string | undefined => {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const type = pickString(record, ["type"]) ?? "search";
  const query = pickString(record, ["query"]);
  const url = pickString(record, ["url"]);
  const pattern = pickString(record, ["pattern"]);
  const queries = Array.isArray(record.queries)
    ? record.queries
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

  return (
    stringifyJson({
      type,
      ...(query ? { query } : {}),
      ...(url ? { url } : {}),
      ...(pattern ? { pattern } : {}),
      ...(queries.length > 0 ? { queries } : {})
    }) ?? undefined
  );
};

const extractDeclaredToolCall = (
  item: Record<string, unknown>
): ChatMessage["toolCall"] | undefined => {
  const record = asRecord(item.toolCall);
  if (!record) {
    return undefined;
  }

  const name =
    pickString(record, ["name", "toolName", "tool_name"]) ??
    pickString(item, ["name", "toolName", "tool_name"]) ??
    "tool";
  const input =
    (typeof record.input === "string" ? record.input : null) ??
    formatToolPayload(record.input, { preferCommand: true }) ??
    undefined;
  const output =
    (typeof record.output === "string" ? record.output : null) ??
    formatToolOutputPayload(record.output) ??
    undefined;
  const status = normalizeToolCallStatus(
    pickString(record, ["status", "state"]) ?? undefined
  );

  return {
    name,
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
    ...(status ? { status } : {})
  };
};

const extractStructuredToolCall = (
  item: Record<string, unknown>,
  method: string,
  role: ChatRole,
  content: string
): ChatMessage["toolCall"] | undefined => {
  const webSearchToolCall = extractWebSearchToolCall(item);
  if (webSearchToolCall) {
    return webSearchToolCall;
  }

  const methodLower = method.toLowerCase();
  const explicitName = pickToolName(item, methodLower, role, false);
  const input = extractToolInput(item);
  const output = extractToolOutput(item, content, input);
  const methodSignalsTool =
    !isSyntheticReadMethod(methodLower) &&
    structuredToolKeywords.some((keyword) => methodLower.includes(keyword));
  const hasToolPayloadFields = hasDirectToolPayload(item);
  const hasExecutionResultFields = hasExecutionMetadata(item);
  const hasInvocationEvidence =
    role === "tool" ||
    explicitName !== null ||
    methodSignalsTool ||
    hasToolPayloadFields ||
    hasExecutionResultFields;

  if (!hasInvocationEvidence) {
    return undefined;
  }

  if (!explicitName && !input && !output) {
    return undefined;
  }

  const name = explicitName ?? pickToolName(item, methodLower, role, true);
  const status = inferToolCallStatus(item, methodLower, output);

  return {
    name: name ?? "tool",
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
    ...(status ? { status } : {})
  };
};

const pickToolName = (
  item: Record<string, unknown>,
  normalizedMethod: string,
  role: ChatRole,
  allowMethodFallback: boolean
): string | null => {
  const nestedInput = asRecord(item.input);
  const nestedArgs = asRecord(item.args);
  const nestedArguments = asRecord(item.arguments);

  const direct =
    pickString(item, ["toolName", "tool_name", "tool"]) ??
    pickString(nestedInput, ["toolName", "tool_name", "tool"]) ??
    pickString(nestedArgs, ["toolName", "tool_name", "tool"]) ??
    pickString(nestedArguments, ["toolName", "tool_name", "tool"]) ??
    (role === "tool"
      ? pickString(item, ["name"]) ??
        pickString(nestedInput, ["name"]) ??
        pickString(nestedArgs, ["name"]) ??
        pickString(nestedArguments, ["name"])
      : null);
  if (direct) {
    return direct;
  }

  const typeHint = (
    pickString(item, ["type", "itemType", "kind", "action"]) ?? ""
  ).trim();
  if (
    typeHint.length > 0 &&
    (role === "tool" || isStrongToolTypeHint(typeHint))
  ) {
    return typeHint;
  }

  if (!allowMethodFallback) {
    return null;
  }

  const methodSegments = normalizedMethod.split("/").filter((segment) => segment.length > 0);
  if (methodSegments.length === 0) {
    return null;
  }
  return methodSegments.join("_");
};

const isStrongToolTypeHint = (value: string): boolean => {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("tool") ||
    normalized.includes("exec") ||
    normalized.includes("command") ||
    normalized.includes("patch") ||
    normalized.includes("search") ||
    normalized.includes("write") ||
    normalized.includes("diff") ||
    normalized.includes("stdin")
  );
};

const hasDirectToolPayload = (item: Record<string, unknown>): boolean => {
  if (
    pickString(item, [
      "cmd",
      "command",
      "shellCommand",
      "shell_command",
      "patch",
      "diff",
      "chars",
      "cwd",
      "workdir",
      "workingDirectory",
      "path",
      "file",
      "filePath",
      "file_path"
    ]) !== null
  ) {
    return true;
  }

  const nestedInput = asRecord(item.input);
  const nestedArgs = asRecord(item.args);
  const nestedArguments = asRecord(item.arguments);
  return [nestedInput, nestedArgs, nestedArguments].some(
    (record) =>
      record !== null &&
      pickString(record, [
        "cmd",
        "command",
        "shellCommand",
        "shell_command",
        "patch",
        "diff",
        "chars",
        "cwd",
        "workdir",
        "workingDirectory",
        "path",
        "file",
        "filePath",
        "file_path"
      ]) !== null
  );
};

const hasExecutionMetadata = (item: Record<string, unknown>): boolean => {
  if (
    pickString(item, ["stdout", "stderr", "chunkId", "chunk_id"]) !== null ||
    pickNumber(item, [
      "exitCode",
      "exit_code",
      "code",
      "wallTime",
      "wall_time",
      "wallTimeSeconds",
      "wall_time_seconds",
      "originalTokenCount",
      "original_token_count"
    ]) !== null
  ) {
    return true;
  }

  const nestedOutput =
    asRecord(item.output) ?? asRecord(item.result) ?? asRecord(item.response);
  if (!nestedOutput) {
    return false;
  }

  return (
    pickString(nestedOutput, ["stdout", "stderr", "chunkId", "chunk_id"]) !== null ||
    pickNumber(nestedOutput, [
      "exitCode",
      "exit_code",
      "code",
      "wallTime",
      "wall_time",
      "wallTimeSeconds",
      "wall_time_seconds",
      "originalTokenCount",
      "original_token_count"
    ]) !== null
  );
};

const extractToolInput = (item: Record<string, unknown>): string | null => {
  const directValue =
    item.input ??
    item.args ??
    item.arguments ??
    item.payload ??
    item.request ??
    item.parameters;
  const formattedDirect = formatToolPayload(directValue, { preferCommand: true });
  if (formattedDirect) {
    return formattedDirect;
  }

  const command = pickString(item, ["cmd", "command", "shellCommand", "shell_command"]);
  if (command) {
    return command;
  }

  const patch = pickString(item, ["patch", "diff"]);
  if (patch) {
    return patch;
  }

  const chars = pickString(item, ["chars"]);
  if (chars) {
    return chars;
  }

  const cleaned = cleanToolRecord(item, [
    "threadId",
    "thread_id",
    "id",
    "eventId",
    "event_id",
    "messageId",
    "message_id",
    "itemId",
    "item_id",
    "call_id",
    "callId",
    "turnId",
    "turn_id",
    "role",
    "author",
    "name",
    "toolName",
    "tool_name",
    "type",
    "itemType",
    "status",
    "state",
    "kind",
    "action",
    "createdAt",
    "created_at",
    "updatedAt",
    "updated_at",
    "startedAt",
    "started_at",
    "completedAt",
    "completed_at",
    "output",
    "result",
    "response",
    "stdout",
    "stderr",
    "content",
    "text",
    "delta",
    "summary"
  ]);
  return stringifyJson(cleaned);
};

const extractToolOutput = (
  item: Record<string, unknown>,
  content: string,
  input: string | null
): string | null => {
  const directValue = item.output ?? item.result ?? item.response;
  const formattedDirect = formatToolOutputPayload(directValue);
  if (formattedDirect) {
    return formattedDirect;
  }

  const formattedExecution = formatExecutionOutput(item);
  if (formattedExecution) {
    return formattedExecution;
  }

  const normalizedContent = content.trim();
  if (
    normalizedContent.length > 0 &&
    (!input || normalizeText(normalizedContent) !== normalizeText(input))
  ) {
    return normalizedContent;
  }

  return null;
};

const inferToolCallStatus = (
  item: Record<string, unknown>,
  methodLower: string,
  output: string | null
): "running" | "completed" | "failed" | undefined => {
  const rawStatus =
    (
      pickString(item, ["status", "state", "phase", "result"]) ??
      (methodLower.includes("failed")
        ? "failed"
        : methodLower.includes("completed")
          ? "completed"
          : methodLower.includes("started")
            ? "running"
            : null)
    )?.toLowerCase() ?? null;

  if (!rawStatus) {
    return output ? "completed" : undefined;
  }
  if (
    rawStatus.includes("fail") ||
    rawStatus.includes("error") ||
    rawStatus.includes("reject")
  ) {
    return "failed";
  }
  if (
    rawStatus.includes("complete") ||
    rawStatus.includes("success") ||
    rawStatus.includes("done")
  ) {
    return "completed";
  }
  if (
    rawStatus.includes("start") ||
    rawStatus.includes("run") ||
    rawStatus.includes("progress") ||
    rawStatus.includes("pending")
  ) {
    return "running";
  }
  return output ? "completed" : undefined;
};

const normalizeToolCallStatus = (
  value: string | undefined
): "running" | "completed" | "failed" | undefined => {
  if (!value) {
    return undefined;
  }

  const normalized = value.toLowerCase();
  if (
    normalized.includes("fail") ||
    normalized.includes("error") ||
    normalized.includes("reject")
  ) {
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
    normalized.includes("start") ||
    normalized.includes("run") ||
    normalized.includes("progress") ||
    normalized.includes("pending")
  ) {
    return "running";
  }
  return undefined;
};

const buildToolCallContent = (
  toolCall: NonNullable<ChatMessage["toolCall"]>,
  content: string
): string => {
  const parts = [`Tool: ${toolCall.name}`];
  if (toolCall.input) {
    parts.push(`Input:\n${toolCall.input}`);
  }
  if (toolCall.output) {
    parts.push(`Output:\n${toolCall.output}`);
  } else if (content.trim().length > 0 && normalizeText(content) !== normalizeText(toolCall.input ?? "")) {
    parts.push(content.trim());
  }
  return parts.join("\n\n");
};

const formatToolOutputPayload = (value: unknown): string | null => {
  const executionLike = formatExecutionOutput(value);
  if (executionLike) {
    return executionLike;
  }
  return formatToolPayload(value, { preferCommand: false });
};

const formatExecutionOutput = (value: unknown): string | null => {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const chunkId = pickStringDeep(record, ["chunkId", "chunk_id"]);
  const wallTime = pickNumberDeep(record, [
    "wallTime",
    "wall_time",
    "wallTimeSeconds",
    "wall_time_seconds",
    "durationSeconds",
    "duration_seconds"
  ]);
  const exitCode = pickNumberDeep(record, ["exitCode", "exit_code", "code"]);
  const originalTokenCount = pickNumberDeep(record, [
    "originalTokenCount",
    "original_token_count"
  ]);
  const outputText =
    combineOutputStreams(record) ??
    formatToolPayload(record.output, { preferCommand: false }) ??
    formatToolPayload(record.result, { preferCommand: false }) ??
    formatToolPayload(record.response, { preferCommand: false });

  const lines: string[] = [];
  if (chunkId) {
    lines.push(`Chunk ID: ${chunkId}`);
  }
  if (wallTime !== null) {
    lines.push(`Wall time: ${wallTime} seconds`);
  }
  if (exitCode !== null) {
    lines.push(`Process exited with code ${exitCode}`);
  }
  if (originalTokenCount !== null) {
    lines.push(`Original token count: ${originalTokenCount}`);
  }
  if (outputText) {
    if (lines.length > 0) {
      lines.push("Output:");
    }
    lines.push(outputText);
  }

  return lines.length > 0 ? lines.join("\n") : null;
};

const combineOutputStreams = (record: Record<string, unknown>): string | null => {
  const stdout = pickString(record, ["stdout"]);
  const stderr = pickString(record, ["stderr"]);
  const output = pickString(record, ["output"]);

  const parts = [stdout, stderr, output]
    .map((part) => (typeof part === "string" ? sanitizeExecutionText(part) : null))
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
};

const sanitizeExecutionText = (value: string): string =>
  value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const formatToolPayload = (
  value: unknown,
  options: { preferCommand: boolean }
): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const sanitized = sanitizeExecutionText(value);
    return sanitized.length > 0 ? sanitized : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const text = extractText(value).trim();
    if (text.length > 0) {
      return text;
    }
    return stringifyJson(value);
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  if (options.preferCommand) {
    const command = pickStringDeep(record, [
      "cmd",
      "command",
      "shellCommand",
      "shell_command"
    ]);
    if (command) {
      return command;
    }
  }

  const patch = pickString(record, ["patch", "diff"]);
  if (patch) {
    return patch;
  }

  const chars = pickString(record, ["chars"]);
  if (chars) {
    return chars;
  }

  const text = extractText(record).trim();
  if (text.length > 0) {
    return text;
  }

  return stringifyJson(record);
};

const cleanToolRecord = (
  record: Record<string, unknown>,
  excludedKeys: string[]
): Record<string, unknown> | null => {
  const excluded = new Set(excludedKeys);
  const cleanedEntries = Object.entries(record).filter(([key, value]) => {
    if (excluded.has(key)) {
      return false;
    }
    if (value === null || value === undefined) {
      return false;
    }
    if (typeof value === "string" && value.trim().length === 0) {
      return false;
    }
    return true;
  });

  if (cleanedEntries.length === 0) {
    return null;
  }

  return Object.fromEntries(cleanedEntries);
};

const stringifyJson = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized && serialized !== "{}" && serialized !== "[]"
      ? serialized
      : null;
  } catch {
    return null;
  }
};

const normalizeText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

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

export const buildStableMessageId = (params: {
  threadId: string;
  role: ChatRole;
  eventType?: ChatMessage["eventType"];
  method: string;
  createdAt: string;
  record: Record<string, unknown>;
  payload: ExtractedMessagePayload;
  turnId?: string | null;
}): string => {
  const resolvedTurnId = params.turnId ?? extractTurnId(null, params.record);
  const fingerprintSource = params.payload.toolCall
    ? [
        params.payload.toolCall.name,
        params.payload.toolCall.input ?? "",
        params.payload.toolCall.output ?? ""
      ].join(" ")
    : params.payload.content;
  const fingerprint =
    stableMessageFingerprint(fingerprintSource) ??
    stableMessageFingerprint(
      pickString(params.record, ["type", "itemType", "kind", "name"]) ?? "message"
    ) ??
    "message";

  return [
    params.threadId,
    resolvedTurnId ?? "no-turn",
    params.role,
    params.eventType ?? "message",
    params.method.replaceAll("/", "-"),
    fingerprint,
    ...(params.payload.toolCall ? [] : [params.createdAt])
  ].join("::");
};

export const toTimelineMessageId = (params: {
  baseId: string;
  eventType?: ChatMessage["eventType"];
  createdAt: string;
}): string => {
  if (params.eventType !== "reasoning") {
    return params.baseId;
  }

  const suffix = `::${params.createdAt}`;
  return params.baseId.endsWith(suffix)
    ? params.baseId
    : `${params.baseId}${suffix}`;
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

const stableMessageFingerprint = (value: string): string | null => {
  const normalized = value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
  if (normalized.length === 0) {
    return null;
  }
  return normalized.slice(0, 80);
};

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
