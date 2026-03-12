#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod state;

use commands::{
    debug_persist_artifact,
    device_add_local, device_add_ssh, device_connect, device_disconnect, device_list,
    device_remove, search_bootstrap_status, search_index_remove_device, search_index_upsert_thread,
    search_query,
};
use state::app_state::AppState;

fn main() {
    init_tracing();

    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            device_add_local,
            device_add_ssh,
            device_list,
            device_connect,
            device_disconnect,
            device_remove,
            debug_persist_artifact,
            search_index_upsert_thread,
            search_index_remove_device,
            search_query,
            search_bootstrap_status
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Tauri application");
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}
