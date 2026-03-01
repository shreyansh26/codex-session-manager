import { create } from "zustand";
import { makeSessionKey } from "../domain/sessionKey";
import type {
  ChatMessage,
  ComposerSubmission,
  DeviceAddSshRequest,
  DeviceRecord,
  RpcNotification,
  SessionSummary
} from "../domain/types";
import {
  closeAllClients,
  closeDeviceClient,
  listThreads,
  readAccount,
  readThread,
  resumeThread,
  setNotificationSink,
  startTurn
} from "../services/codexApi";
import { parseRpcNotification } from "../services/eventParser";
import {
  addLocalDevice,
  addSshDevice,
  connectDevice,
  disconnectDevice,
  listDevices,
  removeDevice
} from "../services/tauriBridge";
import { mergeSessions } from "./sessionMerge";

interface AppStore {
  loading: boolean;
  devices: DeviceRecord[];
  sessions: SessionSummary[];
  selectedSessionKey: string | null;
  messagesBySession: Record<string, ChatMessage[]>;
  globalError: string | null;
  initializing: boolean;
  initialize: () => Promise<void>;
  selectSession: (sessionKey: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshDeviceSessions: (deviceId: string) => Promise<void>;
  refreshThread: (
    deviceId: string,
    threadId: string,
    options?: { preserveSummary?: boolean; skipMessages?: boolean }
  ) => Promise<void>;
  submitComposer: (submission: ComposerSubmission) => Promise<void>;
  addSsh: (request: DeviceAddSshRequest) => Promise<void>;
  connect: (deviceId: string) => Promise<void>;
  disconnect: (deviceId: string) => Promise<void>;
  remove: (deviceId: string) => Promise<void>;
  clearError: () => void;
}

const fallbackLocalName = "Local Device";
const NOTIFICATION_REFRESH_MIN_INTERVAL_MS = 350;
const STREAMING_MERGE_WINDOW_MS = 10_000;
const POST_SEND_REFRESH_BURST_MS = 45_000;
const POST_SEND_REFRESH_INTERVAL_MS = 1_200;
const POST_SEND_REFRESH_INITIAL_DELAYS_MS = [250, 700, 1_300];
const PENDING_OPTIMISTIC_RETAIN_MS = 120_000;
const RECENT_SERVER_MESSAGE_RETAIN_MS = 45_000;

const pickSelectedSession = (
  preferred: string | null,
  sessions: SessionSummary[]
): string | null => {
  if (preferred && sessions.some((session) => session.key === preferred)) {
    return preferred;
  }
  return sessions[0]?.key ?? null;
};

const upsertDevice = (
  devices: DeviceRecord[],
  incoming: DeviceRecord
): DeviceRecord[] => {
  const exists = devices.some((device) => device.id === incoming.id);
  if (!exists) {
    return [...devices, incoming].sort((a, b) => a.name.localeCompare(b.name));
  }
  return devices
    .map((device) => (device.id === incoming.id ? incoming : device))
    .sort((a, b) => a.name.localeCompare(b.name));
};

const upsertMessage = (
  existing: ChatMessage[],
  incoming: ChatMessage
): ChatMessage[] => {
  const existingIndex = existing.findIndex((entry) =>
    isSameLogicalMessage(entry, incoming)
  );
  if (existingIndex === -1) {
    return [...existing, incoming].sort(sortMessagesAscending);
  }

  const current = existing[existingIndex];
  const merged: ChatMessage = {
    ...current,
    ...incoming,
    content:
      incoming.content.length >= current.content.length
        ? incoming.content
        : current.content,
    createdAt: pickLatestTimestamp(current.createdAt, incoming.createdAt)
  };

  const next = [...existing];
  next[existingIndex] = merged;
  return next.sort(sortMessagesAscending);
};

const normalizeMessageText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const isOptimisticMessage = (message: ChatMessage): boolean =>
  message.id.startsWith("local-");

const imageSignature = (message: ChatMessage): string =>
  (message.images ?? [])
    .map((image) => image.url.trim())
    .filter((url) => url.length > 0)
    .join("|");

const timestampsCloseEnough = (
  aIso: string,
  bIso: string,
  thresholdMs: number
): boolean => {
  const aMs = Date.parse(aIso);
  const bMs = Date.parse(bIso);
  if (Number.isNaN(aMs) || Number.isNaN(bMs)) {
    return true;
  }
  return Math.abs(aMs - bMs) <= thresholdMs;
};

const hasAcknowledgedEquivalent = (
  optimistic: ChatMessage,
  incoming: ChatMessage
): boolean => {
  if (optimistic.role !== "user" || incoming.role !== "user") {
    return false;
  }

  const optimisticText = normalizeMessageText(optimistic.content);
  const incomingText = normalizeMessageText(incoming.content);
  if (optimisticText !== incomingText) {
    return false;
  }

  if (imageSignature(optimistic) !== imageSignature(incoming)) {
    return false;
  }

  return timestampsCloseEnough(optimistic.createdAt, incoming.createdAt, 120_000);
};

const isSameLogicalMessage = (
  current: ChatMessage,
  incoming: ChatMessage
): boolean => {
  if (
    current.id !== incoming.id ||
    current.role !== incoming.role ||
    (current.eventType ?? "") !== (incoming.eventType ?? "")
  ) {
    return false;
  }

  if (current.createdAt === incoming.createdAt) {
    return true;
  }

  const currentMs = Date.parse(current.createdAt);
  const incomingMs = Date.parse(incoming.createdAt);
  if (Number.isNaN(currentMs) || Number.isNaN(incomingMs)) {
    return false;
  }

  if (Math.abs(currentMs - incomingMs) > STREAMING_MERGE_WINDOW_MS) {
    return false;
  }

  const currentContent = normalizeMessageText(current.content);
  const incomingContent = normalizeMessageText(incoming.content);
  if (currentContent.length === 0 || incomingContent.length === 0) {
    return true;
  }

  return (
    currentContent === incomingContent ||
    currentContent.startsWith(incomingContent) ||
    incomingContent.startsWith(currentContent)
  );
};

const pickLatestTimestamp = (a: string, b: string): string => {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);

  if (Number.isNaN(aMs)) {
    return b;
  }
  if (Number.isNaN(bMs)) {
    return a;
  }
  return bMs >= aMs ? b : a;
};

const sortMessagesAscending = (a: ChatMessage, b: ChatMessage): number => {
  const aMs = Date.parse(a.createdAt);
  const bMs = Date.parse(b.createdAt);
  if (Number.isNaN(aMs) && Number.isNaN(bMs)) {
    return a.id.localeCompare(b.id);
  }
  if (Number.isNaN(aMs)) {
    return 1;
  }
  if (Number.isNaN(bMs)) {
    return -1;
  }
  if (aMs === bMs) {
    return a.id.localeCompare(b.id);
  }
  return aMs - bMs;
};

const mergeThreadMessages = (
  existing: ChatMessage[],
  incoming: ChatMessage[]
): ChatMessage[] => {
  let merged = [...incoming];
  const nowMs = Date.now();

  for (const message of existing) {
    const alreadyPresent = merged.some(
      (entry) =>
        isSameLogicalMessage(entry, message) ||
        hasAcknowledgedEquivalent(message, entry)
    );
    if (alreadyPresent) {
      continue;
    }

    const createdAtMs = Date.parse(message.createdAt);
    const ageMs = Number.isNaN(createdAtMs) ? 0 : nowMs - createdAtMs;
    const keepOptimisticPending =
      isOptimisticMessage(message) &&
      message.role === "user" &&
      ageMs <= PENDING_OPTIMISTIC_RETAIN_MS;
    const keepRecentServerMessage =
      !isOptimisticMessage(message) && ageMs <= RECENT_SERVER_MESSAGE_RETAIN_MS;

    if (!keepOptimisticPending && !keepRecentServerMessage) {
      continue;
    }

    merged = upsertMessage(merged, message);
  }

  return merged.sort(sortMessagesAscending);
};

const normalizeSubmissionImages = (
  images: ComposerSubmission["images"]
): ComposerSubmission["images"] =>
  images
    .filter((image) => typeof image.url === "string" && image.url.trim().length > 0)
    .map((image) => ({
      ...image,
      url: image.url.trim()
    }));

const findLocalDevice = (devices: DeviceRecord[]): DeviceRecord | null =>
  devices.find((device) => device.config.kind === "local") ?? null;

const isValidIsoTimestamp = (value: string): boolean =>
  !Number.isNaN(Date.parse(value));

const sessionsEqual = (
  current: SessionSummary[],
  next: SessionSummary[]
): boolean => {
  if (current.length !== next.length) {
    return false;
  }

  for (let index = 0; index < current.length; index += 1) {
    const a = current[index];
    const b = next[index];
    if (
      a.key !== b.key ||
      a.threadId !== b.threadId ||
      a.deviceId !== b.deviceId ||
      a.title !== b.title ||
      a.preview !== b.preview ||
      a.updatedAt !== b.updatedAt ||
      a.cwd !== b.cwd ||
      a.folderName !== b.folderName
    ) {
      return false;
    }
  }

  return true;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const pickString = (
  value: Record<string, unknown> | null | undefined,
  keys: string[]
): string | null => {
  if (!value) {
    return null;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return null;
};

export const useAppStore = create<AppStore>((set, get) => {
  const notificationRefreshAtMs = new Map<string, number>();
  const postSendRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const stopPostSendRefresh = (sessionKey: string): void => {
    const pendingTimer = postSendRefreshTimers.get(sessionKey);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      postSendRefreshTimers.delete(sessionKey);
    }
  };

  const stopPostSendRefreshesForDevice = (deviceId: string): void => {
    const prefix = `${deviceId}::`;
    for (const sessionKey of postSendRefreshTimers.keys()) {
      if (sessionKey.startsWith(prefix)) {
        stopPostSendRefresh(sessionKey);
      }
    }
  };

  const startPostSendRefreshBurst = (params: {
    sessionKey: string;
    deviceId: string;
    threadId: string;
  }): void => {
    stopPostSendRefresh(params.sessionKey);

    for (const delayMs of POST_SEND_REFRESH_INITIAL_DELAYS_MS) {
      setTimeout(() => {
        void get().refreshThread(params.deviceId, params.threadId, {
          preserveSummary: true
        });
      }, delayMs);
    }

    const startedAt = Date.now();
    const tick = (): void => {
      void get().refreshThread(params.deviceId, params.threadId, {
        preserveSummary: true
      });

      if (Date.now() - startedAt >= POST_SEND_REFRESH_BURST_MS) {
        stopPostSendRefresh(params.sessionKey);
        return;
      }

      const pendingTimer = setTimeout(tick, POST_SEND_REFRESH_INTERVAL_MS);
      postSendRefreshTimers.set(params.sessionKey, pendingTimer);
    };

    const pendingTimer = setTimeout(tick, POST_SEND_REFRESH_INTERVAL_MS);
    postSendRefreshTimers.set(params.sessionKey, pendingTimer);
  };

  const refreshThreadFromNotification = (
    deviceId: string,
    notification: RpcNotification
  ): void => {
    const method = notification.method.replaceAll(".", "/").toLowerCase();
    if (
      !method.startsWith("turn/") &&
      !method.startsWith("message/") &&
      !method.startsWith("item/")
    ) {
      return;
    }

    const params = asRecord(notification.params);
    const threadId =
      pickString(params, ["threadId", "thread_id"]) ??
      pickString(asRecord(params?.message), ["threadId", "thread_id"]) ??
      pickString(asRecord(params?.item), ["threadId", "thread_id"]) ??
      pickString(asRecord(params?.turn), ["threadId", "thread_id"]);
    if (!threadId) {
      return;
    }

    const sessionKey = makeSessionKey(deviceId, threadId);
    const nowMs = Date.now();
    const lastRefreshMs = notificationRefreshAtMs.get(sessionKey) ?? 0;
    if (nowMs - lastRefreshMs < NOTIFICATION_REFRESH_MIN_INTERVAL_MS) {
      return;
    }
    notificationRefreshAtMs.set(sessionKey, nowMs);

    void get().refreshThread(deviceId, threadId, { preserveSummary: true });
  };

  const applyNotification = (deviceId: string, notification: RpcNotification): void => {
    const parsed = parseRpcNotification(deviceId, notification);
    if (!parsed) {
      refreshThreadFromNotification(deviceId, notification);
      return;
    }

    const sessionKey = makeSessionKey(deviceId, parsed.threadId);

    set((state) => {
      const current = state.messagesBySession[sessionKey] ?? [];
      const next = upsertMessage(current, parsed.message);
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionKey]: next
        }
      };
    });
    refreshThreadFromNotification(deviceId, notification);
  };

  const ensureDeviceConnected = async (device: DeviceRecord): Promise<void> => {
    if (!device.connected) {
      return;
    }

    const authenticated = await readAccount(device);
    if (!authenticated) {
      throw new Error(
        `${device.name} is not authenticated. Run \`codex login\` on that device and reconnect.`
      );
    }
  };

  return {
    loading: false,
    initializing: false,
    devices: [],
    sessions: [],
    selectedSessionKey: null,
    messagesBySession: {},
    globalError: null,
    initialize: async () => {
      if (get().initializing) {
        return;
      }

      set({ initializing: true, loading: true, globalError: null });
      setNotificationSink(applyNotification);

      try {
        let devices = await listDevices();

        const localDevices = devices.filter(
          (device) => device.config.kind === "local"
        );
        if (localDevices.length > 1) {
          for (const duplicate of localDevices.slice(1)) {
            await removeDevice(duplicate.id);
          }
          devices = await listDevices();
        }

        let localDevice = findLocalDevice(devices);
        if (!localDevice) {
          localDevice = await addLocalDevice({ name: fallbackLocalName });
          devices = upsertDevice(devices, localDevice);
        }

        if (localDevice && !localDevice.connected) {
          try {
            const connectedLocal = await connectDevice(localDevice.id);
            devices = upsertDevice(devices, connectedLocal);
            localDevice = connectedLocal;
          } catch (error) {
            const message = toErrorMessage(error);
            devices = upsertDevice(devices, {
              ...localDevice,
              connected: false,
              lastError: message
            });
          }
        }

        set({ devices, globalError: null });

        for (const device of devices) {
          if (device.connected) {
            try {
              await ensureDeviceConnected(device);
            } catch (error) {
              const message = toErrorMessage(error);
              set((state) => ({
                devices: state.devices.map((entry) =>
                  entry.id === device.id ? { ...entry, lastError: message } : entry
                )
              }));
            }
          }
        }

        await get().refreshSessions();
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      } finally {
        set({ loading: false, initializing: false });
      }
    },
    selectSession: async (sessionKey) => {
      set({ selectedSessionKey: sessionKey });
      const selected = get().sessions.find((session) => session.key === sessionKey);
      if (!selected) {
        return;
      }

      await get().refreshThread(selected.deviceId, selected.threadId, {
        preserveSummary: true
      });
    },
    refreshSessions: async () => {
      const devices = get().devices;
      const sessionBuckets: SessionSummary[] = [];

      for (const device of devices) {
        if (!device.connected) {
          continue;
        }

        try {
          await ensureDeviceConnected(device);
          const threads = await listThreads(device);
          sessionBuckets.push(...threads);
          set((state) => ({
            devices: state.devices.map((entry) =>
              entry.id === device.id ? { ...entry, lastError: undefined } : entry
            )
          }));
        } catch (error) {
          const message = toErrorMessage(error);
          set((state) => ({
            devices: state.devices.map((entry) =>
              entry.id === device.id ? { ...entry, lastError: message } : entry
            )
          }));
        }
      }

      const previousState = get();
      const incomingKeys = new Set(sessionBuckets.map((session) => session.key));
      const preserved = previousState.sessions.filter((session) =>
        incomingKeys.has(session.key)
      );
      const sessions = mergeSessions(preserved, sessionBuckets);
      const selectedSessionKey = pickSelectedSession(
        previousState.selectedSessionKey,
        sessions
      );

      if (
        !sessionsEqual(previousState.sessions, sessions) ||
        previousState.selectedSessionKey !== selectedSessionKey
      ) {
        set({ sessions, selectedSessionKey });
      }

      const selected = get().selectedSessionKey;
      if (selected) {
        const session = get().sessions.find((entry) => entry.key === selected);
        if (session) {
          await get().refreshThread(session.deviceId, session.threadId, {
            preserveSummary: true
          });
        }
      }

      const hydrationCandidates = get()
        .sessions.filter((session) => !isValidIsoTimestamp(session.updatedAt))
        .slice(0, 3);
      for (const candidate of hydrationCandidates) {
        void get().refreshThread(candidate.deviceId, candidate.threadId, {
          skipMessages: true
        });
      }
    },
    refreshDeviceSessions: async (deviceId) => {
      const device = get().devices.find((entry) => entry.id === deviceId);
      if (!device || !device.connected) {
        return;
      }

      try {
        await ensureDeviceConnected(device);
        const threads = await listThreads(device);
        set((state) => {
          const incomingKeys = new Set(threads.map((session) => session.key));
          const otherDevices = state.sessions.filter(
            (session) => session.deviceId !== deviceId
          );
          const preservedForDevice = state.sessions.filter(
            (session) => session.deviceId === deviceId && incomingKeys.has(session.key)
          );
          const mergedSessions = mergeSessions(
            [...otherDevices, ...preservedForDevice],
            threads
          );
          const selectedSessionKey = pickSelectedSession(
            state.selectedSessionKey,
            mergedSessions
          );

          return {
            sessions: mergedSessions,
            selectedSessionKey,
            devices: state.devices.map((entry) =>
              entry.id === deviceId ? { ...entry, lastError: undefined } : entry
            )
          };
        });

        const hydrationCandidates = get()
          .sessions.filter(
            (session) =>
              session.deviceId === deviceId && !isValidIsoTimestamp(session.updatedAt)
          )
          .slice(0, 3);
        for (const candidate of hydrationCandidates) {
          void get().refreshThread(candidate.deviceId, candidate.threadId, {
            skipMessages: true
          });
        }
      } catch (error) {
        const message = toErrorMessage(error);
        set((state) => ({
          devices: state.devices.map((entry) =>
            entry.id === deviceId ? { ...entry, lastError: message } : entry
          )
        }));
      }
    },
    refreshThread: async (deviceId, threadId, options) => {
      const device = get().devices.find((entry) => entry.id === deviceId);
      if (!device || !device.connected) {
        return;
      }

      try {
        const payload = await readThread(device, threadId);
        set((state) => {
          const nextSessions =
            options?.preserveSummary &&
            state.sessions.some((session) => session.key === payload.session.key)
              ? state.sessions
              : mergeSessions(state.sessions, [payload.session]);

          return {
            sessions: nextSessions,
            messagesBySession: options?.skipMessages
              ? state.messagesBySession
              : {
                  ...state.messagesBySession,
                  [payload.session.key]: mergeThreadMessages(
                    state.messagesBySession[payload.session.key] ?? [],
                    payload.messages
                  )
                }
          };
        });
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      }
    },
    submitComposer: async (submissionInput) => {
      const state = get();
      const session = state.sessions.find(
        (entry) => entry.key === state.selectedSessionKey
      );
      const prompt = submissionInput.prompt.trim();
      const images = normalizeSubmissionImages(submissionInput.images);
      if (!session || (prompt.length === 0 && images.length === 0)) {
        return;
      }

      const device = state.devices.find((entry) => entry.id === session.deviceId);
      if (!device || !device.connected) {
        set({
          globalError: `Device ${session.deviceLabel} is not connected.`
        });
        return;
      }

      const optimisticUserMessage: ChatMessage = {
        id: `local-${Date.now().toString(36)}`,
        key: session.key,
        threadId: session.threadId,
        deviceId: session.deviceId,
        role: "user",
        content: prompt,
        createdAt: new Date().toISOString(),
        ...(images.length > 0 ? { images } : {})
      };

      set((prev) => ({
        messagesBySession: {
          ...prev.messagesBySession,
          [session.key]: upsertMessage(
            prev.messagesBySession[session.key] ?? [],
            optimisticUserMessage
          )
        },
        globalError: null
      }));

      startPostSendRefreshBurst({
        sessionKey: session.key,
        deviceId: session.deviceId,
        threadId: session.threadId
      });

      void (async () => {
        try {
          await resumeThread(device, session.threadId);
          await startTurn(device, session.threadId, {
            prompt,
            images
          });
        } catch (error) {
          stopPostSendRefresh(session.key);
          set({ globalError: toErrorMessage(error) });
        }
      })();
    },
    addSsh: async (request) => {
      try {
        const device = await addSshDevice(request);
        set((state) => ({
          devices: upsertDevice(state.devices, device),
          globalError: null
        }));
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      }
    },
    connect: async (deviceId) => {
      try {
        set({ loading: true });
        const connected = await connectDevice(deviceId);
        await ensureDeviceConnected(connected);
        set((state) => ({
          devices: upsertDevice(state.devices, connected),
          globalError: null
        }));
        await get().refreshDeviceSessions(deviceId);
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      } finally {
        set({ loading: false });
      }
    },
    disconnect: async (deviceId) => {
      try {
        stopPostSendRefreshesForDevice(deviceId);
        const disconnected = await disconnectDevice(deviceId);
        closeDeviceClient(deviceId);
        set((state) => ({
          devices: upsertDevice(state.devices, disconnected)
        }));
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      }
    },
    remove: async (deviceId) => {
      try {
        stopPostSendRefreshesForDevice(deviceId);
        const devices = await removeDevice(deviceId);
        closeDeviceClient(deviceId);
        set((state) => {
          const sessions = state.sessions.filter((session) => session.deviceId !== deviceId);
          const messagesBySession = Object.fromEntries(
            Object.entries(state.messagesBySession).filter(
              ([key]) => !key.startsWith(`${deviceId}::`)
            )
          );

          return {
            devices,
            sessions,
            messagesBySession,
            selectedSessionKey: pickSelectedSession(state.selectedSessionKey, sessions)
          };
        });
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      }
    },
    clearError: () => {
      set({ globalError: null });
    }
  };
});

export const shutdownRpcClients = (): void => {
  setNotificationSink(null);
  closeAllClients();
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const directMessage = record.message;
    if (typeof directMessage === "string" && directMessage.trim().length > 0) {
      return directMessage;
    }

    const cause = record.cause;
    if (typeof cause === "string" && cause.trim().length > 0) {
      return cause;
    }
    if (typeof cause === "object" && cause !== null) {
      const causeRecord = cause as Record<string, unknown>;
      const nestedMessage = causeRecord.message;
      if (typeof nestedMessage === "string" && nestedMessage.trim().length > 0) {
        return nestedMessage;
      }
    }

    try {
      const serialized = JSON.stringify(record);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // Ignore serialization errors and use fallback below.
    }
  }

  return "Unknown error";
};
