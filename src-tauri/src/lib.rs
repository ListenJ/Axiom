use oc_search::DeterministicEngine;
use oc_shared::types::{SearchOptions, SystemStatus};
use std::sync::Arc;
use tauri::State;

pub struct AppState {
    search: Arc<DeterministicEngine>,
}

#[tauri::command]
fn native_search(
    state: State<AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<serde_json::Value, String> {
    let opts = SearchOptions {
        limit: limit.unwrap_or(10),
        types: None,
        tags: None,
        para_category: None,
        date_range: None,
        include_reasons: true,
    };
    let results = state.search.search(&query, &opts);
    Ok(serde_json::json!({
        "query": query,
        "count": results.len(),
        "results": results,
    }))
}

#[tauri::command]
fn native_stats(state: State<AppState>) -> Result<serde_json::Value, String> {
    let stats = state.search.stats();
    Ok(serde_json::json!(stats))
}

#[tauri::command]
fn get_system_info() -> Result<SystemStatus, String> {
    Ok(SystemStatus {
        version: "2.3.0".to_string(),
        edition: "tauri-native".to_string(),
        uptime_secs: 0,
        memory_mb: 0,
        cpu_percent: 0.0,
        vault_notes: 0,
        active_connections: 0,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let vault_path = std::env::var("OBSIDIAN_VAULT_PATH")
        .unwrap_or_else(|_| "./openclaw-memory".to_string());

    let state = AppState {
        search: Arc::new(DeterministicEngine::new(vault_path)),
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![native_search, native_stats, get_system_info])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
