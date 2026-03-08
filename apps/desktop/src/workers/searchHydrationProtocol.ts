import type { DeviceRecord, SearchIndexThreadPayload, SessionSummary } from "../domain/types";

export type SearchHydrationWorkerRequest =
  | {
      type: "hydrate-session";
      requestId: number;
      device: DeviceRecord;
      session: SessionSummary;
    }
  | {
      type: "close-device";
      deviceId: string;
    }
  | {
      type: "shutdown";
    };

export type SearchHydrationWorkerResponse =
  | {
      type: "hydrated-session";
      requestId: number;
      payload: SearchIndexThreadPayload;
    }
  | {
      type: "hydrate-error";
      requestId: number;
      sessionKey: string;
      error: string;
    };
