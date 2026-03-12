import type { ChatMessage } from "../domain/types";
import { parseRpcNotification } from "../services/eventParser";
import {
  __TEST_ONLY__ as codexApiTest,
  parseToolMessagesFromRolloutJsonl
} from "../services/codexApi";
import { __TEST_ONLY__ as storeTest } from "../state/useAppStore";
import type {
  ChronologyReplayFixture,
  ChronologyReplayStep
} from "./chronologyReplayFixtures";

const DEFAULT_DEVICE_ID = "device-1";

export const applyChronologyReplayStep = (
  messages: ChatMessage[],
  fixture: ChronologyReplayFixture,
  step: ChronologyReplayStep,
  deviceId = DEFAULT_DEVICE_ID
): ChatMessage[] => {
  if (step.source === "live") {
    const parsed = parseRpcNotification(deviceId, step.notification);
    if (!parsed) {
      return messages;
    }

    return storeTest.upsertMessage(
      messages,
      storeTest.normalizeLiveNotificationMessage(messages, parsed.message)
    );
  }

  if (step.source === "thread_read") {
    return storeTest.mergeSnapshotMessages(
      messages,
      codexApiTest.parseMessagesFromThread(deviceId, fixture.threadId, step.snapshot)
    );
  }

  return storeTest.mergeRolloutEnrichmentMessages(
    messages,
    parseToolMessagesFromRolloutJsonl(
      deviceId,
      fixture.threadId,
      step.records.map((record) => JSON.stringify(record)).join("\n")
    )
  );
};

export const applyChronologyReplayFixture = (
  fixture: ChronologyReplayFixture,
  deviceId = DEFAULT_DEVICE_ID
): ChatMessage[] =>
  fixture.steps.reduce(
    (messages, step) => applyChronologyReplayStep(messages, fixture, step, deviceId),
    [] as ChatMessage[]
  );

export const messageRoleIdOrder = (messages: ChatMessage[]): string[] =>
  messages.map((message) => `${message.role}:${message.id}`);
