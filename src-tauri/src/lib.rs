//! The ParaForge desktop shell. The interface talks to the core only through the
//! allow-listed commands registered below; it never sees sign-in tokens or calls Bungie.

mod auth;
mod game;
mod sync;
#[cfg(windows)]
mod window_style;

use std::sync::Mutex;

use paraforge_core::{Context, CopyScore, Database, ScoringRules, WeaponDef, WeaponHash};
use serde::Serialize;
use tauri::{Manager, State};

pub(crate) struct AppState {
    pub(crate) db: Mutex<Database>,
}

#[derive(Serialize)]
struct AppInfo {
    version: &'static str,
    core_version: &'static str,
    schema_version: i64,
    ruleset: String,
    /// Unix seconds of the last successful vault sync, if there has been one.
    synced_at: Option<i64>,
    /// The player's Bungie Name from the last sync, for example "NightOwl#4821".
    player: Option<String>,
    /// Version of Bungie's item database last read.
    manifest_version: Option<String>,
    weapons_known: usize,
    perks_known: usize,
    copies: usize,
    /// The scoring rules, so Settings can explain the verdict thresholds.
    rules: ScoringRules,
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> Result<AppInfo, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        core_version: paraforge_core::VERSION,
        schema_version: db.schema_version().map_err(|e| e.to_string())?,
        ruleset: ScoringRules::default().ruleset,
        synced_at: db.meta("synced_at").map_err(|e| e.to_string())?.and_then(|v| v.parse().ok()),
        player: db.meta("player_name").map_err(|e| e.to_string())?,
        manifest_version: db.meta("manifest_version").map_err(|e| e.to_string())?,
        weapons_known: db.count("weapon").map_err(|e| e.to_string())?,
        perks_known: db.count("perk").map_err(|e| e.to_string())?,
        copies: db.count("weapon_copy").map_err(|e| e.to_string())?,
        rules: ScoringRules::default(),
    })
}

/// One weapon's definition, including every perk each column can roll.
#[tauri::command]
fn weapon(state: State<'_, AppState>, hash: u32) -> Result<Option<WeaponDef>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.weapon(WeaponHash(hash)).map_err(|e| e.to_string())
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
        // Must be first: a second launch (for example a paraforge:// sign-in reply on Windows)
        // hands its address to the running app instead of opening another window.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            auth::init_credential_store()?;
            app.manage(auth::AuthState::new()?);
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Installers register paraforge:// themselves; dev builds register it at launch.
                // Not fatal: sign-in can still be retried once the link is registered.
                #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("could not register paraforge:// links: {e}");
                }
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        auth::handle_deep_link(&handle, url.to_string());
                    }
                });
            }

            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = Database::open(dir.join("paraforge.sqlite"))?;
            app.manage(AppState { db: Mutex::new(db) });
            app.manage(sync::SyncState::default());
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window_style::paint_title_bar(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            vault_scores,
            weapon,
            game::game_running,
            auth::auth_status,
            auth::save_app_keys,
            auth::start_sign_in,
            auth::sign_out,
            sync::sync_now,
            sync::vault,
            sync::perks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
