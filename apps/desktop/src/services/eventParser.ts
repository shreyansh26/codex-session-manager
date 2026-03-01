import type { ChatMessage, ChatRole, RpcNotification, TurnStatus } from "../domain/types";

export interface ParsedTurnEvent {
  kind: "turn";
  threadId: string;
  status: TurnStatus;
}

export interface ParsedMessageEvent {
  kind: "message";
  threadId: string;
  message: ChatMessage;
}

export type ParsedRpcEvent = ParsedTurnEvent | ParsedMessageEvent;

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

  if (method === "turn/started" || method === "turn/completed" || method === "turn/failed") {
    const threadId = directThreadId;
    if (!threadId) {
      return null;
    }

    const status: TurnStatus =
      method === "turn/started"
        ? "running"
        : method === "turn/completed"
          ? "completed"
          : "failed";

    return {
      kind: "turn",
      threadId,
      status
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

  const createdAtRaw =
    pickString(item, [
      "completedAt",
      "completed_at",
      "createdAt",
      "created_at",
      "startedAt",
      "started_at",
      "updatedAt",
      "updated_at"
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
        pickString(item, ["id", "itemId"]) ??
        `${threadId}-${role}-${Date.now().toString(36)}-${method.replace("/", "-")}`,
      key: `${deviceId}::${threadId}`,
      threadId,
      deviceId,
      role: role,
      content: payload.content,
      createdAt,
      ...(payload.eventType ? { eventType: payload.eventType } : {})
    }
  };
};

export const extractItemMessagePayload = (
  item: Record<string, unknown>,
  method: string,
  role: ChatRole
): { content: string; eventType?: ChatMessage["eventType"] } | null => {
  const content = extractText(item).trim();
  const eventType = inferEventType(item, method, role);

  if (content.length > 0) {
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

const normalizeTimestamp = (value: string): string | null => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
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

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
