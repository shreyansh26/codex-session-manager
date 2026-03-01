# Codex Session Monitor Architecture

## Overview

The desktop app is a Tauri host (`apps/desktop/src-tauri`) with a React frontend (`apps/desktop/src`).

It monitors Codex sessions from:

- Local machine (`codex app-server --listen ws://127.0.0.1:<port>`).
- SSH devices (remote app-server + local SSH port forwarding).

## Runtime Flow

1. Frontend starts and calls Tauri commands to list configured devices.
2. User connects a device from the sidebar.
3. Tauri starts the required local/remote processes and returns a websocket endpoint.
4. Frontend opens a JSON-RPC websocket to that endpoint and initializes the app-server session.
5. Frontend calls:
   - `thread/list` to build sidebar sessions.
   - `thread/read` when a session is selected.
   - `thread/resume` + `turn/start` when sending a new prompt.
6. Frontend consumes websocket notifications (`turn/started`, `turn/completed`, `turn/failed`, `item/completed`) to update progress and refresh thread state.

## Data Model

- `DeviceRecord`: local or SSH device configuration and current connection info.
- `SessionSummary`: sidebar row, keyed by `deviceId::threadId`.
- `ChatMessage`: normalized chat item for timeline rendering.
- `TurnStatus`: `idle | running | completed | failed`.

## Process Ownership

- Local device: one managed child process (`codex app-server`).
- SSH device: two managed child processes:
  - SSH process running remote app-server command.
  - SSH process providing local `-L` tunnel.

All managed processes are terminated on disconnect and on app shutdown.

## Persistence

Tauri persists device metadata to:

- macOS/Linux fallback path: `<data_local_dir>/codex-session-monitor/devices.json`

Connection/process runtime state is not persisted.

## Authentication

Authentication is out-of-band:

- User runs `codex login` on each device.
- App uses `account/read` when available to verify authenticated state.
- If not authenticated, device row surfaces actionable error.
