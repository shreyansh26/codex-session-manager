import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  DeviceAddLocalRequest,
  DeviceAddSshRequest,
  DeviceRecord
} from "../domain/types";

const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let demoDevices: DeviceRecord[] = [];

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
      return clone(demoDevices) as T;
    }
    default:
      throw new Error(`Unknown command in demo mode: ${command}`);
  }
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
