import type {
  ThreadReadWorkerRequest,
  ThreadReadWorkerResponse
} from "./threadReadProtocol";
import {
  closeAllClients,
  closeDeviceClient,
  readRolloutTimelineMessages,
  readThread
} from "../services/codexApi";
import { makeSessionKey } from "../domain/sessionKey";

const workerScope = globalThis as typeof globalThis & {
  onmessage: ((event: MessageEvent<ThreadReadWorkerRequest>) => void) | null;
  postMessage: (message: ThreadReadWorkerResponse) => void;
};

const postWorkerMessage = (message: ThreadReadWorkerResponse): void => {
  workerScope.postMessage(message);
};

const readThreadBase = async (
  request: Extract<ThreadReadWorkerRequest, { type: "read-thread-base" }>
): Promise<void> => {
  const { device, requestId, threadId, skipMessages } = request;
  try {
    const payload = await readThread(device, threadId, {
      includeRolloutMessages: false,
      skipMessages
    });
    postWorkerMessage({
      type: "thread-base-read",
      requestId,
      payload
    });
  } catch (error) {
    postWorkerMessage({
      type: "thread-read-error",
      requestId,
      sessionKey: makeSessionKey(device.id, threadId),
      error: toErrorMessage(error)
    });
  }
};

const readThreadRollout = async (
  request: Extract<ThreadReadWorkerRequest, { type: "read-thread-rollout" }>
): Promise<void> => {
  const { device, requestId, threadId, rolloutPath, revision } = request;
  try {
    const messages = await readRolloutTimelineMessages(
      device,
      threadId,
      rolloutPath,
      revision
    );
    postWorkerMessage({
      type: "thread-rollout-read",
      requestId,
      payload: {
        sessionKey: makeSessionKey(device.id, threadId),
        threadId,
        deviceId: device.id,
        messages,
        ...(revision ? { revision } : {}),
        rolloutPath
      }
    });
  } catch (error) {
    postWorkerMessage({
      type: "thread-read-error",
      requestId,
      sessionKey: makeSessionKey(device.id, threadId),
      error: toErrorMessage(error)
    });
  }
};

workerScope.onmessage = (event: MessageEvent<ThreadReadWorkerRequest>): void => {
  const request = event.data;
  if (!request) {
    return;
  }

  switch (request.type) {
    case "read-thread-base": {
      void readThreadBase(request);
      return;
    }
    case "read-thread-rollout": {
      void readThreadRollout(request);
      return;
    }
    case "close-device": {
      closeDeviceClient(request.deviceId);
      return;
    }
    case "shutdown": {
      closeAllClients();
      return;
    }
    default: {
      return;
    }
  }
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};
