use serde::{Deserialize, Serialize};

pub const DEFAULT_SSH_PORT: u16 = 22;
pub const DEFAULT_REMOTE_APP_SERVER_PORT: u16 = 45231;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAddLocalRequest {
    pub name: Option<String>,
    pub app_server_port: Option<u16>,
    pub codex_bin: Option<String>,
    pub workspace_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAddSshRequest {
    pub name: Option<String>,
    pub host: String,
    pub user: String,
    pub ssh_port: Option<u16>,
    pub identity_file: Option<String>,
    pub remote_app_server_port: Option<u16>,
    pub local_forward_port: Option<u16>,
    pub codex_bin: Option<String>,
    pub workspace_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConnectRequest {
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDisconnectRequest {
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRemoveRequest {
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    pub name: String,
    pub config: DeviceConfig,
    pub connected: bool,
    pub connection: Option<DeviceConnection>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConnection {
    pub endpoint: String,
    pub transport: String,
    pub connected_at_ms: u64,
    pub local_server_pid: Option<u32>,
    pub ssh_remote_pid: Option<u32>,
    pub ssh_forward_pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DeviceConfig {
    Local(LocalDeviceConfig),
    Ssh(SshDeviceConfig),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDeviceConfig {
    pub app_server_port: Option<u16>,
    pub codex_bin: Option<String>,
    pub workspace_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDeviceConfig {
    pub host: String,
    pub user: String,
    pub ssh_port: u16,
    pub identity_file: Option<String>,
    pub remote_app_server_port: u16,
    pub local_forward_port: Option<u16>,
    pub codex_bin: Option<String>,
    pub workspace_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedDevices {
    pub devices: Vec<DeviceRecord>,
}
