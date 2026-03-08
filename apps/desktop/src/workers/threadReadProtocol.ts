import type {
  DeviceRecord,
  ThreadPayload,
  ThreadRolloutPayload
} from "../domain/types";

export type ThreadReadWorkerRequest =
  | {
      type: "read-thread-base";
      requestId: number;
      device: DeviceRecord;
      threadId: string;
      skipMessages?: boolean;
    }
  | {
      type: "read-thread-rollout";
      requestId: number;
      device: DeviceRecord;
      threadId: string;
      rolloutPath: string;
      revision?: string;
    }
  | {
      type: "close-device";
      deviceId: string;
    }
  | {
      type: "shutdown";
    };

export type ThreadReadWorkerResponse =
  | {
      type: "thread-base-read";
      requestId: number;
      payload: ThreadPayload;
    }
  | {
      type: "thread-rollout-read";
      requestId: number;
      payload: ThreadRolloutPayload;
    }
  | {
      type: "thread-read-error";
      requestId: number;
      sessionKey: string;
      error: string;
    };
