//! The ParaForge desktop shell. The interface talks to the core only through the
//! allow-listed commands registered below; it never sees sign-in tokens or calls Bungie.

use std::sync::Mutex;

use paraforge_core::{Context, CopyScore, Database, ScoringRules};
use serde::Serialize;
use tauri::{Manager, State};

struct AppState {
    db: Mutex<Database>,
}

#[derive(Serialize)]
struct AppInfo {
    version: &'static str,
    core_version: &'static str,
    schema_version: i64,
    ruleset: String,
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> Result<AppInfo, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        core_version: paraforge_core::VERSION,
        schema_version: db.schema_version().map_err(|e| e.to_string())?,
        ruleset: ScoringRules::default().ruleset,
    })
}

#[tauri::command]
fn vault_scores(state: State<'_, AppState>, context: String) -> Result<Vec<CopyScore>, String> {
    let context = Context::parse(&context).ok_or_else(|| format!("unknown context {context:?}"))?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.scores(context).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = Database::open(dir.join("paraforge.sqlite"))?;
            app.manage(AppState { db: Mutex::new(db) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_info, vault_scores])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
