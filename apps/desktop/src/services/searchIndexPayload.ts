import type {
  ChatMessage,
  SearchIndexThreadPayload,
  SessionSummary
} from "../domain/types";

export const toSearchIndexThreadPayload = (
  session: SessionSummary,
  messages: ChatMessage[]
): SearchIndexThreadPayload => ({
  sessionKey: session.key,
  threadId: session.threadId,
  deviceId: session.deviceId,
  sessionTitle: session.title,
  deviceLabel: session.deviceLabel,
  deviceAddress: session.deviceAddress,
  updatedAt: session.updatedAt,
  messages: messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt
  }))
});
