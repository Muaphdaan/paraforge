//! Item actions: put a weapon in a character's hands, with its perks switched to a god roll.
//!
//! The plan is made from a fresh profile, so ParaForge never acts on where a weapon was at the last
//! sync, and every refusal it can foresee is reported before anything moves.

use std::sync::atomic::Ordering;
use std::time::Duration;

use paraforge_bungie::Secret;
use paraforge_bungie::actions::{EquipRequest, Step, plan_equip};
use paraforge_bungie::api::{ApiError, BungieApi, DestinyMembership};
use paraforge_bungie::inventory::EnhancedPerks;
use paraforge_core::PerkHash;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::AppState;
use crate::auth::{self, AuthState};
use crate::sync::{RunningGuard, SyncState, api_err, read_player};

/// The longest Bungie throttle ParaForge waits out before trying a step again.
const MAX_THROTTLE_WAIT_SECS: i32 = 10;

#[derive(Debug, Serialize)]
pub struct EquipOutcome {
    /// The class of the character that now holds the weapon, for example "Warlock".
    character: String,
    moved: bool,
    equipped: bool,
    /// Bungie actions taken; 0 when the weapon was already equipped as asked.
    steps: usize,
    perks_switched: usize,
    /// Perk columns where the copy has none of the god roll's perks, so they were left as they are.
    perks_missing: usize,
}

fn sentence(text: String) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => text,
    }
}

async fn run_step(api: &BungieApi, token: &Secret, account: &DestinyMembership, step: &Step) -> Result<(), ApiError> {
    match step {
        Step::Transfer(t) => api.transfer_item(token, account, t).await,
        Step::Equip { item_id, character_id } => api.equip_item(token, account, item_id, character_id).await,
        Step::Plug { item_id, character_id, socket_index, plug_hash } => {
            api.insert_socket_plug_free(token, account, item_id, character_id, *socket_index, *plug_hash).await
        }
    }
}

/// Brings one owned copy to a character, switches its perks to the wanted ones it has, and equips it
/// when `equip` is true. `perks` holds, per perk column, the wanted perks best first (empty to leave
/// the column alone).
#[tauri::command]
pub async fn equip_copy(
    app: AppHandle,
    sync: State<'_, SyncState>,
    instance_id: String,
    character_id: String,
    perks: Vec<Vec<u32>>,
    equip: bool,
) -> Result<EquipOutcome, String> {
    if sync.acting.swap(true, Ordering::SeqCst) {
        return Err("ParaForge is already moving a weapon. Wait for it to finish.".into());
    }
    let _guard = RunningGuard(&sync.acting);
    if sync.running.load(Ordering::SeqCst) {
        return Err("A sync is running. Try again when it finishes.".into());
    }

    let (keys, _) = auth::access_token(&app.state::<AuthState>()).await?;
    let api = BungieApi::new(&keys).map_err(api_err).map_err(sentence)?;
    let (profile, tokens, account) = read_player(&app, &api).await.map_err(sentence)?;
    let missing = profile.missing_parts();
    if !missing.is_empty() {
        return Err(format!(
            "Bungie did not send your full inventory (missing: {}), so ParaForge can't tell where the weapon is.",
            missing.join(", ")
        ));
    }
    let defs = {
        let state = app.state::<AppState>();
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.weapons().map_err(|e| e.to_string())?
    };
    let request = EquipRequest {
        instance_id,
        character_id,
        perks: perks.into_iter().map(|column| column.into_iter().map(PerkHash).collect()).collect(),
        equip,
    };
    let plan = plan_equip(&profile, &defs, &EnhancedPerks::bundled(), &request)?;

    for (done, step) in plan.steps.iter().enumerate() {
        let mut result = run_step(&api, &tokens.access_token, &account, step).await;
        if let Err(ApiError::Throttled(secs)) = result
            && secs <= MAX_THROTTLE_WAIT_SECS
        {
            tokio::time::sleep(Duration::from_secs(secs.max(1) as u64)).await;
            result = run_step(&api, &tokens.access_token, &account, step).await;
        }
        if let Err(e) = result {
            let message = sentence(api_err(e));
            return Err(if done == 0 {
                message
            } else {
                format!("{message} ParaForge got part of the way; sync to see where the weapon is now.")
            });
        }
    }

    let character = profile
        .characters()
        .into_iter()
        .find(|c| c.id == request.character_id)
        .map(|c| c.class)
        .unwrap_or_else(|| "character".into());
    Ok(EquipOutcome {
        character,
        moved: plan.moves,
        steps: plan.steps.len(),
        equipped: request.equip,
        perks_switched: plan.perks_switched,
        perks_missing: plan.perks_missing,
    })
}
