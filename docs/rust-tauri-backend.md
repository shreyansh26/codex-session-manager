# Rust/Tauri Backend Integration

This document covers the backend implementation in `apps/desktop/src-tauri/` for device lifecycle and Codex app-server orchestration.

## Workspace and Package Layout

- Root workspace manifest: `Cargo.toml`
- Tauri package manifest: `apps/desktop/src-tauri/Cargo.toml`
- Tauri runtime config: `apps/desktop/src-tauri/tauri.conf.json`
- Tauri capability config: `apps/desktop/src-tauri/capabilities/default.json`
- Rust sources:
  - `apps/desktop/src-tauri/src/main.rs`
  - `apps/desktop/src-tauri/src/commands/device.rs`
  - `apps/desktop/src-tauri/src/state/models.rs`
  - `apps/desktop/src-tauri/src/state/app_state.rs`

## Command Surface

The backend exposes Tauri invoke commands:

- `device_add_local`
- `device_add_ssh`
- `device_list`
- `device_connect`
- `device_disconnect`
- `device_remove`

All command inputs/outputs are JSON-serializable structs in `src/state/models.rs`.

## Process Lifecycle Model

### Local device

`device_connect` starts:

`codex app-server --listen ws://127.0.0.1:<port>`

`<port>` is either configured in the device or auto-allocated.

Returned websocket endpoint:

`ws://127.0.0.1:<port>`

`device_disconnect` terminates that child process.

### SSH device

`device_connect` starts two managed processes:

1. Remote app-server over SSH:
   - `ssh ... <user>@<host> "<codex_bin> app-server --listen ws://127.0.0.1:<remote_port>"`
2. Local SSH tunnel:
   - `ssh ... -N -L <local_forward_port>:127.0.0.1:<remote_port> <user>@<host>`

Returned websocket endpoint:

`ws://127.0.0.1:<local_forward_port>`

`device_disconnect` shuts down the tunnel and remote-server SSH process handles.

When the desktop process exits, `AppState::drop` drains and terminates any remaining managed subprocesses.

## Persistence

Device definitions are persisted in `devices.json` under the OS local data directory, e.g.:

`<data_local_dir>/codex-session-monitor/devices.json`

Runtime connection state is not persisted; devices load as disconnected on startup.

## Runtime Assumptions

- `codex` and `ssh` are available on PATH unless overridden by `codex_bin`.
- Authentication for remote hosts is already configured (`ssh-agent`, key, or equivalent).
- Codex authentication is done out-of-band via `codex login` on each device.
