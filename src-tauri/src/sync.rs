//! Vault sync: Bungie manifest and profile into the local database, then scoring.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use paraforge_bungie::api::{ApiError, BungieApi};
use paraforge_bungie::inventory::{EnhancedPerks, RawItemDef, RawPlugSetDef, build_catalog, read_profile};
use paraforge_core::{Context, ScoringRules, VaultRow, score_vault};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;
use crate::auth::{self, AuthState};

const ITEMS_TABLE: &str = "DestinyInventoryItemDefinition";
const PLUG_SETS_TABLE: &str = "DestinyPlugSetDefinition";
const META_MANIFEST: &str = "manifest_paths";
const META_SYNCED_AT: &str = "synced_at";

#[derive(Default)]
pub struct SyncState {
    running: AtomicBool,
}

struct RunningGuard<'a>(&'a AtomicBool);

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncSummary {
    /// Weapons known from Bungie's item database.
    weapons_known: usize,
    /// Owned weapon copies stored.
    copies: usize,
    /// Owned weapons whose perks Bungie did not return.
    unreadable: usize,
    /// Bungie hid character inventories (privacy settings), so the list may be incomplete.
    characters_hidden: bool,
    /// Copies the scoring engine could not score.
    not_scored: usize,
    manifest_version: String,
    /// Unix seconds.
    synced_at: i64,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn progress(app: &AppHandle, step: &str) {
    let _ = app.emit("sync-progress", step);
}

fn api_err(e: ApiError) -> String {
    e.to_string()
}

fn manifest_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("manifest");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_table<T: serde::de::DeserializeOwned>(path: &PathBuf) -> Result<HashMap<String, T>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    serde_json::from_reader(BufReader::with_capacity(1 << 20, file))
        .map_err(|e| format!("could not read Bungie's item database: {e}"))
}

#[tauri::command]
pub async fn sync_now(app: AppHandle, sync: State<'_, SyncState>) -> Result<SyncSummary, String> {
    if sync.running.swap(true, Ordering::SeqCst) {
        return Err("A sync is already running.".into());
    }
    let _guard = RunningGuard(&sync.running);

    progress(&app, "Checking your Bungie sign-in");
    let (keys, tokens) = auth::access_token(&app.state::<AuthState>()).await?;
    let api = BungieApi::new(&keys).map_err(api_err)?;

    // 1. Item definitions, downloaded again only when Bungie publishes a new manifest.
    progress(&app, "Checking Bungie's item database");
    let manifest = api.manifest().await.map_err(api_err)?;
    let items_path = manifest.table_path(ITEMS_TABLE).ok_or("Bungie's manifest has no item table.")?.to_string();
    let sets_path = manifest.table_path(PLUG_SETS_TABLE).ok_or("Bungie's manifest has no plug set table.")?.to_string();
    let wanted = format!("{items_path}\n{sets_path}");
    let (current, have_weapons) = {
        let state = app.state::<AppState>();
        let db = state.db.lock().map_err(|e| e.to_string())?;
        (db.meta(META_MANIFEST).map_err(|e| e.to_string())?, !db.weapons().map_err(|e| e.to_string())?.is_empty())
    };
    let enhanced = EnhancedPerks::bundled();
    if current.as_deref() != Some(wanted.as_str()) || !have_weapons {
        progress(&app, "Downloading Bungie's item database (first sync, or after a game update)");
        let dir = manifest_dir(&app)?;
        let items_file = dir.join("items.json");
        let sets_file = dir.join("plugsets.json");
        api.download_table(&items_path, &items_file).await.map_err(api_err)?;
        api.download_table(&sets_path, &sets_file).await.map_err(api_err)?;

        progress(&app, "Reading Bungie's item database");
        let app2 = app.clone();
        let enhanced2 = enhanced.clone();
        let count = tauri::async_runtime::spawn_blocking(move || -> Result<usize, String> {
            let items: HashMap<String, RawItemDef> = read_table(&items_file)?;
            let sets: HashMap<String, RawPlugSetDef> = read_table(&sets_file)?;
            let catalog = build_catalog(&items, &sets, &enhanced2);
            drop(items);
            let state = app2.state::<AppState>();
            let mut db = state.db.lock().map_err(|e| e.to_string())?;
            db.replace_definitions(&catalog.weapons, &catalog.perks).map_err(|e| e.to_string())?;
            db.set_meta(META_MANIFEST, &wanted).map_err(|e| e.to_string())?;
            db.set_meta("manifest_version", &manifest.version).map_err(|e| e.to_string())?;
            Ok(catalog.weapons.len())
        })
        .await
        .map_err(|e| e.to_string())??;
        if count == 0 {
            return Err("No weapons were found in Bungie's item database; the format may have changed.".into());
        }
        // The raw tables are large and no longer needed.
        let _ = std::fs::remove_file(dir.join("items.json"));
        let _ = std::fs::remove_file(dir.join("plugsets.json"));
    }

    // 2. The player's weapons.
    progress(&app, "Reading your vault and characters");
    let memberships = api.memberships(&tokens.access_token).await.map_err(api_err)?;
    let account = memberships.choose().ok_or_else(|| ApiError::NoDestinyAccount.to_string())?.clone();
    let profile = api.profile(&tokens.access_token, &account).await.map_err(api_err)?;

    // 3. Store and score.
    progress(&app, "Scoring your weapons");
    let synced_at = now();
    let state = app.state::<AppState>();
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let defs = db.weapons().map_err(|e| e.to_string())?;
    let read = read_profile(&profile, &defs, &enhanced);
    db.replace_copies(&read.copies, &synced_at.to_string()).map_err(|e| e.to_string())?;
    let ratings = db.ratings().map_err(|e| e.to_string())?;
    let rolls = db.rolls().map_err(|e| e.to_string())?;
    let rules = ScoringRules::default();
    let mut not_scored = 0;
    for context in Context::ALL {
        let out = score_vault(&defs, &read.copies, context, &ratings, &rolls, &rules);
        not_scored = not_scored.max(out.skipped.len());
        db.save_scores(context, &out.scores).map_err(|e| e.to_string())?;
    }
    db.set_meta(META_SYNCED_AT, &synced_at.to_string()).map_err(|e| e.to_string())?;
    let manifest_version = db.meta("manifest_version").map_err(|e| e.to_string())?.unwrap_or_default();

    Ok(SyncSummary {
        weapons_known: defs.len(),
        copies: read.copies.len(),
        unreadable: read.unreadable.len(),
        characters_hidden: read.characters_hidden,
        not_scored,
        manifest_version,
        synced_at,
    })
}

/// The stored vault for one context ("pve" or "pvp"), best first.
#[tauri::command]
pub fn vault(state: State<'_, AppState>, context: String) -> Result<Vec<VaultRow>, String> {
    let context = Context::parse(&context).ok_or_else(|| format!("unknown context {context:?}"))?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.vault_rows(context).map_err(|e| e.to_string())
}

/// Perk names by hash, for showing perks in the vault list.
#[tauri::command]
pub fn perk_names(state: State<'_, AppState>) -> Result<HashMap<u32, String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.perk_names().map_err(|e| e.to_string())?.into_iter().map(|(k, v)| (k.0, v)).collect())
}
