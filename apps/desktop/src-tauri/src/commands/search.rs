use tauri::State;

use crate::state::app_state::AppState;
use crate::state::search_index::{
    SearchBootstrapStatus, SearchIndexRemoveDeviceRequest, SearchIndexThreadPayload,
    SearchQueryRequest, SearchQueryResponse,
};

type CommandResult<T> = Result<T, String>;

#[tauri::command]
pub fn search_index_upsert_thread(
    state: State<'_, AppState>,
    request: SearchIndexThreadPayload,
) -> CommandResult<()> {
    state
        .search_index_upsert_thread(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn search_index_remove_device(
    state: State<'_, AppState>,
    request: SearchIndexRemoveDeviceRequest,
) -> CommandResult<()> {
    state
        .search_index_remove_device(&request.device_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn search_query(
    state: State<'_, AppState>,
    request: SearchQueryRequest,
) -> CommandResult<SearchQueryResponse> {
    state
        .search_query(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn search_bootstrap_status(state: State<'_, AppState>) -> CommandResult<SearchBootstrapStatus> {
    state
        .search_bootstrap_status()
        .map_err(|error| error.to_string())
}
