import { create } from "zustand";
import { makeSessionKey } from "../domain/sessionKey";
import type {
  ChatMessage,
  DeviceAddSshRequest,
  DeviceRecord,
  RpcNotification,
  SessionSummary,
  TurnStatus
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
  turnStatusBySession: Record<string, TurnStatus>;
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
  submitComposer: (prompt: string) => Promise<void>;
  addSsh: (request: DeviceAddSshRequest) => Promise<void>;
  connect: (deviceId: string) => Promise<void>;
  disconnect: (deviceId: string) => Promise<void>;
  remove: (deviceId: string) => Promise<void>;
  clearError: () => void;
}

const fallbackLocalName = "Local Device";

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

const appendMessageUnique = (
  existing: ChatMessage[],
  incoming: ChatMessage
): ChatMessage[] => {
  if (existing.some((entry) => entry.id === incoming.id)) {
    return existing;
  }

  return [...existing, incoming].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
  );
};

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

export const useAppStore = create<AppStore>((set, get) => {
  const applyNotification = (deviceId: string, notification: RpcNotification): void => {
    const parsed = parseRpcNotification(deviceId, notification);
    if (!parsed) {
      return;
    }

    const sessionKey = makeSessionKey(deviceId, parsed.threadId);

    if (parsed.kind === "turn") {
      set((state) => ({
        turnStatusBySession: {
          ...state.turnStatusBySession,
          [sessionKey]: parsed.status
        }
      }));

      if (parsed.status === "completed" || parsed.status === "failed") {
        void get().refreshThread(deviceId, parsed.threadId);
      }
      return;
    }

    set((state) => {
      const current = state.messagesBySession[sessionKey] ?? [];
      const next = appendMessageUnique(current, parsed.message);
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionKey]: next
        }
      };
    });
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
    turnStatusBySession: {},
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
        const existingMessages = get().messagesBySession[selected] ?? [];
        if (session && existingMessages.length === 0) {
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
                  [payload.session.key]: payload.messages
                },
            turnStatusBySession: {
              ...state.turnStatusBySession,
              [payload.session.key]: state.turnStatusBySession[payload.session.key] ?? "idle"
            }
          };
        });
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      }
    },
    submitComposer: async (promptInput) => {
      const state = get();
      const session = state.sessions.find(
        (entry) => entry.key === state.selectedSessionKey
      );
      const prompt = promptInput.trim();
      if (!session || prompt.length === 0) {
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
        createdAt: new Date().toISOString()
      };

      set((prev) => ({
        messagesBySession: {
          ...prev.messagesBySession,
          [session.key]: appendMessageUnique(
            prev.messagesBySession[session.key] ?? [],
            optimisticUserMessage
          )
        },
        turnStatusBySession: {
          ...prev.turnStatusBySession,
          [session.key]: "running"
        },
        globalError: null
      }));

      const refreshWithGap = (attempt = 0): void => {
        const delayMs = attempt === 0 ? 250 : attempt === 1 ? 700 : 1300;
        setTimeout(() => {
          const currentTurnStatus = get().turnStatusBySession[session.key];
          if (currentTurnStatus === "running") {
            void get().refreshThread(session.deviceId, session.threadId);
            if (attempt < 2) {
              refreshWithGap(attempt + 1);
            }
          }
        }, delayMs);
      };

      void (async () => {
        try {
          await resumeThread(device, session.threadId);
          await startTurn(device, session.threadId, prompt);
          refreshWithGap(0);
        } catch (error) {
          set((prev) => ({
            turnStatusBySession: {
              ...prev.turnStatusBySession,
              [session.key]: "failed"
            },
            globalError: toErrorMessage(error)
          }));
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
        const disconnected = await disconnectDevice(deviceId);
        closeDeviceClient(deviceId);
        set((state) => ({
          devices: upsertDevice(state.devices, disconnected),
          turnStatusBySession: Object.fromEntries(
            Object.entries(state.turnStatusBySession).filter(
              ([key]) => !key.startsWith(`${deviceId}::`)
            )
          )
        }));
      } catch (error) {
        set({ globalError: toErrorMessage(error) });
      }
    },
    remove: async (deviceId) => {
      try {
        const devices = await removeDevice(deviceId);
        closeDeviceClient(deviceId);
        set((state) => {
          const sessions = state.sessions.filter((session) => session.deviceId !== deviceId);
          const messagesBySession = Object.fromEntries(
            Object.entries(state.messagesBySession).filter(
              ([key]) => !key.startsWith(`${deviceId}::`)
            )
          );
          const turnStatusBySession = Object.fromEntries(
            Object.entries(state.turnStatusBySession).filter(
              ([key]) => !key.startsWith(`${deviceId}::`)
            )
          );

          return {
            devices,
            sessions,
            messagesBySession,
            turnStatusBySession,
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
