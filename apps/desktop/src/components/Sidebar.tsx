import { useMemo, useState } from "react";
import type {
  DeviceAddSshRequest,
  DeviceRecord,
  SessionSummary
} from "../domain/types";

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

const folderChipText = (session: SessionSummary): string => {
  if (session.folderName) {
    return session.folderName;
  }
  if (session.cwd) {
    const normalized = session.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    const parts = normalized.split("/");
    return parts[parts.length - 1] || "unknown-folder";
  }
  return "unknown-folder";
};

export default function Sidebar({
  devices,
  sessions,
  selectedSessionKey,
  loading,
  onSelectSession,
  onConnect,
  onDisconnect,
  onRemove,
  onRefreshDevice,
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
  const [collapsedByDevice, setCollapsedByDevice] = useState<Record<string, boolean>>({});

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

  return (
    <aside className="sidebar">
      <header className="sidebar__header">
        <p className="sidebar__eyebrow">Sessions</p>
        <h1 className="sidebar__title">Codex Monitor</h1>
      </header>

      <section className="sidebar__new-device">
        <details>
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
          const isCollapsed = collapsedByDevice[device.id] ?? false;

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
                  <button
                    type="button"
                    onClick={() => onDisconnect(device.id)}
                    disabled={loading}
                  >
                    Disconnect
                  </button>
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
                <button
                  type="button"
                  onClick={() => onRemove(device.id)}
                  disabled={loading}
                >
                  Remove
                </button>
              </div>

              {device.lastError ? (
                <p className="sidebar__device-error">{device.lastError}</p>
              ) : null}

              {!isCollapsed ? (
                <ul className="sidebar__session-list">
                  {deviceSessions.length === 0 ? (
                    <li className="sidebar__empty">No sessions</li>
                  ) : (
                    deviceSessions.map((session) => (
                      <li key={session.key}>
                        <button
                          type="button"
                          className={`session-row ${
                            selectedSessionKey === session.key ? "session-row--active" : ""
                          }`}
                          title={session.title}
                          onClick={() => onSelectSession(session.key)}
                        >
                          <div className="session-row__meta">
                            <strong className="session-row__title">{session.title}</strong>
                            <span
                              className="session-row__timestamp"
                              title={new Date(session.updatedAt).toLocaleString()}
                            >
                              {formatTimestamp(session.updatedAt)}
                            </span>
                          </div>
                          <span className="session-row__folder-chip">
                            {folderChipText(session)}
                          </span>
                        </button>
                      </li>
                    ))
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
