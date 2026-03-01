export type DeviceKind = "local" | "ssh";
export type ChatRole = "user" | "assistant" | "system" | "tool";
export type TurnStatus = "idle" | "running" | "completed" | "failed";

export interface DeviceConnection {
  endpoint: string;
  transport: string;
  connectedAtMs: number;
  localServerPid?: number;
  sshRemotePid?: number;
  sshForwardPid?: number;
}

export interface LocalDeviceConfig {
  kind: "local";
  appServerPort?: number;
  codexBin?: string;
  workspaceRoot?: string;
}

export interface SshDeviceConfig {
  kind: "ssh";
  host: string;
  user: string;
  sshPort: number;
  identityFile?: string;
  remoteAppServerPort: number;
  localForwardPort?: number;
  codexBin?: string;
  workspaceRoot?: string;
}

export type DeviceConfig = LocalDeviceConfig | SshDeviceConfig;

export interface DeviceRecord {
  id: string;
  name: string;
  config: DeviceConfig;
  connected: boolean;
  connection?: DeviceConnection;
  lastError?: string;
}

export interface SessionSummary {
  key: string;
  threadId: string;
  deviceId: string;
  deviceLabel: string;
  deviceAddress: string;
  title: string;
  preview: string;
  updatedAt: string;
  cwd?: string;
  folderName?: string;
}

export interface ChatMessage {
  eventType?: "reasoning" | "activity";
  id: string;
  key: string;
  threadId: string;
  deviceId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface ThreadPayload {
  session: SessionSummary;
  messages: ChatMessage[];
}

export interface DeviceAddLocalRequest {
  name?: string;
  appServerPort?: number;
  codexBin?: string;
  workspaceRoot?: string;
}

export interface DeviceAddSshRequest {
  name?: string;
  host: string;
  user: string;
  sshPort?: number;
  identityFile?: string;
  remoteAppServerPort?: number;
  localForwardPort?: number;
  codexBin?: string;
  workspaceRoot?: string;
}

export interface RpcNotification {
  method: string;
  params: unknown;
}

export interface ThreadIdentifier {
  deviceId: string;
  threadId: string;
}
