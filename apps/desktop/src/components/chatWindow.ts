import type { ChatMessage } from "../domain/types";

export interface VisibleMessageWindow {
  hiddenMessageCount: number;
  startIndex: number;
  visibleMessages: ChatMessage[];
}

export const getMessageWindowKey = (message: ChatMessage): string =>
  [
    message.id,
    message.role,
    message.eventType ?? "",
    ...(message.eventType === "tool_call" ? [message.createdAt] : [])
  ].join("::");

const rewindToCurrentTurnStart = (
  messages: ChatMessage[],
  startIndex: number
): number => {
  if (startIndex <= 0 || startIndex >= messages.length) {
    return Math.max(0, startIndex);
  }

  for (let index = startIndex; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }

  return startIndex;
};

export const resolveVisibleMessageWindow = (params: {
  messages: ChatMessage[];
  visibleMessageCount: number;
  anchorMessageKey: string | null;
}): VisibleMessageWindow => {
  const { messages, visibleMessageCount, anchorMessageKey } = params;
  const fallbackStartIndex = Math.max(0, messages.length - visibleMessageCount);
  const anchorIndex =
    anchorMessageKey !== null
      ? messages.findIndex((message) => getMessageWindowKey(message) === anchorMessageKey)
      : -1;
  const startIndex =
    anchorIndex >= 0
      ? anchorIndex
      : rewindToCurrentTurnStart(messages, fallbackStartIndex);

  return {
    hiddenMessageCount: startIndex,
    startIndex,
    visibleMessages: messages.slice(startIndex)
  };
};
