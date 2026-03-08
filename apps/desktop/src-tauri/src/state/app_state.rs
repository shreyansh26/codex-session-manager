use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use thiserror::Error;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::state::models::{
    DeviceAddLocalRequest, DeviceAddSshRequest, DeviceConfig, DeviceConnection, DeviceRecord,
    LocalDeviceConfig, PersistedDevices, SshDeviceConfig, DEFAULT_REMOTE_APP_SERVER_PORT,
    DEFAULT_SSH_PORT,
};
use crate::state::search_index::{
    SearchBootstrapStatus, SearchIndex, SearchIndexStorageError, SearchIndexThreadPayload,
    SearchQueryRequest, SearchQueryResponse,
};

const DEFAULT_APP_SERVER_APPROVAL_CONFIG: &str = "approval_policy=\"never\"";
const DEFAULT_APP_SERVER_SANDBOX_CONFIG: &str = "sandbox_mode=\"danger-full-access\"";

pub struct AppState {
    inner: Mutex<InnerState>,
    storage_path: PathBuf,
    search_index: Mutex<SearchIndex>,
    search_index_path: PathBuf,
}

#[derive(Default)]
struct InnerState {
    devices: HashMap<String, DeviceRecord>,
    connections: HashMap<String, ConnectionRuntime>,
}

#[derive(Debug)]
struct ConnectionRuntime {
    endpoint: String,
    local_server: Option<ManagedProcess>,
    ssh_remote_server: Option<ManagedProcess>,
    ssh_forwarder: Option<ManagedProcess>,
}

#[derive(Debug)]
struct ManagedProcess {
    role: &'static str,
    pid: u32,
    child: Child,
}

#[derive(Debug, Error)]
pub enum AppStateError {
    #[error("device not found: {device_id}")]
    DeviceNotFound { device_id: String },
    #[error("state lock poisoned")]
    StatePoisoned,
    #[error("failed to allocate a free local port: {source}")]
    FreePort { source: io::Error },
    #[error("failed to spawn {role} process `{program}` with args {args:?}: {source}")]
    SpawnProcess {
        role: String,
        program: String,
        args: Vec<String>,
        source: io::Error,
    },
    #[error("{role} process exited before becoming ready (status: {status})")]
    ProcessExited { role: String, status: ExitStatus },
    #[error("failed to inspect {role} process lifecycle: {source}")]
    ProcessInspect { role: String, source: io::Error },
    #[error("failed to stop {role} process: {source}")]
    StopProcess { role: String, source: io::Error },
    #[error("endpoint did not become ready: {endpoint} within {timeout_ms}ms")]
    EndpointNotReady { endpoint: String, timeout_ms: u64 },
    #[error("disconnect had one or more process shutdown errors: {0}")]
    DisconnectErrors(String),
    #[error("failed to persist device metadata at {path}: {source}")]
    PersistDevices { path: String, source: io::Error },
    #[error("failed to parse persisted device metadata at {path}: {source}")]
    ParseDevices {
        path: String,
        source: serde_json::Error,
    },
    #[error("search index lock poisoned")]
    SearchIndexPoisoned,
    #[error("failed to persist search index at {path}: {source}")]
    PersistSearchIndex { path: String, source: io::Error },
    #[error("failed to parse search index at {path}: {source}")]
    ParseSearchIndex {
        path: String,
        source: serde_json::Error,
    },
}

impl Default for AppState {
    fn default() -> Self {
        let storage_path = device_storage_path();
        let search_index_path = search_index_storage_path();
        let devices = match load_devices(&storage_path) {
            Ok(records) => records,
            Err(error) => {
                warn!(error = %error, "failed to load persisted device metadata; using empty device list");
                HashMap::new()
            }
        };
        let search_index = match SearchIndex::load_from_path(&search_index_path) {
            Ok(index) => index,
            Err(error) => {
                warn!(
                    error = %error,
                    path = %search_index_path.display(),
                    "failed to load persisted search index; using empty index"
                );
                SearchIndex::default()
            }
        };

        Self {
            inner: Mutex::new(InnerState {
                devices,
                connections: HashMap::new(),
            }),
            storage_path,
            search_index: Mutex::new(search_index),
            search_index_path,
        }
    }
}

impl AppState {
    pub fn add_local_device(
        &self,
        request: DeviceAddLocalRequest,
    ) -> Result<DeviceRecord, AppStateError> {
        let config = LocalDeviceConfig {
            app_server_port: request.app_server_port,
            codex_bin: request.codex_bin,
            workspace_root: request.workspace_root,
        };

        let display_port = config
            .app_server_port
            .map(|port| port.to_string())
            .unwrap_or_else(|| "auto".to_owned());

        let record = DeviceRecord {
            id: Uuid::new_v4().to_string(),
            name: request
                .name
                .unwrap_or_else(|| format!("Local ({display_port})")),
            config: DeviceConfig::Local(config),
            connected: false,
            connection: None,
            last_error: None,
        };

        {
            let mut inner = self.lock_inner()?;
            inner.devices.insert(record.id.clone(), record.clone());
            self.persist_devices_locked(&inner)?;
        }

        Ok(record)
    }

    pub fn add_ssh_device(
        &self,
        request: DeviceAddSshRequest,
    ) -> Result<DeviceRecord, AppStateError> {
        let config = SshDeviceConfig {
            host: request.host,
            user: request.user,
            ssh_port: request.ssh_port.unwrap_or(DEFAULT_SSH_PORT),
            identity_file: request.identity_file,
            remote_app_server_port: request
                .remote_app_server_port
                .unwrap_or(DEFAULT_REMOTE_APP_SERVER_PORT),
            local_forward_port: request.local_forward_port,
            codex_bin: request.codex_bin,
            workspace_root: request.workspace_root,
        };

        let record = DeviceRecord {
            id: Uuid::new_v4().to_string(),
            name: request
                .name
                .unwrap_or_else(|| format!("{}@{}", config.user, config.host)),
            config: DeviceConfig::Ssh(config),
            connected: false,
            connection: None,
            last_error: None,
        };

        {
            let mut inner = self.lock_inner()?;
            inner.devices.insert(record.id.clone(), record.clone());
            self.persist_devices_locked(&inner)?;
        }

        Ok(record)
    }

    pub fn list_devices(&self) -> Result<Vec<DeviceRecord>, AppStateError> {
        let inner = self.lock_inner()?;
        let mut records = inner.devices.values().cloned().collect::<Vec<_>>();
        records.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        Ok(records)
    }

    pub fn remove_device(&self, device_id: &str) -> Result<Vec<DeviceRecord>, AppStateError> {
        self.disconnect_if_connected(device_id)?;

        {
            let mut inner = self.lock_inner()?;
            inner
                .devices
                .remove(device_id)
                .ok_or_else(|| AppStateError::DeviceNotFound {
                    device_id: device_id.to_owned(),
                })?;
            self.persist_devices_locked(&inner)?;
        }

        if let Err(error) = self.search_index_remove_device(device_id) {
            warn!(
                error = %error,
                device_id,
                "failed to clear removed device entries from search index"
            );
        }

        self.list_devices()
    }

    pub fn connect_device(&self, device_id: &str) -> Result<DeviceRecord, AppStateError> {
        let (device, existing_runtime) = {
            let mut inner = self.lock_inner()?;
            let device = inner.devices.get(device_id).cloned().ok_or_else(|| {
                AppStateError::DeviceNotFound {
                    device_id: device_id.to_owned(),
                }
            })?;
            let existing_runtime = inner.connections.remove(device_id);
            (device, existing_runtime)
        };

        if let Some(runtime) = existing_runtime {
            runtime.shutdown()?;
        }

        let runtime = match self.spawn_runtime(&device) {
            Ok(runtime) => runtime,
            Err(error) => {
                let mut inner = self.lock_inner()?;
                if let Some(record) = inner.devices.get_mut(device_id) {
                    record.connected = false;
                    record.connection = None;
                    record.last_error = Some(error.to_string());
                }
                self.persist_devices_locked(&inner)?;
                return Err(error);
            }
        };

        let mut inner = self.lock_inner()?;
        let record =
            inner
                .devices
                .get_mut(device_id)
                .ok_or_else(|| AppStateError::DeviceNotFound {
                    device_id: device_id.to_owned(),
                })?;

        record.connected = true;
        record.connection = Some(runtime.connection_snapshot());
        record.last_error = None;

        let response = record.clone();
        inner.connections.insert(device_id.to_owned(), runtime);
        self.persist_devices_locked(&inner)?;

        info!(device_id, "device connected");
        Ok(response)
    }

    pub fn disconnect_device(&self, device_id: &str) -> Result<DeviceRecord, AppStateError> {
        self.disconnect_if_connected(device_id)?;

        let mut inner = self.lock_inner()?;
        let response =
            {
                let record = inner.devices.get_mut(device_id).ok_or_else(|| {
                    AppStateError::DeviceNotFound {
                        device_id: device_id.to_owned(),
                    }
                })?;
                record.connected = false;
                record.connection = None;
                record.last_error = None;
                record.clone()
            };

        self.persist_devices_locked(&inner)?;

        info!(device_id, "device disconnected");
        Ok(response)
    }

    pub fn search_index_upsert_thread(
        &self,
        payload: SearchIndexThreadPayload,
    ) -> Result<(), AppStateError> {
        let mut index = self.lock_search_index()?;
        index.upsert_thread(payload);
        self.persist_search_index_locked(&index)
    }

    pub fn search_index_remove_device(&self, device_id: &str) -> Result<(), AppStateError> {
        let mut index = self.lock_search_index()?;
        let removed = index.remove_device(device_id);
        if removed == 0 {
            return Ok(());
        }
        self.persist_search_index_locked(&index)
    }

    pub fn search_query(
        &self,
        request: SearchQueryRequest,
    ) -> Result<SearchQueryResponse, AppStateError> {
        let index = self.lock_search_index()?;
        Ok(index.query(request))
    }

    pub fn search_bootstrap_status(&self) -> Result<SearchBootstrapStatus, AppStateError> {
        let index = self.lock_search_index()?;
        Ok(index.bootstrap_status())
    }

    fn disconnect_if_connected(&self, device_id: &str) -> Result<(), AppStateError> {
        let runtime =
            {
                let mut inner = self.lock_inner()?;
                let record = inner.devices.get_mut(device_id).ok_or_else(|| {
                    AppStateError::DeviceNotFound {
                        device_id: device_id.to_owned(),
                    }
                })?;
                record.connected = false;
                record.connection = None;
                inner.connections.remove(device_id)
            };

        if let Some(runtime) = runtime {
            runtime.shutdown()?;
        }

        Ok(())
    }

    fn spawn_runtime(&self, device: &DeviceRecord) -> Result<ConnectionRuntime, AppStateError> {
        match &device.config {
            DeviceConfig::Local(config) => spawn_local_runtime(config),
            DeviceConfig::Ssh(config) => spawn_ssh_runtime(config),
        }
    }

    fn persist_devices_locked(&self, inner: &InnerState) -> Result<(), AppStateError> {
        let mut devices = inner.devices.values().cloned().collect::<Vec<_>>();
        for device in &mut devices {
            // Runtime process state is ephemeral and should not survive restarts.
            device.connected = false;
            device.connection = None;
        }
        devices.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));

        let payload = PersistedDevices { devices };
        if let Some(parent) = self.storage_path.parent() {
            fs::create_dir_all(parent).map_err(|source| AppStateError::PersistDevices {
                path: parent.display().to_string(),
                source,
            })?;
        }

        let serialized = serde_json::to_string_pretty(&payload).map_err(|source| {
            AppStateError::ParseDevices {
                path: self.storage_path.display().to_string(),
                source,
            }
        })?;

        fs::write(&self.storage_path, serialized).map_err(|source| {
            AppStateError::PersistDevices {
                path: self.storage_path.display().to_string(),
                source,
            }
        })?;

        Ok(())
    }

    fn persist_search_index_locked(&self, index: &SearchIndex) -> Result<(), AppStateError> {
        index
            .persist_to_path(&self.search_index_path)
            .map_err(|error| match error {
                SearchIndexStorageError::Io(source) => AppStateError::PersistSearchIndex {
                    path: self.search_index_path.display().to_string(),
                    source,
                },
                SearchIndexStorageError::Parse(source) => AppStateError::ParseSearchIndex {
                    path: self.search_index_path.display().to_string(),
                    source,
                },
            })
    }

    fn lock_inner(&self) -> Result<MutexGuard<'_, InnerState>, AppStateError> {
        self.inner.lock().map_err(|_| AppStateError::StatePoisoned)
    }

    fn lock_search_index(&self) -> Result<MutexGuard<'_, SearchIndex>, AppStateError> {
        self.search_index
            .lock()
            .map_err(|_| AppStateError::SearchIndexPoisoned)
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        let runtimes: Vec<ConnectionRuntime> = match self.inner.lock() {
            Ok(mut inner) => inner
                .connections
                .drain()
                .map(|(_, runtime)| runtime)
                .collect(),
            Err(_) => return,
        };

        for runtime in runtimes {
            if let Err(error) = runtime.shutdown() {
                error!(error = %error, "failed to shutdown runtime during application drop");
            }
        }
    }
}

impl ConnectionRuntime {
    fn connection_snapshot(&self) -> DeviceConnection {
        DeviceConnection {
            endpoint: self.endpoint.clone(),
            transport: "websocket".to_owned(),
            connected_at_ms: now_ms(),
            local_server_pid: self.local_server.as_ref().map(ManagedProcess::pid),
            ssh_remote_pid: self.ssh_remote_server.as_ref().map(ManagedProcess::pid),
            ssh_forward_pid: self.ssh_forwarder.as_ref().map(ManagedProcess::pid),
        }
    }

    fn shutdown(mut self) -> Result<(), AppStateError> {
        let mut errors = Vec::new();

        for process in [
            &mut self.ssh_forwarder,
            &mut self.ssh_remote_server,
            &mut self.local_server,
        ] {
            if let Some(process) = process.take() {
                if let Err(err) = process.shutdown() {
                    errors.push(err.to_string());
                }
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(AppStateError::DisconnectErrors(errors.join("; ")))
        }
    }
}

impl ManagedProcess {
    fn spawn(
        role: &'static str,
        program: &str,
        args: &[String],
        current_dir: Option<&Path>,
    ) -> Result<Self, AppStateError> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        if let Some(dir) = current_dir {
            command.current_dir(dir);
        }

        let child = command
            .spawn()
            .map_err(|source| AppStateError::SpawnProcess {
                role: role.to_owned(),
                program: program.to_owned(),
                args: args.to_vec(),
                source,
            })?;

        let pid = child.id();
        Ok(Self { role, pid, child })
    }

    fn pid(&self) -> u32 {
        self.pid
    }

    fn assert_running(&mut self) -> Result<(), AppStateError> {
        if let Some(status) =
            self.child
                .try_wait()
                .map_err(|source| AppStateError::ProcessInspect {
                    role: self.role.to_owned(),
                    source,
                })?
        {
            return Err(AppStateError::ProcessExited {
                role: self.role.to_owned(),
                status,
            });
        }

        Ok(())
    }

    fn shutdown(mut self) -> Result<(), AppStateError> {
        if self
            .child
            .try_wait()
            .map_err(|source| AppStateError::ProcessInspect {
                role: self.role.to_owned(),
                source,
            })?
            .is_some()
        {
            return Ok(());
        }

        if let Err(source) = self.child.kill() {
            if source.kind() != io::ErrorKind::InvalidInput {
                return Err(AppStateError::StopProcess {
                    role: self.role.to_owned(),
                    source,
                });
            }
        }

        let _ = self.child.wait();
        Ok(())
    }
}

fn spawn_local_runtime(config: &LocalDeviceConfig) -> Result<ConnectionRuntime, AppStateError> {
    let local_port = config.app_server_port.unwrap_or(allocate_port()?);
    let endpoint = format!("ws://127.0.0.1:{local_port}");

    let (program, args) = if cfg!(target_os = "windows") {
        let program = config.codex_bin.as_deref().unwrap_or("codex").to_owned();
        let args = build_app_server_process_args(&endpoint);
        (program, args)
    } else {
        let app_server_cmd = build_app_server_shell_command(&endpoint);
        let launch_cmd = if let Some(codex_bin) = config.codex_bin.as_deref() {
            let codex_dir = Path::new(codex_bin)
                .parent()
                .and_then(Path::to_str)
                .map(str::to_owned);
            if let Some(dir) = codex_dir {
                format!(
                    "PATH={}:$PATH {} {}",
                    quote_shell(&dir),
                    quote_shell(codex_bin),
                    app_server_cmd
                )
            } else {
                format!("{} {}", quote_shell(codex_bin), app_server_cmd)
            }
        } else {
            // Finder-launched macOS apps do not inherit shell PATH; load nvm when needed.
            format!(
                "if command -v codex >/dev/null 2>&1; then codex {cmd}; \
elif [ -x /opt/homebrew/bin/codex ]; then PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/codex {cmd}; \
elif [ -x /usr/local/bin/codex ]; then PATH=/usr/local/bin:$PATH /usr/local/bin/codex {cmd}; \
elif [ -x \"$HOME/.local/bin/codex\" ]; then PATH=\"$HOME/.local/bin:$PATH\" \"$HOME/.local/bin/codex\" {cmd}; \
elif command -v fnm >/dev/null 2>&1 && eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 && command -v codex >/dev/null 2>&1; then codex {cmd}; \
elif [ -d \"$HOME/.local/state/fnm_multishells\" ] && latest_fnm_codex=$(ls -t \"$HOME\"/.local/state/fnm_multishells/*/bin/codex 2>/dev/null | head -n 1) && [ -n \"$latest_fnm_codex\" ]; then PATH=\"$(dirname \"$latest_fnm_codex\"):$PATH\" \"$latest_fnm_codex\" {cmd}; \
elif [ -s \"$HOME/.nvm/nvm.sh\" ] && . \"$HOME/.nvm/nvm.sh\" >/dev/null 2>&1 && command -v codex >/dev/null 2>&1; then codex {cmd}; \
else echo 'codex binary not found on PATH/homebrew/local/fnm/nvm; set explicit local codex path in device config' >&2; exit 127; fi",
                cmd = app_server_cmd
            )
        };
        ("bash".to_owned(), vec!["-lc".to_owned(), launch_cmd])
    };

    let mut local_server = ManagedProcess::spawn(
        "local-app-server",
        &program,
        &args,
        config.workspace_root.as_deref().map(Path::new),
    )?;

    thread::sleep(Duration::from_millis(450));
    if let Err(error) = local_server.assert_running() {
        let _ = local_server.shutdown();
        return Err(error);
    }
    wait_for_endpoint_ready(&endpoint, local_port, Duration::from_secs(10))?;

    Ok(ConnectionRuntime {
        endpoint,
        local_server: Some(local_server),
        ssh_remote_server: None,
        ssh_forwarder: None,
    })
}

fn spawn_ssh_runtime(config: &SshDeviceConfig) -> Result<ConnectionRuntime, AppStateError> {
    let target = format!("{}@{}", config.user, config.host);

    let remote_port = config.remote_app_server_port;
    let local_forward_port = config.local_forward_port.unwrap_or(allocate_port()?);
    let endpoint = format!("ws://127.0.0.1:{local_forward_port}");

    let mut forward_args = ssh_base_args(config);
    forward_args.push("-N".to_owned());
    forward_args.push("-o".to_owned());
    forward_args.push("ExitOnForwardFailure=yes".to_owned());
    forward_args.push("-L".to_owned());
    forward_args.push(format!("{local_forward_port}:127.0.0.1:{remote_port}"));
    forward_args.push(target.clone());

    let mut ssh_forwarder = match ManagedProcess::spawn("ssh-forwarder", "ssh", &forward_args, None)
    {
        Ok(process) => process,
        Err(error) => return Err(error),
    };

    thread::sleep(Duration::from_millis(450));
    if let Err(error) = ssh_forwarder.assert_running() {
        let _ = ssh_forwarder.shutdown();
        return Err(error);
    }

    // Reuse an already-running remote app-server when the forwarded endpoint
    // is immediately websocket-ready; this prevents duplicate launch attempts
    // and avoids address-in-use failures on reconnect.
    match wait_for_ssh_endpoint_ready(
        &endpoint,
        local_forward_port,
        Duration::from_secs(4),
        None,
        &mut ssh_forwarder,
    ) {
        Ok(()) => {
            info!(
                target,
                endpoint, "reusing existing remote app-server over ssh forward"
            );
            return Ok(ConnectionRuntime {
                endpoint,
                local_server: None,
                ssh_remote_server: None,
                ssh_forwarder: Some(ssh_forwarder),
            });
        }
        Err(AppStateError::EndpointNotReady { .. }) => {
            // Fall through to launching a remote app-server.
        }
        Err(error) => {
            let _ = ssh_forwarder.shutdown();
            return Err(error);
        }
    }

    let listen_uri = format!("ws://127.0.0.1:{remote_port}");
    let app_server_cmd = build_app_server_shell_command(&listen_uri);
    let launch_cmd = if let Some(codex_bin) = config.codex_bin.as_deref() {
        let codex_dir = Path::new(codex_bin)
            .parent()
            .and_then(Path::to_str)
            .map(str::to_owned);
        if let Some(dir) = codex_dir {
            format!(
                "PATH={}:$PATH {} {}",
                quote_shell(&dir),
                quote_shell(codex_bin),
                app_server_cmd
            )
        } else {
            format!("{} {}", quote_shell(codex_bin), app_server_cmd)
        }
    } else {
        format!(
            "if command -v codex >/dev/null 2>&1; then codex {cmd}; \
elif [ -x /opt/homebrew/bin/codex ]; then PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/codex {cmd}; \
elif [ -x /usr/local/bin/codex ]; then PATH=/usr/local/bin:$PATH /usr/local/bin/codex {cmd}; \
elif [ -x \"$HOME/.local/bin/codex\" ]; then PATH=\"$HOME/.local/bin:$PATH\" \"$HOME/.local/bin/codex\" {cmd}; \
elif command -v fnm >/dev/null 2>&1 && eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 && command -v codex >/dev/null 2>&1; then codex {cmd}; \
elif [ -d \"$HOME/.local/state/fnm_multishells\" ] && latest_fnm_codex=$(ls -t \"$HOME\"/.local/state/fnm_multishells/*/bin/codex 2>/dev/null | head -n 1) && [ -n \"$latest_fnm_codex\" ]; then PATH=\"$(dirname \"$latest_fnm_codex\"):$PATH\" \"$latest_fnm_codex\" {cmd}; \
elif [ -s \"$HOME/.nvm/nvm.sh\" ] && . \"$HOME/.nvm/nvm.sh\" >/dev/null 2>&1 && command -v codex >/dev/null 2>&1; then codex {cmd}; \
else echo 'codex binary not found on PATH/homebrew/local/fnm/nvm; set explicit codex path in device config' >&2; exit 127; fi",
            cmd = app_server_cmd
        )
    };
    let stale_cleanup_cmd = format!(
        "for pid in $(ss -ltnp 2>/dev/null | sed -n 's/.*127\\\\.0\\\\.0\\\\.1:{port}.*pid=\\\\([0-9]\\\\+\\\\).*/\\\\1/p' | sort -u); do \
cmd=$(ps -p \"$pid\" -o args= 2>/dev/null || true); \
case \"$cmd\" in *codex*) kill \"$pid\" >/dev/null 2>&1 || true ;; esac; \
done",
        port = remote_port
    );
    // On fallback launch after a failed readiness probe, clear stale codex listeners
    // bound to the target port so reconnect can recover without manual remote cleanup.
    let app_server_cmd = format!("{stale_cleanup_cmd}; {launch_cmd}");

    let remote_cmd = if let Some(root) = &config.workspace_root {
        format!("cd {} && {}", quote_shell(root), app_server_cmd)
    } else {
        app_server_cmd
    };

    let mut remote_args = ssh_base_args(config);
    remote_args.push(target.clone());
    remote_args.push(format!("bash -lc {}", quote_shell(&remote_cmd)));

    let mut ssh_remote_server =
        ManagedProcess::spawn("ssh-remote-app-server", "ssh", &remote_args, None)?;

    thread::sleep(Duration::from_millis(350));
    if let Err(error) = ssh_remote_server.assert_running() {
        let _ = ssh_remote_server.shutdown();
        let _ = ssh_forwarder.shutdown();
        return Err(error);
    }

    if let Err(error) = wait_for_ssh_endpoint_ready(
        &endpoint,
        local_forward_port,
        Duration::from_secs(30),
        Some(&mut ssh_remote_server),
        &mut ssh_forwarder,
    ) {
        let _ = ssh_forwarder.shutdown();
        let _ = ssh_remote_server.shutdown();
        return Err(error);
    }

    info!(
        target,
        endpoint, "launched remote app-server and established ssh forward"
    );

    Ok(ConnectionRuntime {
        endpoint,
        local_server: None,
        ssh_remote_server: Some(ssh_remote_server),
        ssh_forwarder: Some(ssh_forwarder),
    })
}

fn ssh_base_args(config: &SshDeviceConfig) -> Vec<String> {
    let mut args = vec![
        "-p".to_owned(),
        config.ssh_port.to_string(),
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
        "-o".to_owned(),
        "ServerAliveInterval=15".to_owned(),
        "-o".to_owned(),
        "ServerAliveCountMax=3".to_owned(),
    ];

    if let Some(identity_file) = &config.identity_file {
        args.push("-i".to_owned());
        args.push(identity_file.clone());
    }

    args
}

fn allocate_port() -> Result<u16, AppStateError> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|source| AppStateError::FreePort { source })?;
    let port = listener
        .local_addr()
        .map_err(|source| AppStateError::FreePort { source })?
        .port();
    drop(listener);
    Ok(port)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn wait_for_endpoint_ready(
    endpoint: &str,
    local_port: u16,
    timeout: Duration,
) -> Result<(), AppStateError> {
    let deadline = Instant::now() + timeout;
    let address = SocketAddr::from(([127, 0, 0, 1], local_port));
    loop {
        if websocket_upgrade_succeeds(address, local_port) {
            return Ok(());
        }

        if Instant::now() >= deadline {
            return Err(AppStateError::EndpointNotReady {
                endpoint: endpoint.to_owned(),
                timeout_ms: timeout.as_millis() as u64,
            });
        }

        thread::sleep(Duration::from_millis(180));
    }
}

fn wait_for_ssh_endpoint_ready(
    endpoint: &str,
    local_port: u16,
    timeout: Duration,
    remote_process: Option<&mut ManagedProcess>,
    forward_process: &mut ManagedProcess,
) -> Result<(), AppStateError> {
    let deadline = Instant::now() + timeout;
    let address = SocketAddr::from(([127, 0, 0, 1], local_port));
    let mut remote_process = remote_process;
    loop {
        if websocket_upgrade_succeeds(address, local_port) {
            return Ok(());
        }

        // If either SSH process exits while waiting, surface that precise cause
        // instead of a generic endpoint timeout.
        forward_process.assert_running()?;
        if let Some(process) = remote_process.as_deref_mut() {
            process.assert_running()?;
        }

        if Instant::now() >= deadline {
            return Err(AppStateError::EndpointNotReady {
                endpoint: endpoint.to_owned(),
                timeout_ms: timeout.as_millis() as u64,
            });
        }

        thread::sleep(Duration::from_millis(180));
    }
}

fn websocket_upgrade_succeeds(address: SocketAddr, local_port: u16) -> bool {
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(1500)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };

    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));

    let request = format!(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:{local_port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );

    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut buffer = [0_u8; 2048];
    let read = match stream.read(&mut buffer) {
        Ok(read) if read > 0 => read,
        _ => return false,
    };

    let response = String::from_utf8_lossy(&buffer[..read]);
    response.starts_with("HTTP/1.1 101") || response.contains(" 101 ")
}

fn device_storage_path() -> PathBuf {
    let base_dir = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base_dir.join("codex-session-monitor").join("devices.json")
}

fn search_index_storage_path() -> PathBuf {
    let base_dir = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base_dir
        .join("codex-session-monitor")
        .join("search-index-v1.json")
}

fn load_devices(path: &Path) -> Result<HashMap<String, DeviceRecord>, AppStateError> {
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let content = fs::read_to_string(path).map_err(|source| AppStateError::PersistDevices {
        path: path.display().to_string(),
        source,
    })?;

    let mut payload = serde_json::from_str::<PersistedDevices>(&content).map_err(|source| {
        AppStateError::ParseDevices {
            path: path.display().to_string(),
            source,
        }
    })?;

    let mut records = HashMap::new();
    for mut record in payload.devices.drain(..) {
        record.connected = false;
        record.connection = None;
        record.last_error = None;
        records.insert(record.id.clone(), record);
    }

    Ok(records)
}

fn quote_shell(value: &str) -> String {
    if value.is_empty() {
        return "''".to_owned();
    }

    let escaped = value.replace('\'', "'\\''");
    format!("'{escaped}'")
}

fn build_app_server_process_args(listen_uri: &str) -> Vec<String> {
    vec![
        "app-server".to_owned(),
        "-c".to_owned(),
        DEFAULT_APP_SERVER_APPROVAL_CONFIG.to_owned(),
        "-c".to_owned(),
        DEFAULT_APP_SERVER_SANDBOX_CONFIG.to_owned(),
        "--listen".to_owned(),
        listen_uri.to_owned(),
    ]
}

fn build_app_server_shell_command(listen_uri: &str) -> String {
    format!(
        "app-server -c {} -c {} --listen {}",
        quote_shell(DEFAULT_APP_SERVER_APPROVAL_CONFIG),
        quote_shell(DEFAULT_APP_SERVER_SANDBOX_CONFIG),
        quote_shell(listen_uri)
    )
}
