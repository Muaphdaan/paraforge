//! Vault sync: Bungie manifest and profile into the local database, then scoring.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use paraforge_bungie::api::{ApiError, BungieApi, DestinyMembership};
use paraforge_bungie::inventory::RawProfile;
use paraforge_bungie::inventory::{
    EnhancedPerks, RawCollectibleDef, RawItemDef, RawPlugSetDef, build_catalog, read_profile,
};
use paraforge_bungie::wishlist::{self, Fetched};
use paraforge_core::{Context, PerkInfo, Provenance, ScoreError, ScoringRules, VaultRow, score_vault};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;
use crate::auth::{self, AuthState};

const ITEMS_TABLE: &str = "DestinyInventoryItemDefinition";
const PLUG_SETS_TABLE: &str = "DestinyPlugSetDefinition";
const COLLECTIBLES_TABLE: &str = "DestinyCollectibleDefinition";
const META_MANIFEST: &str = "manifest_paths";
const META_SYNCED_AT: &str = "synced_at";
/// Bumped when ParaForge reads more from the item database, so the next sync reads it again.
const CATALOG_VERSION: &str = "catalog-5";
/// Bumped when ParaForge reads more from the god-roll list, so the next sync rebuilds the rolls.
const ROLLS_VERSION: &str = "rolls-2";
/// The Bungie membership whose weapons are stored.
const META_COPIES_ACCOUNT: &str = "copies_membership_id";
/// The player's characters from the last sync, as JSON.
pub(crate) const META_CHARACTERS: &str = "characters";
const META_ROLLS_BUILT: &str = "rolls_built";
const META_ROLLS_ETAG: &str = "rolls_etag";
const META_ROLLS_CHECKED: &str = "rolls_checked";
/// How often the god-roll list is checked for changes. It changes a few times a week.
const ROLLS_CHECK_SECS: i64 = 6 * 3600;
const ROLLS_SOURCE: &str = "voltron";

#[derive(Default)]
pub struct SyncState {
    running: AtomicBool,
    /// An item action (move, equip, perk switch) is running.
    pub(crate) acting: AtomicBool,
}

pub(crate) struct RunningGuard<'a>(pub(crate) &'a AtomicBool);

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
    /// Curated god rolls stored.
    god_rolls: usize,
    /// Why the god-roll list could not be updated this time, if it could not. The sync still works.
    god_roll_error: Option<String>,
    manifest_version: String,
    /// Unix seconds.
    synced_at: i64,
    /// Copies this sync saw for the first time (new drops); 0 on a baseline sync.
    new_drops: usize,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn progress(app: &AppHandle, step: &str) {
    let _ = app.emit("sync-progress", step);
}

pub(crate) fn api_err(e: ApiError) -> String {
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
    let collectibles_path =
        manifest.table_path(COLLECTIBLES_TABLE).ok_or("Bungie's manifest has no Collections table.")?.to_string();
    let wanted = format!("{CATALOG_VERSION}\n{items_path}\n{sets_path}\n{collectibles_path}");
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
        let collectibles_file = dir.join("collectibles.json");
        let raw_files = [items_file.clone(), sets_file.clone(), collectibles_file.clone()];
        let mut downloaded = Ok(());
        for (path, file) in
            [(&items_path, &items_file), (&sets_path, &sets_file), (&collectibles_path, &collectibles_file)]
        {
            downloaded = api.download_table(path, file).await;
            if downloaded.is_err() {
                break;
            }
        }
        if let Err(e) = downloaded {
            for file in &raw_files {
                let _ = std::fs::remove_file(file);
            }
            return Err(api_err(e));
        }

        progress(&app, "Reading Bungie's item database");
        let app2 = app.clone();
        let enhanced2 = enhanced.clone();
        let wanted = wanted.clone();
        let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let items: HashMap<String, RawItemDef> = read_table(&items_file)?;
            let sets: HashMap<String, RawPlugSetDef> = read_table(&sets_file)?;
            let collectibles: HashMap<String, RawCollectibleDef> = read_table(&collectibles_file)?;
            let catalog = build_catalog(&items, &sets, &collectibles, &enhanced2);
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
        for file in &raw_files {
            let _ = std::fs::remove_file(file);
        }
        result?;
    }

    // 2. Curated god rolls, rebuilt when the list or the item database changed.
    progress(&app, "Checking the god-roll list");
    // God rolls never stop the vault sync: a failure keeps the last good rolls and is reported.
    let (god_rolls, god_roll_error) = match update_rolls(&app, &wanted).await {
        Ok(v) => v,
        Err(e) => (0, Some(e)),
    };

    // 3. The player's weapons.
    progress(&app, "Reading your vault and characters");
    // The membership whose profile was read: Settings shows the stored Bungie Name only while the
    // same account is signed in.
    let (profile, tokens, _) = read_player(&app, &api).await?;
    let membership_id = tokens.membership_id.clone();
    drop(tokens);
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

    // 4. Store and score.
    progress(&app, "Scoring your weapons");
    let synced_at = now();
    let state = app.state::<AppState>();
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let defs = db.weapons().map_err(|e| e.to_string())?;
    let read = read_profile(&profile, &defs, &enhanced);
    // Another account's weapons are not new drops: a sync for a different account starts afresh.
    let previous = db.meta(META_COPIES_ACCOUNT).map_err(|e| e.to_string())?;
    let switched = previous.as_deref().is_some_and(|p| p != membership_id);
    db.replace_copies(&read.copies, &synced_at.to_string(), switched).map_err(|e| e.to_string())?;
    db.set_meta(META_COPIES_ACCOUNT, &membership_id).map_err(|e| e.to_string())?;
    let new_drops = db.first_seen_at(&synced_at.to_string()).map_err(|e| e.to_string())?;
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
    if let Some(name) = profile.player_name() {
        db.set_meta("player_name", &name).map_err(|e| e.to_string())?;
        db.set_meta("player_membership_id", &membership_id).map_err(|e| e.to_string())?;
    }
    // The character picker for moving weapons. Kept from the last sync when Bungie left it out.
    let characters = profile.characters();
    if !characters.is_empty() || switched {
        let json = serde_json::to_string(&characters).map_err(|e| e.to_string())?;
        db.set_meta(META_CHARACTERS, &json).map_err(|e| e.to_string())?;
    }
    let manifest_version = db.meta("manifest_version").map_err(|e| e.to_string())?.unwrap_or_default();

    Ok(SyncSummary {
        weapons_known: defs.len(),
        copies: read.copies.len(),
        unreadable: read.unreadable.len(),
        characters_hidden: read.characters_hidden,
        not_scored,
        god_rolls,
        god_roll_error,
        manifest_version,
        synced_at,
        new_drops,
    })
}

fn rolls_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("godrolls");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("voltron.txt"))
}

/// Downloads the god-roll list when due and rebuilds the stored rolls when the list, the item
/// database or ParaForge's reader changed. A failed download keeps the last good rolls and is
/// reported, not fatal. Returns how many rolls are stored and the download error, if any.
async fn update_rolls(app: &AppHandle, catalog: &str) -> Result<(usize, Option<String>), String> {
    let file = rolls_file(app)?;
    let built_for = format!("{ROLLS_VERSION}\n{catalog}");
    let (etag, checked, built, stored) = {
        let state = app.state::<AppState>();
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let num = |v: Option<String>| v.and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
        (
            db.meta(META_ROLLS_ETAG).map_err(|e| e.to_string())?,
            num(db.meta(META_ROLLS_CHECKED).map_err(|e| e.to_string())?),
            db.meta(META_ROLLS_BUILT).map_err(|e| e.to_string())?,
            db.count("curated_roll").map_err(|e| e.to_string())?,
        )
    };
    let have_file = file.exists();
    let mut changed = false;
    let mut error = None;
    let mut new_etag = None;
    // Whether the check is done for the next six hours: the list answered, or it downloaded but
    // could not be saved (downloading 30 MB again on every sync would not help).
    let mut checked_now = false;
    if !have_file || now() - checked >= ROLLS_CHECK_SECS {
        match wishlist::fetch(wishlist::VOLTRON_URL, etag.as_deref().filter(|_| have_file)).await {
            Ok(Fetched::Unchanged) => checked_now = true,
            Ok(Fetched::New { text, etag }) => {
                checked_now = true;
                let part = file.with_extension("part");
                match std::fs::write(&part, text.as_bytes()).and_then(|_| std::fs::rename(&part, &file)) {
                    Ok(()) => {
                        new_etag = Some(etag.unwrap_or_default());
                        changed = true;
                    }
                    Err(e) => {
                        let _ = std::fs::remove_file(&part);
                        error = Some(format!("could not save the god-roll list: {e}"));
                    }
                }
            }
            // A failed download is tried again on the next sync.
            Err(e) => error = Some(e),
        }
    }
    let state = app.state::<AppState>();
    if checked_now {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.set_meta(META_ROLLS_CHECKED, &now().to_string()).map_err(|e| e.to_string())?;
        if let Some(tag) = &new_etag {
            db.set_meta(META_ROLLS_ETAG, tag).map_err(|e| e.to_string())?;
            // A new list needs a rebuild until one succeeds, even if the first attempt fails.
            db.set_meta(META_ROLLS_BUILT, "").map_err(|e| e.to_string())?;
        }
    }
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.set_meta("rolls_error", error.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
    }
    let rebuild = file.exists() && (changed || built.as_deref() != Some(built_for.as_str()) || stored == 0);
    if !rebuild {
        return Ok((stored, error));
    }
    progress(app, "Reading the god-roll list");
    let app2 = app.clone();
    let count = tauri::async_runtime::spawn_blocking(move || -> Result<usize, String> {
        let text = std::fs::read_to_string(&file).map_err(|e| format!("could not read the god-roll list: {e}"))?;
        let blocks = paraforge_core::wishlist::parse_blocks(&text);
        drop(text);
        let enhanced = EnhancedPerks::bundled();
        let state = app2.state::<AppState>();
        let mut db = state.db.lock().map_err(|e| e.to_string())?;
        let defs = db.weapons().map_err(|e| e.to_string())?;
        let rolls = paraforge_core::wishlist::curated_rolls(&blocks, &defs, |p| enhanced.base(p));
        if rolls.is_empty() {
            return Err("No god rolls matched ParaForge's weapons; the list format may have changed.".into());
        }
        let version = db.meta(META_ROLLS_ETAG).map_err(|e| e.to_string())?.unwrap_or_default();
        db.upsert_source(
            ROLLS_SOURCE,
            &Provenance {
                source: "voltron (48klocs/dim-wish-list-sources)".into(),
                version,
                license: "MIT".into(),
                fetched: now().to_string(),
            },
        )
        .map_err(|e| e.to_string())?;
        db.replace_rolls(&rolls, ROLLS_SOURCE).map_err(|e| e.to_string())?;
        db.set_meta(META_ROLLS_BUILT, &built_for).map_err(|e| e.to_string())?;
        Ok(rolls.len())
    })
    .await
    .map_err(|e| e.to_string())?;
    match count {
        Ok(n) => Ok((n, error)),
        // Keep the old rolls and say why; scoring still works with them.
        Err(e) => {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db.set_meta("rolls_error", &e).map_err(|e| e.to_string())?;
            Ok((stored, Some(e)))
        }
    }
}

/// Fetches the player's profile and the membership it belongs to. The access token is fetched again
/// here because the manifest download can outlast it; if Bungie still rejects it, it is refreshed
/// once and the call retried.
pub(crate) async fn read_player(
    app: &AppHandle,
    api: &BungieApi,
) -> Result<(RawProfile, paraforge_bungie::Tokens, DestinyMembership), String> {
    let auth_state = app.state::<AuthState>();
    let (_, tokens) = auth::access_token(&auth_state).await?;
    match profile_for(api, &tokens).await {
        Err(ApiError::SignInRequired) => {
            let (_, fresh) = auth::refresh_after_rejection(&auth_state, &tokens).await?;
            let (profile, account) = profile_for(api, &fresh).await.map_err(api_err)?;
            Ok((profile, fresh, account))
        }
        other => other.map(|(p, a)| (p, tokens, a)).map_err(api_err),
    }
}

/// The profile of the player's Destiny account. Without cross save a player can have several
/// accounts, so each candidate is tried until one has Destiny 2 data.
async fn profile_for(
    api: &BungieApi,
    tokens: &paraforge_bungie::Tokens,
) -> Result<(RawProfile, DestinyMembership), ApiError> {
    let memberships = api.memberships(&tokens.access_token).await?;
    let candidates: Vec<DestinyMembership> = memberships.candidates().into_iter().cloned().collect();
    for account in candidates {
        match api.profile(&tokens.access_token, &account).await {
            Err(ApiError::NoDestinyAccount) => continue,
            other => return other.map(|p| (p, account)),
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
