import { memo, useMemo, useState } from "react";
import type {
  DirectoryBrowseResult,
  DirectoryEntry,
  DeviceAddSshRequest,
  DeviceRecord,
  SessionSummary
} from "../domain/types";
import { groupSessionsByFolder } from "./sidebarGrouping";

interface SidebarProps {
  devices: DeviceRecord[];
  sessions: SessionSummary[];
  selectedSessionKey: string | null;
  loading: boolean;
  onSelectSession: (sessionKey: string) => void;
  onConnect: (deviceId: string) => void;
  onDisconnect: (deviceId: string) => void;
  onRemove: (deviceId: string) => void;
  onRefreshDevice: (deviceId: string) => void;
  onBrowseDirectories: (
    deviceId: string,
    cwd: string
  ) => Promise<DirectoryBrowseResult>;
  onStartNewSession: (deviceId: string, cwd: string) => Promise<void>;
  onAddSsh: (request: DeviceAddSshRequest) => void;
}

const parseTimestampMs = (timestamp: string): number => {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? -1 : parsed;
};

const formatTimestamp = (timestamp: string): string => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) {
    return "0m";
  }

  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;
  const monthMs = 30 * dayMs;
  const yearMs = 365 * dayMs;

  if (diffMs < hourMs) {
    return `${Math.max(1, Math.floor(diffMs / minuteMs))}m`;
  }
  if (diffMs < dayMs) {
    return `${Math.floor(diffMs / hourMs)}h`;
  }
  if (diffMs < weekMs) {
    return `${Math.floor(diffMs / dayMs)}d`;
  }
  if (diffMs < monthMs) {
    return `${Math.floor(diffMs / weekMs)}w`;
  }
  if (diffMs < yearMs) {
    return `${Math.floor(diffMs / monthMs)}mo`;
  }
  return `${Math.floor(diffMs / yearMs)}y`;
};

const toStatus = (device: DeviceRecord): "connected" | "disconnected" | "error" => {
  if (device.lastError) {
    return "error";
  }
  return device.connected ? "connected" : "disconnected";
};

const statusLabel = (status: "connected" | "disconnected" | "error"): string => {
  if (status === "connected") {
    return "online";
  }
  if (status === "error") {
    return "error";
  }
  return "offline";
};

const deviceAddress = (device: DeviceRecord): string => {
  if (device.config.kind === "ssh") {
    return `${device.config.user}@${device.config.host}`;
  }
  return "local";
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return "Operation failed.";
};

function Sidebar({
  devices,
  sessions,
  selectedSessionKey,
  loading,
  onSelectSession,
  onConnect,
  onDisconnect,
  onRemove,
  onRefreshDevice,
  onBrowseDirectories,
  onStartNewSession,
  onAddSsh
}: SidebarProps) {
  const [sshName, setSshName] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshUser, setSshUser] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [remoteAppServerPort, setRemoteAppServerPort] = useState("45231");
  const [localForwardPort, setLocalForwardPort] = useState("");
  const [sshCodexBin, setSshCodexBin] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [sshFormOpen, setSshFormOpen] = useState(false);
  const [collapsedByDevice, setCollapsedByDevice] = useState<Record<string, boolean>>({});
  const [collapsedByFolder, setCollapsedByFolder] = useState<Record<string, boolean>>({});
  const [newSessionOpenByDevice, setNewSessionOpenByDevice] = useState<
    Record<string, boolean>
  >({});
  const [newSessionPathByDevice, setNewSessionPathByDevice] = useState<
    Record<string, string>
  >({});
  const [newSessionEntriesByDevice, setNewSessionEntriesByDevice] = useState<
    Record<string, DirectoryEntry[]>
  >({});
  const [newSessionLoadingByDevice, setNewSessionLoadingByDevice] = useState<
    Record<string, boolean>
  >({});
  const [newSessionStartingByDevice, setNewSessionStartingByDevice] = useState<
    Record<string, boolean>
  >({});
  const [newSessionErrorByDevice, setNewSessionErrorByDevice] = useState<
    Record<string, string | undefined>
  >({});

  const sessionsByDevice = useMemo(() => {
    const grouped = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const list = grouped.get(session.deviceId) ?? [];
      list.push(session);
      grouped.set(session.deviceId, list);
    }

    for (const list of grouped.values()) {
      list.sort((a, b) => parseTimestampMs(b.updatedAt) - parseTimestampMs(a.updatedAt));
    }

    return grouped;
  }, [sessions]);

  const folderGroupsByDevice = useMemo(() => {
    const grouped = new Map<string, ReturnType<typeof groupSessionsByFolder>>();
    for (const [deviceId, deviceSessions] of sessionsByDevice.entries()) {
      grouped.set(deviceId, groupSessionsByFolder(deviceSessions));
    }
    return grouped;
  }, [sessionsByDevice]);

  const loadDirectoryEntries = async (deviceId: string, cwd: string): Promise<void> => {
    setNewSessionLoadingByDevice((previous) => ({ ...previous, [deviceId]: true }));
    setNewSessionErrorByDevice((previous) => ({ ...previous, [deviceId]: undefined }));
    try {
      const result = await onBrowseDirectories(deviceId, cwd);
      setNewSessionPathByDevice((previous) => ({
        ...previous,
        [deviceId]: result.cwd
      }));
      setNewSessionEntriesByDevice((previous) => ({
        ...previous,
        [deviceId]: result.entries
      }));
    } catch (error) {
      setNewSessionErrorByDevice((previous) => ({
        ...previous,
        [deviceId]: toErrorMessage(error)
      }));
    } finally {
      setNewSessionLoadingByDevice((previous) => ({ ...previous, [deviceId]: false }));
    }
  };

  return (
    <aside className="sidebar">
      <header className="sidebar__header">
        <p className="sidebar__eyebrow">Sessions</p>
        <h1 className="sidebar__title">Codex Monitor</h1>
      </header>

      <section className="sidebar__new-device">
        <details
          open={sshFormOpen}
          onToggle={(event) => {
            setSshFormOpen((event.currentTarget as HTMLDetailsElement).open);
          }}
        >
          <summary>Add SSH device</summary>
          <form
            className="sidebar__new-device-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!sshHost.trim() || !sshUser.trim()) {
                return;
              }

              onAddSsh({
                name: sshName.trim() || undefined,
                host: sshHost.trim(),
                user: sshUser.trim(),
                sshPort: Number.parseInt(sshPort, 10) || 22,
                remoteAppServerPort:
                  Number.parseInt(remoteAppServerPort, 10) || 45231,
                localForwardPort:
                  Number.parseInt(localForwardPort, 10) || undefined,
                codexBin: sshCodexBin.trim() || undefined,
                identityFile: identityFile.trim() || undefined
              });
              setSshFormOpen(false);
            }}
          >
            <input
              value={sshName}
              onChange={(event) => setSshName(event.target.value)}
              placeholder="Display name (optional)"
            />
            <input
              value={sshHost}
              onChange={(event) => setSshHost(event.target.value)}
              placeholder="Host or IP"
              required
            />
            <input
              value={sshUser}
              onChange={(event) => setSshUser(event.target.value)}
              placeholder="Username"
              required
            />
            <input
              value={sshPort}
              onChange={(event) => setSshPort(event.target.value)}
              placeholder="SSH port"
            />
            <input
              value={remoteAppServerPort}
              onChange={(event) => setRemoteAppServerPort(event.target.value)}
              placeholder="Remote app-server port (default 45231)"
            />
            <input
              value={localForwardPort}
              onChange={(event) => setLocalForwardPort(event.target.value)}
              placeholder="Local forward port (optional, fixed)"
            />
            <input
              value={sshCodexBin}
              onChange={(event) => setSshCodexBin(event.target.value)}
              placeholder="Codex binary path (optional)"
            />
            <input
              value={identityFile}
              onChange={(event) => setIdentityFile(event.target.value)}
              placeholder="Identity file path (optional)"
            />
            <button type="submit" disabled={loading || !sshHost || !sshUser}>
              Add SSH
            </button>
          </form>
        </details>
      </section>

      <div className="sidebar__groups">
        {devices.length === 0 ? (
          <p className="sidebar__empty">No devices configured yet.</p>
        ) : null}

        {devices.map((device) => {
          const status = toStatus(device);
          const deviceSessions = sessionsByDevice.get(device.id) ?? [];
          const folderGroups = folderGroupsByDevice.get(device.id) ?? [];
          const isCollapsed = collapsedByDevice[device.id] ?? false;
          const isLocalDevice = device.config.kind === "local";
          const fallbackSessionPath = deviceSessions[0]?.cwd;
          const fallbackWorkspaceRoot = device.config.workspaceRoot;
          const defaultNewSessionPath =
            (fallbackSessionPath ?? fallbackWorkspaceRoot ?? ".").trim() || ".";
          const isNewSessionOpen = newSessionOpenByDevice[device.id] ?? false;
          const newSessionPath =
            newSessionPathByDevice[device.id] ?? defaultNewSessionPath;
          const newSessionEntries = newSessionEntriesByDevice[device.id] ?? [];
          const newSessionLoading = newSessionLoadingByDevice[device.id] ?? false;
          const newSessionStarting = newSessionStartingByDevice[device.id] ?? false;
          const newSessionError = newSessionErrorByDevice[device.id];

          return (
            <section key={device.id} className="sidebar__device-group">
              <div className="sidebar__device-meta">
                <div className="sidebar__device-meta-main">
                  <button
                    type="button"
                    className="sidebar__collapse-toggle"
                    onClick={() =>
                      setCollapsedByDevice((previous) => ({
                        ...previous,
                        [device.id]: !isCollapsed
                      }))
                    }
                    aria-label={isCollapsed ? `Expand ${device.name}` : `Collapse ${device.name}`}
                    aria-expanded={!isCollapsed}
                  >
                    {isCollapsed ? "▸" : "▾"}
                  </button>
                  <div>
                    <h2>{device.name}</h2>
                    <p>
                      {device.config.kind.toUpperCase()} • {deviceAddress(device)}
                    </p>
                  </div>
                </div>
                <span className={`status-pill status-pill--${status}`}>
                  {statusLabel(status)}
                </span>
              </div>

              <div className="sidebar__device-actions">
                {device.connected ? (
                  !isLocalDevice ? (
                    <button
                      type="button"
                      onClick={() => onDisconnect(device.id)}
                      disabled={loading}
                    >
                      Disconnect
                    </button>
                  ) : null
                ) : (
                  <button
                    type="button"
                    onClick={() => onConnect(device.id)}
                    disabled={loading}
                  >
                    Connect
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onRefreshDevice(device.id)}
                  disabled={loading || !device.connected}
                >
                  Refresh
                </button>
                {device.connected ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (isNewSessionOpen) {
                        setNewSessionOpenByDevice((previous) => ({
                          ...previous,
                          [device.id]: false
                        }));
                        return;
                      }

                      setNewSessionOpenByDevice((previous) => ({
                        ...previous,
                        [device.id]: true
                      }));
                      setNewSessionPathByDevice((previous) => ({
                        ...previous,
                        [device.id]: newSessionPath
                      }));
                      void loadDirectoryEntries(device.id, newSessionPath);
                    }}
                    disabled={loading}
                  >
                    {isNewSessionOpen ? "Close" : "New Session"}
                  </button>
                ) : null}
                {!isLocalDevice ? (
                  <button
                    type="button"
                    onClick={() => onRemove(device.id)}
                    disabled={loading}
                  >
                    Remove
                  </button>
                ) : null}
              </div>

              {isNewSessionOpen ? (
                <form
                  className="sidebar__new-session"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const trimmedPath = newSessionPath.trim();
                    if (!trimmedPath) {
                      setNewSessionErrorByDevice((previous) => ({
                        ...previous,
                        [device.id]: "Path is required."
                      }));
                      return;
                    }

                    setNewSessionStartingByDevice((previous) => ({
                      ...previous,
                      [device.id]: true
                    }));
                    setNewSessionErrorByDevice((previous) => ({
                      ...previous,
                      [device.id]: undefined
                    }));
                    void onStartNewSession(device.id, trimmedPath)
                      .then(() => {
                        setNewSessionOpenByDevice((previous) => ({
                          ...previous,
                          [device.id]: false
                        }));
                      })
                      .catch((error: unknown) => {
                        setNewSessionErrorByDevice((previous) => ({
                          ...previous,
                          [device.id]: toErrorMessage(error)
                        }));
                      })
                      .finally(() => {
                        setNewSessionStartingByDevice((previous) => ({
                          ...previous,
                          [device.id]: false
                        }));
                      });
                  }}
                >
                  <label className="sidebar__new-session-label" htmlFor={`new-session-path-${device.id}`}>
                    Start folder path
                  </label>
                  <div className="sidebar__new-session-path-row">
                    <input
                      id={`new-session-path-${device.id}`}
                      value={newSessionPath}
                      onChange={(event) =>
                        setNewSessionPathByDevice((previous) => ({
                          ...previous,
                          [device.id]: event.target.value
                        }))
                      }
                      placeholder="Enter folder path"
                    />
                    <button
                      type="button"
                      disabled={loading || newSessionLoading || newSessionStarting}
                      onClick={() => {
                        void loadDirectoryEntries(device.id, newSessionPath);
                      }}
                    >
                      Browse
                    </button>
                    <button
                      type="submit"
                      disabled={loading || newSessionLoading || newSessionStarting}
                    >
                      {newSessionStarting ? "Creating Session..." : "Start Session"}
                    </button>
                  </div>

                  {newSessionLoading ? (
                    <p className="sidebar__new-session-status">Loading folders...</p>
                  ) : null}

                  {newSessionEntries.length > 0 ? (
                    <ul className="sidebar__new-session-list">
                      {newSessionEntries.map((entry) => (
                        <li key={`${entry.kind}:${entry.path}`}>
                          <button
                            type="button"
                            onClick={() => {
                              void loadDirectoryEntries(device.id, entry.path);
                            }}
                            disabled={newSessionStarting}
                          >
                            {entry.kind === "parent" ? ".." : entry.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {!newSessionLoading && newSessionEntries.length === 0 ? (
                    <p className="sidebar__new-session-status">No subfolders.</p>
                  ) : null}

                  {newSessionError ? (
                    <p className="sidebar__new-session-error">{newSessionError}</p>
                  ) : null}
                </form>
              ) : null}

              {device.lastError ? (
                <p className="sidebar__device-error">{device.lastError}</p>
              ) : null}

              {!isCollapsed ? (
                <ul className="sidebar__folder-list">
                  {deviceSessions.length === 0 ? (
                    <li className="sidebar__empty">No sessions</li>
                  ) : (
                    folderGroups.map((group) => {
                      const folderStateKey = `${device.id}::${group.key}`;
                      const isFolderCollapsed = collapsedByFolder[folderStateKey] ?? true;

                      return (
                        <li key={folderStateKey} className="sidebar__folder-group">
                          <button
                            type="button"
                            className="sidebar__folder-toggle"
                            onClick={() =>
                              setCollapsedByFolder((previous) => ({
                                ...previous,
                                [folderStateKey]: !isFolderCollapsed
                              }))
                            }
                            aria-expanded={!isFolderCollapsed}
                            aria-label={
                              isFolderCollapsed
                                ? `Expand folder ${group.label}`
                                : `Collapse folder ${group.label}`
                            }
                          >
                            <span className="sidebar__folder-toggle-icon" aria-hidden="true">
                              {isFolderCollapsed ? "▸" : "▾"}
                            </span>
                            <span className="sidebar__folder-label">{group.label}</span>
                            <span className="sidebar__folder-count">
                              {group.sessions.length}
                            </span>
                          </button>

                          {!isFolderCollapsed ? (
                            <ul className="sidebar__folder-session-list">
                              {group.sessions.map((session) => (
                                <li key={session.key}>
                                  <button
                                    type="button"
                                    className={`session-row ${
                                      selectedSessionKey === session.key
                                        ? "session-row--active"
                                        : ""
                                    }`}
                                    title={session.title}
                                    onClick={() => onSelectSession(session.key)}
                                  >
                                    <div className="session-row__meta">
                                      <div className="session-row__title-wrap">
                                        <strong className="session-row__title">
                                          {session.title}
                                        </strong>
                                      </div>
                                      <span
                                        className="session-row__timestamp"
                                        title={new Date(session.updatedAt).toLocaleString()}
                                      >
                                        {formatTimestamp(session.updatedAt)}
                                      </span>
                                    </div>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      );
                    })
                  )}
                </ul>
              ) : (
                <p className="sidebar__collapsed-note">
                  {deviceSessions.length} session{deviceSessions.length === 1 ? "" : "s"} hidden
                </p>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

export default memo(Sidebar);
