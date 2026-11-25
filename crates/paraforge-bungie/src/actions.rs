//! Plans the Bungie item actions that put a weapon in a character's hands: room in the slot, moves
//! through the vault, perk switches and the equip itself.
//!
//! Pure planning from a fresh profile, no network, so every refusal is found before anything moves.
//! The order of moves follows how DIM does it (MIT).

use std::collections::HashMap;

use paraforge_core::{PerkHash, WeaponDef, WeaponHash};

use crate::inventory::{BUCKET_ENERGY, BUCKET_KINETIC, BUCKET_POWER, EnhancedPerks, RawItem, RawProfile, class_name};

/// Bungie TierType of Exotic items.
const RARITY_EXOTIC: u8 = 6;
/// A character holds nine unequipped weapons per slot.
const SLOT_CAPACITY: usize = 9;

/// One move between a character and the vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transfer {
    pub item_hash: u32,
    pub item_id: String,
    /// The character the item leaves (to the vault) or arrives on (from the vault).
    pub character_id: String,
    pub to_vault: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Transfer(Transfer),
    Equip { item_id: String, character_id: String },
    Plug { item_id: String, character_id: String, socket_index: u8, plug_hash: u32 },
}

/// What ParaForge was asked to do with one copy.
#[derive(Debug, Clone, Default)]
pub struct EquipRequest {
    pub instance_id: String,
    pub character_id: String,
    /// Per perk column (weapon column order): the wanted perks, best first. An empty list leaves the
    /// column as it is. A column already showing one of its wanted perks is left as it is too.
    pub perks: Vec<Vec<PerkHash>>,
    /// False to only bring the weapon to the character (and switch perks) without equipping it.
    pub equip: bool,
}

/// The plan, plus what it could not do without failing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EquipPlan {
    pub steps: Vec<Step>,
    /// Columns where the copy has none of the wanted perks, so they are left as they are.
    pub perks_missing: usize,
    /// Perk switches in the plan.
    pub perks_switched: usize,
    /// True when the weapon has to move.
    pub moves: bool,
}

/// Where an owned item is now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Place<'a> {
    Vault,
    Inventory(&'a str),
    Equipped(&'a str),
}

fn weapon_bucket(def: &WeaponDef) -> Option<u32> {
    match def.look.slot {
        1 => Some(BUCKET_KINETIC),
        2 => Some(BUCKET_ENERGY),
        3 => Some(BUCKET_POWER),
        _ => None,
    }
}

fn slot_name(bucket: u32) -> &'static str {
    match bucket {
        BUCKET_KINETIC => "Kinetic",
        BUCKET_ENERGY => "Energy",
        _ => "Power",
    }
}

fn is_exotic(weapons: &HashMap<WeaponHash, WeaponDef>, item: &RawItem) -> bool {
    weapons.get(&WeaponHash(item.item_hash)).is_some_and(|d| d.look.rarity == RARITY_EXOTIC)
}

fn items_of<'a>(lists: &'a Option<HashMap<String, crate::inventory::RawItemList>>, character: &str) -> &'a [RawItem] {
    lists.as_ref().and_then(|m| m.get(character)).map(|l| l.items.as_slice()).unwrap_or(&[])
}

/// Plans putting `req.instance_id` on `req.character_id`, with its perks switched as asked.
/// Errors are plain sentences for the player.
pub fn plan_equip(
    profile: &RawProfile,
    weapons: &HashMap<WeaponHash, WeaponDef>,
    enhanced: &EnhancedPerks,
    req: &EquipRequest,
) -> Result<EquipPlan, String> {
    let target = req.character_id.as_str();
    let class_of = |id: &str| {
        profile
            .characters
            .data
            .as_ref()
            .and_then(|m| m.get(id))
            .map(|c| class_name(c.class_type))
            .unwrap_or("other character")
    };
    let inventories = &profile.character_inventories.data;
    let equipment = &profile.character_equipment.data;
    if inventories.as_ref().is_none_or(|m| !m.contains_key(target)) {
        return Err("Bungie did not list that character. Sync and try again.".into());
    }

    // Find the copy.
    let mut found: Option<(Place, &RawItem)> = None;
    let mine = |i: &&RawItem| i.item_instance_id.as_deref() == Some(req.instance_id.as_str());
    if let Some(item) = profile.profile_inventory.data.iter().flat_map(|l| l.items.iter()).find(mine) {
        found = Some((Place::Vault, item));
    }
    for (lists, equipped) in [(inventories, false), (equipment, true)] {
        for (character, list) in lists.iter().flatten() {
            if let Some(item) = list.items.iter().find(mine) {
                let place = if equipped { Place::Equipped(character) } else { Place::Inventory(character) };
                found = Some((place, item));
            }
        }
    }
    let Some((place, item)) = found else {
        return Err("Bungie could not find that weapon. It may have been dismantled; sync and try again.".into());
    };
    let def = weapons
        .get(&WeaponHash(item.item_hash))
        .ok_or("ParaForge does not know this weapon yet. Sync and try again.")?;
    let bucket = weapon_bucket(def).ok_or("ParaForge does not know which slot this weapon goes in.")?;
    if let Place::Inventory(_) = place
        && item.bucket_hash != bucket
    {
        return Err("This weapon is in the Postmaster. Pick it up in the game first.".into());
    }

    let mut plan = EquipPlan::default();
    let id = req.instance_id.clone();
    let transfer = |it: &RawItem, character: &str, to_vault: bool| {
        Step::Transfer(Transfer {
            item_hash: it.item_hash,
            item_id: it.item_instance_id.clone().unwrap_or_default(),
            character_id: character.to_string(),
            to_vault,
        })
    };

    // 1. Bring it to the target character.
    let on_target = matches!(place, Place::Inventory(c) | Place::Equipped(c) if c == target);
    if !on_target {
        plan.moves = true;
        // Room in the target's slot first.
        let held: Vec<&RawItem> = items_of(inventories, target).iter().filter(|i| i.bucket_hash == bucket).collect();
        if held.len() >= SLOT_CAPACITY {
            // The last one in the list (the game lists newest first) is the least likely to be wanted.
            let spare = held.iter().rev().find(|i| i.item_instance_id.is_some()).copied();
            let spare = spare.ok_or("That character's slot is full and nothing in it can be moved.")?;
            plan.steps.push(transfer(spare, target, true));
        }
        match place {
            Place::Vault => {}
            Place::Inventory(from) => plan.steps.push(transfer(item, from, true)),
            Place::Equipped(from) => {
                // An equipped weapon can't move: something else goes into that slot first.
                let swap = items_of(inventories, from)
                    .iter()
                    .filter(|i| i.bucket_hash == bucket && i.item_instance_id.is_some())
                    .find(|i| !is_exotic(weapons, i))
                    .ok_or_else(|| {
                        format!(
                            "It is equipped on your {}, which has no other {} weapon to swap in. Equip \
                             something else in that slot first.",
                            class_of(from),
                            slot_name(bucket)
                        )
                    })?;
                plan.steps.push(Step::Equip {
                    item_id: swap.item_instance_id.clone().unwrap_or_default(),
                    character_id: from.to_string(),
                });
                plan.steps.push(transfer(item, from, true));
            }
        }
        plan.steps.push(transfer(item, target, false));
    }

    // 2. Perks, once it is on the character.
    let sockets = profile.item_components.sockets.data.as_ref().and_then(|d| d.get(&id));
    let reusable = profile.item_components.reusable_plugs.data.as_ref().and_then(|d| d.get(&id));
    for (column, wanted) in req.perks.iter().enumerate() {
        if wanted.is_empty() {
            continue;
        }
        let Some(&socket) = def.socket_indexes.get(column) else { continue };
        let current = sockets.and_then(|s| s.sockets.get(socket as usize)).and_then(|s| s.plug_hash).unwrap_or(0);
        if wanted.contains(&PerkHash(enhanced.base(current))) {
            continue;
        }
        let choices: Vec<u32> = reusable
            .and_then(|r| r.plugs.get(&socket.to_string()))
            .map(|plugs| {
                plugs
                    .iter()
                    .filter(|p| p.can_insert != Some(false) && p.enabled != Some(false))
                    .map(|p| p.plug_item_hash)
                    .collect()
            })
            .unwrap_or_default();
        // The first wanted perk this copy can select, the enhanced version when it has one.
        let pick = wanted.iter().find_map(|w| {
            let mut matches = choices.iter().copied().filter(|p| enhanced.base(*p) == w.0);
            let all: Vec<u32> = matches.by_ref().collect();
            all.iter().copied().find(|p| enhanced.is_enhanced(*p)).or_else(|| all.first().copied())
        });
        match pick {
            Some(plug_hash) => {
                plan.perks_switched += 1;
                plan.steps.push(Step::Plug {
                    item_id: id.clone(),
                    character_id: target.to_string(),
                    socket_index: socket,
                    plug_hash,
                });
            }
            None => plan.perks_missing += 1,
        }
    }

    // 3. Equip.
    let equipped_on_target = matches!(place, Place::Equipped(c) if c == target);
    if req.equip && !equipped_on_target {
        if def.look.rarity == RARITY_EXOTIC {
            // One exotic weapon at a time: swap out an exotic equipped in another slot.
            let other = items_of(equipment, target)
                .iter()
                .find(|i| i.bucket_hash != bucket && is_exotic(weapons, i) && weapon_bucket_of(i).is_some());
            if let Some(other) = other {
                let swap = items_of(inventories, target)
                    .iter()
                    .filter(|i| i.bucket_hash == other.bucket_hash && i.item_instance_id.is_some())
                    .find(|i| !is_exotic(weapons, i))
                    .ok_or_else(|| {
                        format!(
                            "Your {} already has an exotic {} weapon equipped and nothing to swap in for it. \
                             Equip a Legendary in that slot first.",
                            class_of(target),
                            slot_name(other.bucket_hash)
                        )
                    })?;
                plan.steps.push(Step::Equip {
                    item_id: swap.item_instance_id.clone().unwrap_or_default(),
                    character_id: target.to_string(),
                });
            }
        }
        plan.steps.push(Step::Equip { item_id: id, character_id: target.to_string() });
    }
    Ok(plan)
}

fn weapon_bucket_of(item: &RawItem) -> Option<u32> {
    [BUCKET_KINETIC, BUCKET_ENERGY, BUCKET_POWER].contains(&item.bucket_hash).then_some(item.bucket_hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use paraforge_core::{ColumnRole, WeaponLook};

    const VAULT: u32 = 138_197_802;

    fn weapons() -> HashMap<WeaponHash, WeaponDef> {
        let def = |hash: u32, slot: u8, rarity: u8, sockets: Vec<u8>| WeaponDef {
            hash: WeaponHash(hash),
            name: format!("w{hash}"),
            type_name: "Hand Cannon".into(),
            columns: sockets.iter().map(|_| ColumnRole::Trait).collect(),
            socket_indexes: sockets,
            look: WeaponLook { slot, rarity, ..Default::default() },
            pools: vec![],
            parts: vec![],
        };
        [
            def(1, 2, 5, vec![3, 4]),
            def(2, 2, 5, vec![]),
            def(3, 3, 6, vec![]),
            def(4, 2, 6, vec![]),
            def(5, 3, 5, vec![]),
        ]
        .into_iter()
        .map(|d| (d.hash, d))
        .collect()
    }

    fn item(hash: u32, id: &str, bucket: u32) -> serde_json::Value {
        serde_json::json!({"itemHash": hash, "itemInstanceId": id, "bucketHash": bucket})
    }

    /// A profile: `vault`, then per character (inventory, equipped).
    fn profile(
        vault: Vec<serde_json::Value>,
        chars: Vec<(&str, Vec<serde_json::Value>, Vec<serde_json::Value>)>,
    ) -> RawProfile {
        let mut inv = serde_json::Map::new();
        let mut eq = serde_json::Map::new();
        let mut info = serde_json::Map::new();
        for (i, (id, a, b)) in chars.into_iter().enumerate() {
            inv.insert(id.into(), serde_json::json!({"items": a}));
            eq.insert(id.into(), serde_json::json!({"items": b}));
            info.insert(id.into(), serde_json::json!({"classType": i, "light": 2000, "dateLastPlayed": "2026-11-2"}));
        }
        serde_json::from_value(serde_json::json!({
            "profileInventory": {"data": {"items": vault}},
            "characters": {"data": info},
            "characterInventories": {"data": inv},
            "characterEquipment": {"data": eq},
            "itemComponents": {
                "sockets": {"data": {"x": {"sockets": [{}, {}, {}, {"plugHash": 100}, {"plugHash": 200}]}}},
                "reusablePlugs": {"data": {"x": {"plugs": {
                    "3": [{"plugItemHash": 100}, {"plugItemHash": 101}],
                    "4": [{"plugItemHash": 200}, {"plugItemHash": 201, "canInsert": false}]
                }}}}
            }
        }))
        .unwrap()
    }

    fn req(id: &str, to: &str) -> EquipRequest {
        EquipRequest { instance_id: id.into(), character_id: to.into(), perks: vec![], equip: true }
    }

    fn transfer(hash: u32, id: &str, character: &str, to_vault: bool) -> Step {
        Step::Transfer(Transfer { item_hash: hash, item_id: id.into(), character_id: character.into(), to_vault })
    }

    fn equip(id: &str, character: &str) -> Step {
        Step::Equip { item_id: id.into(), character_id: character.into() }
    }

    #[test]
    fn from_the_vault_moves_switches_perks_and_equips() {
        let p = profile(vec![item(1, "x", VAULT)], vec![("t", vec![], vec![item(2, "e", BUCKET_ENERGY)])]);
        let mut r = req("x", "t");
        // Column 1 wants 101 (selectable), column 2 wants 201 (not selectable now).
        r.perks = vec![vec![PerkHash(101)], vec![PerkHash(201)]];
        let plan = plan_equip(&p, &weapons(), &EnhancedPerks::bundled(), &r).unwrap();
        assert_eq!(
            plan.steps,
            vec![
                transfer(1, "x", "t", false),
                Step::Plug { item_id: "x".into(), character_id: "t".into(), socket_index: 3, plug_hash: 101 },
                equip("x", "t"),
            ]
        );
        assert_eq!((plan.perks_switched, plan.perks_missing, plan.moves), (1, 1, true));
    }

    #[test]
    fn a_wanted_perk_already_selected_is_left_alone() {
        let p = profile(vec![], vec![("t", vec![], vec![item(1, "x", BUCKET_ENERGY)])]);
        let mut r = req("x", "t");
        r.perks = vec![vec![PerkHash(101), PerkHash(100)], vec![]];
        let plan = plan_equip(&p, &weapons(), &EnhancedPerks::bundled(), &r).unwrap();
        assert!(plan.steps.is_empty(), "already equipped with a wanted perk: {:?}", plan.steps);
    }

    #[test]
    fn equipped_elsewhere_swaps_in_a_legendary_then_moves_through_the_vault() {
        let p = profile(
            vec![],
            vec![
                (
                    "a",
                    vec![item(4, "ex", BUCKET_ENERGY), item(2, "spare", BUCKET_ENERGY)],
                    vec![item(1, "x", BUCKET_ENERGY)],
                ),
                ("t", vec![], vec![]),
            ],
        );
        let plan = plan_equip(&p, &weapons(), &EnhancedPerks::bundled(), &req("x", "t")).unwrap();
        assert_eq!(
            plan.steps,
            vec![equip("spare", "a"), transfer(1, "x", "a", true), transfer(1, "x", "t", false), equip("x", "t")]
        );
    }

    #[test]
    fn equipped_elsewhere_with_nothing_to_swap_is_refused_before_anything_moves() {
        let p = profile(vec![], vec![("a", vec![], vec![item(1, "x", BUCKET_ENERGY)]), ("t", vec![], vec![])]);
        let e = plan_equip(&p, &weapons(), &EnhancedPerks::bundled(), &req("x", "t")).unwrap_err();
        assert!(e.contains("Titan") && e.contains("Energy"), "{e}");
    }

    #[test]
    fn a_full_slot_sends_one_weapon_to_the_vault_first() {
        let full: Vec<_> = (0..9).map(|i| item(2, &format!("f{i}"), BUCKET_ENERGY)).collect();
        let p = profile(vec![item(1, "x", VAULT)], vec![("t", full, vec![])]);
        let plan = plan_equip(&p, &weapons(), &EnhancedPerks::bundled(), &req("x", "t")).unwrap();
        assert_eq!(plan.steps[0], transfer(2, "f8", "t", true));
        assert_eq!(plan.steps[1], transfer(1, "x", "t", false));
    }

    #[test]
    fn an_exotic_replaces_the_other_equipped_exotic() {
        let p = profile(
            vec![],
            vec![(
                "t",
                vec![item(4, "ex", BUCKET_ENERGY), item(5, "leg", BUCKET_POWER)],
                vec![item(3, "gjally", BUCKET_POWER)],
            )],
        );
        let plan = plan_equip(&p, &weapons(), &EnhancedPerks::bundled(), &req("ex", "t")).unwrap();
        assert_eq!(plan.steps, vec![equip("leg", "t"), equip("ex", "t")]);
        assert!(!plan.moves);
    }

    #[test]
    fn postmaster_and_unknown_items_are_refused() {
        let p = profile(vec![], vec![("t", vec![item(1, "x", 215_593_132)], vec![])]);
        assert!(
            plan_equip(&p, &weapons(), &EnhancedPerks::bundled(), &req("x", "t")).unwrap_err().contains("Postmaster")
        );
        assert!(plan_equip(&p, &weapons(), &EnhancedPerks::bundled(), &req("gone", "t")).is_err());
        assert!(plan_equip(&p, &weapons(), &EnhancedPerks::bundled(), &req("x", "nobody")).is_err());
    }

    #[test]
    fn characters_sort_most_recent_first() {
        let p: RawProfile = serde_json::from_value(serde_json::json!({"characters": {"data": {
            "1": {"classType": 0, "light": 1990, "dateLastPlayed": "2026-11-01T10:00:00Z"},
            "2": {"classType": 2, "light": 2010, "dateLastPlayed": "2026-11-20T10:00:00Z"}
        }}}))
        .unwrap();
        let c = p.characters();
        assert_eq!((c[0].class.as_str(), c[0].light, c[1].class.as_str()), ("Warlock", 2010, "Titan"));
    }
}
