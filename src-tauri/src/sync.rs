//! Vault sync: Bungie manifest and profile into the local database, then scoring.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use paraforge_bungie::api::{ApiError, BungieApi, DestinyMembership};
use paraforge_bungie::inventory::RawProfile;
use paraforge_bungie::inventory::{EnhancedPerks, RawItemDef, RawPlugSetDef, build_catalog, read_profile};
use paraforge_core::{Context, PerkInfo, ScoreError, ScoringRules, VaultRow, score_vault};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;
use crate::auth::{self, AuthState};

const ITEMS_TABLE: &str = "DestinyInventoryItemDefinition";
const PLUG_SETS_TABLE: &str = "DestinyPlugSetDefinition";
const META_MANIFEST: &str = "manifest_paths";
const META_SYNCED_AT: &str = "synced_at";
/// Bumped when ParaForge reads more from the item database, so the next sync reads it again.
const CATALOG_VERSION: &str = "catalog-2";

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
    let (keys, _) = auth::access_token(&app.state::<AuthState>()).await?;
    let api = BungieApi::new(&keys).map_err(api_err)?;

    // 1. Item definitions, downloaded again only when Bungie publishes a new manifest.
    progress(&app, "Checking Bungie's item database");
    let manifest = api.manifest().await.map_err(api_err)?;
    let items_path = manifest.table_path(ITEMS_TABLE).ok_or("Bungie's manifest has no item table.")?.to_string();
    let sets_path = manifest.table_path(PLUG_SETS_TABLE).ok_or("Bungie's manifest has no plug set table.")?.to_string();
    let wanted = format!("{CATALOG_VERSION}\n{items_path}\n{sets_path}");
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
        let downloaded = match api.download_table(&items_path, &items_file).await {
            Ok(()) => api.download_table(&sets_path, &sets_file).await,
            Err(e) => Err(e),
        };
        if let Err(e) = downloaded {
            let _ = std::fs::remove_file(&items_file);
            let _ = std::fs::remove_file(&sets_file);
            return Err(api_err(e));
        }

        progress(&app, "Reading Bungie's item database");
        let app2 = app.clone();
        let enhanced2 = enhanced.clone();
        let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let items: HashMap<String, RawItemDef> = read_table(&items_file)?;
            let sets: HashMap<String, RawPlugSetDef> = read_table(&sets_file)?;
            let catalog = build_catalog(&items, &sets, &enhanced2);
            drop(items);
            // Check before writing, so a changed format never wipes the weapons already stored.
            if catalog.weapons.is_empty() {
                return Err("No weapons were found in Bungie's item database; the format may have changed.".into());
            }
            let state = app2.state::<AppState>();
            let mut db = state.db.lock().map_err(|e| e.to_string())?;
            db.replace_definitions(&catalog.weapons, &catalog.perks).map_err(|e| e.to_string())?;
            db.set_meta(META_MANIFEST, &wanted).map_err(|e| e.to_string())?;
            db.set_meta("manifest_version", &manifest.version).map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
        // The raw tables are large and no longer needed, whether or not reading them worked.
        let _ = std::fs::remove_file(dir.join("items.json"));
        let _ = std::fs::remove_file(dir.join("plugsets.json"));
        result?;
    }

    // 2. The player's weapons.
    progress(&app, "Reading your vault and characters");
    let profile = read_player(&app, &api).await?;
    let missing = profile.missing_parts();
    if !missing.is_empty() {
        // Storing a partial profile would look like deleted weapons, so keep the last good sync.
        return Err(format!(
            "Bungie did not send your full inventory (missing: {}). Your last sync is kept. On \
             bungie.net, check that your ParaForge app has the \"Read your Destiny 2 information \
             (Vault, Inventory, and Vendors)\" scope, then sign out of ParaForge and sign in again.",
            missing.join(", ")
        ));
    }

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
        // Exotics and other fixed-perk weapons have nothing to score; they are not failures.
        let failed = out.skipped.iter().filter(|(_, e)| *e != ScoreError::NoColumns).count();
        not_scored = not_scored.max(failed);
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

/// Fetches the player's profile. The access token is fetched again here because the manifest
/// download can outlast it; if Bungie still rejects it, it is refreshed once and the call retried.
async fn read_player(app: &AppHandle, api: &BungieApi) -> Result<RawProfile, String> {
    let auth_state = app.state::<AuthState>();
    let (_, tokens) = auth::access_token(&auth_state).await?;
    match profile_for(api, &tokens).await {
        Err(ApiError::SignInRequired) => {
            let (_, fresh) = auth::refresh_after_rejection(&auth_state, &tokens).await?;
            profile_for(api, &fresh).await.map_err(api_err)
        }
        other => other.map_err(api_err),
    }
}

/// The profile of the player's Destiny account. Without cross save a player can have several
/// accounts, so each candidate is tried until one has Destiny 2 data.
async fn profile_for(api: &BungieApi, tokens: &paraforge_bungie::Tokens) -> Result<RawProfile, ApiError> {
    let memberships = api.memberships(&tokens.access_token).await?;
    let candidates: Vec<DestinyMembership> = memberships.candidates().into_iter().cloned().collect();
    for account in &candidates {
        match api.profile(&tokens.access_token, account).await {
            Err(ApiError::NoDestinyAccount) => continue,
            other => return other,
        }
    }
    Err(ApiError::NoDestinyAccount)
}

/// The stored vault for one context ("pve" or "pvp"), best first.
#[tauri::command]
pub fn vault(state: State<'_, AppState>, context: String) -> Result<Vec<VaultRow>, String> {
    let context = Context::parse(&context).ok_or_else(|| format!("unknown context {context:?}"))?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.vault_rows(context).map_err(|e| e.to_string())
}

/// Every known perk (name, icon, description) by hash, for showing perks with their icons.
#[tauri::command]
pub fn perks(state: State<'_, AppState>) -> Result<HashMap<u32, PerkInfo>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.perks().map_err(|e| e.to_string())?.into_iter().map(|p| (p.hash.0, p)).collect())
}
