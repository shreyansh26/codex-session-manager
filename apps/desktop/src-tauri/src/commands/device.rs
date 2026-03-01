use tauri::State;

use crate::state::app_state::AppState;
use crate::state::models::{
    DeviceAddLocalRequest, DeviceAddSshRequest, DeviceConnectRequest, DeviceDisconnectRequest,
    DeviceRecord, DeviceRemoveRequest,
};

type CommandResult<T> = Result<T, String>;

#[tauri::command]
pub fn device_add_local(
    state: State<'_, AppState>,
    request: DeviceAddLocalRequest,
) -> CommandResult<DeviceRecord> {
    state
        .add_local_device(request)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn device_add_ssh(
    state: State<'_, AppState>,
    request: DeviceAddSshRequest,
) -> CommandResult<DeviceRecord> {
    state.add_ssh_device(request).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn device_list(state: State<'_, AppState>) -> CommandResult<Vec<DeviceRecord>> {
    state.list_devices().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn device_connect(
    state: State<'_, AppState>,
    request: DeviceConnectRequest,
) -> CommandResult<DeviceRecord> {
    state
        .connect_device(&request.device_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn device_disconnect(
    state: State<'_, AppState>,
    request: DeviceDisconnectRequest,
) -> CommandResult<DeviceRecord> {
    state
        .disconnect_device(&request.device_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn device_remove(
    state: State<'_, AppState>,
    request: DeviceRemoveRequest,
) -> CommandResult<Vec<DeviceRecord>> {
    state
        .remove_device(&request.device_id)
        .map_err(|err| err.to_string())
}
