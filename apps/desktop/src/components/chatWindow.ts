import type { ChatMessage } from "../domain/types";

export interface VisibleMessageWindow {
  hiddenMessageCount: number;
  startIndex: number;
  visibleMessages: ChatMessage[];
}

export const getMessageWindowKey = (message: ChatMessage): string =>
  [message.id, message.role, message.eventType ?? ""].join("::");

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
  const startIndex = anchorIndex >= 0 ? anchorIndex : fallbackStartIndex;

  return {
    hiddenMessageCount: startIndex,
    startIndex,
    visibleMessages: messages.slice(startIndex)
  };
};
