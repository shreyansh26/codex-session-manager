import type { ChatMessage } from "../domain/types";

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
