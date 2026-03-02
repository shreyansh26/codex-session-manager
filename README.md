# Codex Session Monitor (Desktop)

A Tauri + React desktop app that monitors Codex sessions across:

- Local machine
- SSH-connected remote machines

It supports:

- Unified session sidebar grouped by device
- Open chat for any session
- Continue chat (`thread/resume` + `turn/start`)
- Turn progress tracking from app-server notifications

## Prerequisites

- Node.js 20+
- Rust toolchain (for Tauri host build)
- `codex` CLI on local and remote devices
- `ssh` client configured for remote hosts

Authentication is out-of-band: run `codex login` on each target device first.

## Run frontend checks

```bash
cd apps/desktop
npm install
npm run typecheck
npm run test
npm run build
```

## Run desktop app

```bash
cd apps/desktop
npm install
npm run tauri dev
```

## Build binaries and shareable apps

Use this split workflow:

- Day-to-day development:

```bash
cd apps/desktop
npm run tauri -- dev
```

- Local release binary only (no installer/dmg):

```bash
cd apps/desktop
npm run tauri -- build --no-bundle
```

- Shareable macOS app + dmg (one-off):

```bash
cd apps/desktop
npm run tauri -- build -c '{"bundle":{"active":true}}' --bundles app,dmg
```

Build outputs are generated under `apps/desktop/src-tauri/target/release/`.

## Notes

- Device metadata is persisted by Tauri in local app data (`codex-session-monitor/devices.json`).
- Runtime process state is ephemeral; devices load disconnected after app restart.
- If a device reports authentication issues, run `codex login` on that device and reconnect.
