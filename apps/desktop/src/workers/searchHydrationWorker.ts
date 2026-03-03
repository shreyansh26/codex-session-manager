import type {
  SearchHydrationWorkerRequest,
  SearchHydrationWorkerResponse
} from "./searchHydrationProtocol";
import { closeAllClients, closeDeviceClient, readThread } from "../services/codexApi";
import { toSearchIndexThreadPayload } from "../services/searchIndexPayload";

const workerScope = globalThis as typeof globalThis & {
  onmessage: ((event: MessageEvent<SearchHydrationWorkerRequest>) => void) | null;
  postMessage: (message: SearchHydrationWorkerResponse) => void;
};

const postWorkerMessage = (message: SearchHydrationWorkerResponse): void => {
  workerScope.postMessage(message);
};

const hydrateSession = async (
  request: Extract<SearchHydrationWorkerRequest, { type: "hydrate-session" }>
): Promise<void> => {
  const { device, requestId, session } = request;
  try {
    const payload = await readThread(device, session.threadId);
    postWorkerMessage({
      type: "hydrated-session",
      requestId,
      payload: toSearchIndexThreadPayload(payload.session, payload.messages)
    });
  } catch (error) {
    postWorkerMessage({
      type: "hydrate-error",
      requestId,
      sessionKey: session.key,
      error: toErrorMessage(error)
    });
  }
};

workerScope.onmessage = (event: MessageEvent<SearchHydrationWorkerRequest>): void => {
  const request = event.data;
  if (!request) {
    return;
  }

  switch (request.type) {
    case "hydrate-session": {
      void hydrateSession(request);
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
