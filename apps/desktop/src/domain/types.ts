export type DeviceKind = "local" | "ssh";
export type ChatRole = "user" | "assistant" | "system" | "tool";
export type ThinkingEffort = "low" | "medium" | "high" | "xhigh";

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
  images?: ChatImageAttachment[];
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface ThreadTokenUsageState extends ThreadTokenUsage {
  threadId: string;
  turnId?: string;
  updatedAt: string;
}

export interface SessionCostDisplay {
  model?: string;
  tokenUsage?: ThreadTokenUsageState;
  usdCost?: number;
  costAvailable: boolean;
}

export interface ChatImageAttachment {
  id: string;
  url: string;
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
}

export interface ComposerSubmission {
  prompt: string;
  images: ChatImageAttachment[];
  model: string;
  thinkingEffort: ThinkingEffort;
}

export interface ComposerPreference {
  model: string;
  thinkingEffort: ThinkingEffort;
}

export interface ThreadPayload {
  session: SessionSummary;
  messages: ChatMessage[];
  model?: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: "parent" | "directory";
}

export interface DirectoryBrowseResult {
  cwd: string;
  entries: DirectoryEntry[];
}

export interface NewSessionRequest {
  deviceId: string;
  cwd: string;
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

export interface SearchIndexMessagePayload {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface SearchIndexThreadPayload {
  sessionKey: string;
  threadId: string;
  deviceId: string;
  sessionTitle: string;
  deviceLabel: string;
  deviceAddress: string;
  updatedAt: string;
  messages: SearchIndexMessagePayload[];
}

export interface SearchQueryRequest {
  query: string;
  deviceId?: string;
  threshold?: number;
  maxSessions?: number;
}

export interface SearchSessionHit {
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

export interface SearchQueryResponse {
  query: string;
  totalHits: number;
  sessionHits: SearchSessionHit[];
}

export interface SearchBootstrapStatus {
  indexedSessions: number;
  indexedMessages: number;
  lastUpdatedAtMs?: number;
}
