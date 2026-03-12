import type { ChatMessage } from "../domain/types";

const ITEM_ID_SEQUENCE_PATTERN = /^item-(\d+)(?:::.*)?$/;

export const toolCallCompletenessScore = (message: ChatMessage): number => {
  if (!message.toolCall) {
    return 0;
  }

  return (
    (message.toolCall.name.trim().length > 0 ? 1 : 0) +
    (message.toolCall.input?.trim().length ? 1 : 0) +
    (message.toolCall.output?.trim().length ? 2 : 0) +
    (message.toolCall.status === "completed" || message.toolCall.status === "failed" ? 1 : 0)
  );
};

export const parseMessageTimestampMs = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? -1 : parsed;
};

export const compareMessageTimelineOrder = (
  a: Pick<ChatMessage, "timelineOrder">,
  b: Pick<ChatMessage, "timelineOrder">
): number => {
  if (
    typeof a.timelineOrder === "number" &&
    typeof b.timelineOrder === "number" &&
    a.timelineOrder !== b.timelineOrder
  ) {
    return a.timelineOrder - b.timelineOrder;
  }
  return 0;
};

export const sortMessagesAscending = (a: ChatMessage, b: ChatMessage): number => {
  const aMs = parseMessageTimestampMs(a.createdAt);
  const bMs = parseMessageTimestampMs(b.createdAt);

  if (aMs === -1 && bMs === -1) {
    return compareMessageTimelineOrder(a, b);
  }
  if (aMs === -1) {
    return 1;
  }
  if (bMs === -1) {
    return -1;
  }
  if (aMs === bMs) {
    return compareMessageTimelineOrder(a, b);
  }
  return aMs - bMs;
};

export const assignMissingTimelineOrder = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((message, index) => ({
    ...message,
    ...(typeof message.timelineOrder === "number"
      ? {}
      : { timelineOrder: index })
  }));

export const extractFlatItemSequence = (messageId: string): number | null => {
  const match = ITEM_ID_SEQUENCE_PATTERN.exec(messageId);
  if (!match) {
    return null;
  }

  const numeric = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(numeric) ? numeric : null;
};

export const assignNumericFlatSnapshotTimelineOrder = (
  messages: ChatMessage[]
): ChatMessage[] => {
  if (messages.length < 2) {
    return assignMissingTimelineOrder(messages);
  }

  const fallbackCreatedAt = messages[0]?.createdAt ?? null;
  if (
    !fallbackCreatedAt ||
    !messages.every(
      (message) =>
        message.eventType !== "tool_call" &&
        message.createdAt === fallbackCreatedAt &&
        extractFlatItemSequence(message.id) !== null
    )
  ) {
    return assignMissingTimelineOrder(messages);
  }

  return [...messages]
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftSequence = extractFlatItemSequence(left.message.id) ?? Number.MAX_SAFE_INTEGER;
      const rightSequence =
        extractFlatItemSequence(right.message.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }
      return left.index - right.index;
    })
    .map(({ message }, index) => ({
      ...message,
      timelineOrder: index
    }));
};
