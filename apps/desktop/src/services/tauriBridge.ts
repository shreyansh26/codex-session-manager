import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  DeviceAddLocalRequest,
  DeviceAddSshRequest,
  DeviceRecord,
  SearchBootstrapStatus,
  SearchIndexThreadPayload,
  SearchQueryRequest,
  SearchQueryResponse
} from "../domain/types";

const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let demoDevices: DeviceRecord[] = [];
const demoSearchSessions = new Map<string, SearchIndexThreadPayload>();
let demoSearchLastUpdatedAtMs: number | undefined;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const now = (): number => Date.now();

const normalizeLocalRequest = (request: DeviceAddLocalRequest): DeviceRecord => {
  const id = crypto.randomUUID();
  return {
    id,
    name: request.name ?? "Local Device",
    config: {
      kind: "local",
      appServerPort: request.appServerPort,
      codexBin: request.codexBin,
      workspaceRoot: request.workspaceRoot
    },
    connected: false
  };
};

const normalizeSshRequest = (request: DeviceAddSshRequest): DeviceRecord => {
  const id = crypto.randomUUID();
  return {
    id,
    name: request.name ?? `${request.user}@${request.host}`,
    config: {
      kind: "ssh",
      host: request.host,
      user: request.user,
      sshPort: request.sshPort ?? 22,
      identityFile: request.identityFile,
      remoteAppServerPort: request.remoteAppServerPort ?? 45231,
      localForwardPort: request.localForwardPort,
      codexBin: request.codexBin,
      workspaceRoot: request.workspaceRoot
    },
    connected: false
  };
};

const mockInvoke = async <T>(
  command: string,
  args: Record<string, unknown> = {}
): Promise<T> => {
  switch (command) {
    case "device_list":
      return clone(demoDevices) as T;
    case "device_add_local": {
      const request = args.request as DeviceAddLocalRequest;
      const device = normalizeLocalRequest(request);
      demoDevices = [...demoDevices, device];
      return clone(device) as T;
    }
    case "device_add_ssh": {
      const request = args.request as DeviceAddSshRequest;
      const device = normalizeSshRequest(request);
      demoDevices = [...demoDevices, device];
      return clone(device) as T;
    }
    case "device_connect": {
      const request = args.request as { deviceId: string };
      demoDevices = demoDevices.map((device) =>
        device.id === request.deviceId
          ? {
              ...device,
              connected: true,
              connection: {
                endpoint: "ws://127.0.0.1:45231",
                transport: "websocket",
                connectedAtMs: now()
              }
            }
          : device
      );
      const device = demoDevices.find((entry) => entry.id === request.deviceId);
      if (!device) {
        throw new Error(`Unknown device: ${request.deviceId}`);
      }
      return clone(device) as T;
    }
    case "device_disconnect": {
      const request = args.request as { deviceId: string };
      demoDevices = demoDevices.map((device) =>
        device.id === request.deviceId
          ? { ...device, connected: false, connection: undefined }
          : device
      );
      const device = demoDevices.find((entry) => entry.id === request.deviceId);
      if (!device) {
        throw new Error(`Unknown device: ${request.deviceId}`);
      }
      return clone(device) as T;
    }
    case "device_remove": {
      const request = args.request as { deviceId: string };
      demoDevices = demoDevices.filter((device) => device.id !== request.deviceId);
      for (const [sessionKey, session] of demoSearchSessions.entries()) {
        if (session.deviceId === request.deviceId) {
          demoSearchSessions.delete(sessionKey);
        }
      }
      return clone(demoDevices) as T;
    }
    case "search_index_upsert_thread": {
      const request = args.request as SearchIndexThreadPayload;
      demoSearchSessions.set(request.sessionKey, clone(request));
      demoSearchLastUpdatedAtMs = Date.now();
      return undefined as T;
    }
    case "search_index_remove_device": {
      const request = args.request as { deviceId: string };
      for (const [sessionKey, session] of demoSearchSessions.entries()) {
        if (session.deviceId === request.deviceId) {
          demoSearchSessions.delete(sessionKey);
        }
      }
      demoSearchLastUpdatedAtMs = Date.now();
      return undefined as T;
    }
    case "search_query": {
      const request = args.request as SearchQueryRequest;
      return clone(runDemoSearch(request)) as T;
    }
    case "search_bootstrap_status": {
      const indexedSessions = demoSearchSessions.size;
      const indexedMessages = [...demoSearchSessions.values()].reduce(
        (count, session) => count + session.messages.length,
        0
      );
      const status: SearchBootstrapStatus = {
        indexedSessions,
        indexedMessages,
        ...(typeof demoSearchLastUpdatedAtMs === "number"
          ? { lastUpdatedAtMs: demoSearchLastUpdatedAtMs }
          : {})
      };
      return clone(status) as T;
    }
    default:
      throw new Error(`Unknown command in demo mode: ${command}`);
  }
};

const normalizeForSearch = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const toTokens = (value: string): string[] =>
  normalizeForSearch(value).split(" ").filter((entry) => entry.length > 0);

const levenshteinDistance = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
};

const normalizedLevenshtein = (a: string, b: string): number => {
  if (a.length === 0 && b.length === 0) {
    return 1;
  }
  const distance = levenshteinDistance(a, b);
  return 1 - distance / Math.max(a.length, b.length);
};

const runDemoSearch = (request: SearchQueryRequest): SearchQueryResponse => {
  const query = request.query.trim();
  const threshold = Math.max(0, Math.min(1, request.threshold ?? 0.9));
  const maxSessions = Math.max(1, Math.min(request.maxSessions ?? 10, 120));
  if (!query) {
    return {
      query,
      totalHits: 0,
      sessionHits: []
    };
  }

  const normalizedQuery = normalizeForSearch(query);
  const queryTokens = new Set(toTokens(query));
  const minOverlap =
    queryTokens.size <= 1 ? 1 : queryTokens.size <= 3 ? 2 : Math.ceil(queryTokens.size * 0.6);
  const shortQuery = normalizedQuery.length < 4;

  const aggregates = new Map<
    string,
    {
      sessionKey: string;
      threadId: string;
      deviceId: string;
      sessionTitle: string;
      deviceLabel: string;
      deviceAddress: string;
      updatedAt: string;
      maxScore: number;
      hitCount: number;
    }
  >();
  let totalHits = 0;

  for (const session of demoSearchSessions.values()) {
    if (request.deviceId && session.deviceId !== request.deviceId) {
      continue;
    }

    for (const message of session.messages) {
      const normalizedMessage = normalizeForSearch(message.content);
      if (!normalizedMessage) {
        continue;
      }

      const contains = normalizedMessage.includes(normalizedQuery);
      if (shortQuery && !contains) {
        continue;
      }

      const messageTokens = new Set(toTokens(message.content));
      const overlap = [...queryTokens].filter((token) => messageTokens.has(token)).length;
      if (!contains && overlap < minOverlap) {
        continue;
      }

      const score = contains ? 1 : normalizedLevenshtein(normalizedQuery, normalizedMessage);
      if (score < threshold) {
        continue;
      }

      totalHits += 1;
      const existing = aggregates.get(session.sessionKey);
      if (!existing) {
        aggregates.set(session.sessionKey, {
          sessionKey: session.sessionKey,
          threadId: session.threadId,
          deviceId: session.deviceId,
          sessionTitle: session.sessionTitle,
          deviceLabel: session.deviceLabel,
          deviceAddress: session.deviceAddress,
          updatedAt: session.updatedAt,
          maxScore: score,
          hitCount: 1
        });
        continue;
      }

      existing.maxScore = Math.max(existing.maxScore, score);
      existing.hitCount += 1;
    }
  }

  const sessionHits = [...aggregates.values()]
    .sort((a, b) => {
      if (b.maxScore !== a.maxScore) {
        return b.maxScore - a.maxScore;
      }
      if (b.hitCount !== a.hitCount) {
        return b.hitCount - a.hitCount;
      }
      const aMs = Date.parse(a.updatedAt);
      const bMs = Date.parse(b.updatedAt);
      if (!Number.isNaN(aMs) && !Number.isNaN(bMs) && bMs !== aMs) {
        return bMs - aMs;
      }
      return a.sessionKey.localeCompare(b.sessionKey);
    })
    .slice(0, maxSessions);

  return {
    query,
    totalHits,
    sessionHits
  };
};

const invoke = async <T>(
  command: string,
  args: Record<string, unknown> = {}
): Promise<T> => {
  if (isTauriRuntime()) {
    return tauriInvoke<T>(command, args);
  }
  return mockInvoke<T>(command, args);
};

export const listDevices = async (): Promise<DeviceRecord[]> => invoke("device_list");

export const addLocalDevice = async (
  request: DeviceAddLocalRequest
): Promise<DeviceRecord> => invoke("device_add_local", { request });

export const addSshDevice = async (
  request: DeviceAddSshRequest
): Promise<DeviceRecord> => invoke("device_add_ssh", { request });

export const connectDevice = async (deviceId: string): Promise<DeviceRecord> =>
  invoke("device_connect", { request: { deviceId } });

export const disconnectDevice = async (deviceId: string): Promise<DeviceRecord> =>
  invoke("device_disconnect", { request: { deviceId } });

export const removeDevice = async (deviceId: string): Promise<DeviceRecord[]> =>
  invoke("device_remove", { request: { deviceId } });

export const searchIndexUpsertThread = async (
  request: SearchIndexThreadPayload
): Promise<void> => invoke("search_index_upsert_thread", { request });

export const searchIndexRemoveDevice = async (deviceId: string): Promise<void> =>
  invoke("search_index_remove_device", { request: { deviceId } });

export const searchQuery = async (
  request: SearchQueryRequest
): Promise<SearchQueryResponse> => invoke("search_query", { request });

export const searchBootstrapStatus = async (): Promise<SearchBootstrapStatus> =>
  invoke("search_bootstrap_status");
