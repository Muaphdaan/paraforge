//! Turns Bungie manifest definitions and a profile response into ParaForge's weapon model.
//!
//! Pure parsing, no network. Constants and rules follow DIM and d2-additional-info (both MIT);
//! see `data/NOTICE.md` and the research notes in the project files.

use std::collections::{HashMap, HashSet};

use paraforge_core::{
    ColumnRole, CopyColumn, CopyLocation, PerkHash, PerkInfo, Tier, WeaponCopy, WeaponDef, WeaponHash, WeaponLook,
};
use serde::Deserialize;

/// DestinyItemType.Weapon.
const ITEM_TYPE_WEAPON: i32 = 3;
/// ItemCategory "Weapon".
const ICH_WEAPON: u32 = 1;
/// ItemCategory "Dummies" (placeholder items that are not real weapons).
const ICH_DUMMIES: u32 = 3_109_687_656;
/// ItemCategory for origin traits, which are not random-roll columns.
const ICH_ORIGIN_TRAITS: u32 = 2_779_167_812;
/// SocketCategory "WEAPON PERKS".
const SOCKET_CATEGORY_WEAPON_PERKS: u32 = 4_241_085_061;
/// Socket types that sit in the perk category but are not perk columns: kill tracker, masterwork.
const SOCKET_TYPES_NOT_COLUMNS: [u32; 2] = [1_282_012_138, 2_218_962_841];

/// Plug categories of barrel-like columns (first component column).
const BARREL_CATEGORIES: [&str; 7] = ["barrels", "scopes", "tubes", "bowstrings", "blades", "hafts", "rails"];
/// Plug categories of magazine-like columns (second component column).
const MAGAZINE_CATEGORIES: [&str; 6] = ["magazines", "magazines_gl", "batteries", "arrows", "guards", "bolts"];
/// Plug category of the random trait columns.
const TRAIT_CATEGORY: &str = "frames";

/// ItemState bits on an owned item.
const STATE_LOCKED: u32 = 1;
const STATE_MASTERWORK: u32 = 4;

/// Normal perk hash -> enhanced perk hash, from d2-additional-info `trait-to-enhanced-trait.json`.
const ENHANCED_MAP_JSON: &str = include_str!("../data/trait-to-enhanced-trait.json");

/// Looks up enhanced perks and their normal versions.
#[derive(Debug, Clone)]
pub struct EnhancedPerks {
    to_base: HashMap<u32, u32>,
}

impl EnhancedPerks {
    /// The mapping bundled with this build.
    pub fn bundled() -> Self {
        Self::from_json(ENHANCED_MAP_JSON).expect("bundled enhanced-perk map is valid")
    }

    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        let base_to_enhanced: HashMap<String, u32> = serde_json::from_str(json)?;
        let to_base = base_to_enhanced.into_iter().filter_map(|(k, v)| Some((v, k.parse().ok()?))).collect();
        Ok(Self { to_base })
    }

    pub fn is_enhanced(&self, perk: u32) -> bool {
        self.to_base.contains_key(&perk)
    }

    /// The normal version of a perk (itself if it is not enhanced).
    pub fn base(&self, perk: u32) -> u32 {
        self.to_base.get(&perk).copied().unwrap_or(perk)
    }
}

// ---- Manifest ----

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawDisplay {
    pub name: String,
    pub description: String,
    pub icon: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawInventoryBlock {
    pub tier_type: u8,
    pub bucket_type_hash: u32,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawEquippingBlock {
    pub ammo_type: u8,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawPlugItem {
    pub plug_item_hash: u32,
    /// In a random-roll plug set: false for perks that no longer drop. Missing means it can roll.
    pub currently_can_roll: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawSocketEntry {
    pub socket_type_hash: u32,
    pub single_initial_item_hash: u32,
    pub reusable_plug_set_hash: Option<u32>,
    pub randomized_plug_set_hash: Option<u32>,
    pub reusable_plug_items: Vec<RawPlugItem>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawSocketCategory {
    pub socket_category_hash: u32,
    pub socket_indexes: Vec<i32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawSockets {
    pub socket_entries: Vec<RawSocketEntry>,
    pub socket_categories: Vec<RawSocketCategory>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawPlug {
    pub plug_category_identifier: String,
}

/// The fields of `DestinyInventoryItemDefinition` that ParaForge reads.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawItemDef {
    pub hash: u32,
    pub display_properties: RawDisplay,
    pub item_type_display_name: String,
    pub item_type: i32,
    pub item_category_hashes: Vec<u32>,
    pub sockets: Option<RawSockets>,
    pub plug: Option<RawPlug>,
    pub redacted: bool,
    pub icon_watermark: String,
    pub screenshot: String,
    pub inventory: RawInventoryBlock,
    pub equipping_block: RawEquippingBlock,
    pub default_damage_type: u8,
}

/// Inventory buckets of the three weapon slots.
const BUCKET_KINETIC: u32 = 1_498_876_634;
const BUCKET_ENERGY: u32 = 2_465_295_065;
const BUCKET_POWER: u32 = 953_998_645;

fn look(item: &RawItemDef) -> WeaponLook {
    WeaponLook {
        icon: item.display_properties.icon.clone(),
        watermark: item.icon_watermark.clone(),
        screenshot: item.screenshot.clone(),
        slot: match item.inventory.bucket_type_hash {
            BUCKET_KINETIC => 1,
            BUCKET_ENERGY => 2,
            BUCKET_POWER => 3,
            _ => 0,
        },
        damage: item.default_damage_type,
        ammo: item.equipping_block.ammo_type,
        rarity: item.inventory.tier_type,
    }
}

/// The fields of `DestinyPlugSetDefinition` that ParaForge reads.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawPlugSetDef {
    pub reusable_plug_items: Vec<RawPlugItem>,
}

/// Weapons and perk names extracted from the manifest.
#[derive(Debug, Default)]
pub struct Catalog {
    pub weapons: Vec<WeaponDef>,
    pub perks: Vec<PerkInfo>,
}

fn is_weapon(item: &RawItemDef) -> bool {
    item.item_type == ITEM_TYPE_WEAPON
        && item.item_category_hashes.contains(&ICH_WEAPON)
        && !item.item_category_hashes.contains(&ICH_DUMMIES)
        && !item.redacted
        && !item.display_properties.name.is_empty()
}

/// Every plug that can appear in a socket according to the definitions.
fn candidate_plugs(entry: &RawSocketEntry, plug_sets: &HashMap<String, RawPlugSetDef>) -> Vec<u32> {
    let mut out = Vec::new();
    for set in [entry.randomized_plug_set_hash, entry.reusable_plug_set_hash].into_iter().flatten() {
        if let Some(def) = plug_sets.get(&set.to_string()) {
            out.extend(def.reusable_plug_items.iter().map(|p| p.plug_item_hash));
        }
    }
    out.extend(entry.reusable_plug_items.iter().map(|p| p.plug_item_hash));
    if entry.single_initial_item_hash != 0 {
        out.push(entry.single_initial_item_hash);
    }
    let mut seen = HashSet::new();
    out.retain(|h| *h != 0 && seen.insert(*h));
    out
}

/// The perks a column can roll today, as base (non-enhanced) hashes. For random-roll columns this is
/// the randomized plug set minus retired perks; for fixed columns, every plug the socket offers.
fn column_pool(
    entry: &RawSocketEntry,
    plug_sets: &HashMap<String, RawPlugSetDef>,
    enhanced: &EnhancedPerks,
) -> Vec<PerkHash> {
    let random = entry.randomized_plug_set_hash.and_then(|h| plug_sets.get(&h.to_string()));
    let raw: Vec<u32> = match random {
        Some(set) => set
            .reusable_plug_items
            .iter()
            .filter(|p| p.currently_can_roll != Some(false))
            .map(|p| p.plug_item_hash)
            .collect(),
        None => candidate_plugs(entry, plug_sets),
    };
    let mut pool: Vec<PerkHash> = Vec::new();
    for hash in raw.into_iter().filter(|h| *h != 0).map(|h| PerkHash(enhanced.base(h))) {
        if !pool.contains(&hash) {
            pool.push(hash);
        }
    }
    pool
}

fn column_role(plugs: &[u32], items: &HashMap<String, RawItemDef>) -> Option<ColumnRole> {
    let mut categories = HashSet::new();
    for hash in plugs {
        let Some(def) = items.get(&hash.to_string()) else { continue };
        if def.item_category_hashes.contains(&ICH_ORIGIN_TRAITS) {
            return None;
        }
        if let Some(plug) = &def.plug {
            categories.insert(plug.plug_category_identifier.as_str());
        }
    }
    if categories.contains(TRAIT_CATEGORY) {
        Some(ColumnRole::Trait)
    } else if BARREL_CATEGORIES.iter().any(|c| categories.contains(c)) {
        Some(ColumnRole::Barrel)
    } else if MAGAZINE_CATEGORIES.iter().any(|c| categories.contains(c)) {
        Some(ColumnRole::Magazine)
    } else {
        // Intrinsics, origin traits, stocks, grips, catalysts and the like are not scored columns.
        None
    }
}

/// Builds the weapon catalog from the `DestinyInventoryItemDefinition` and `DestinyPlugSetDefinition`
/// tables (each a JSON object keyed by hash).
pub fn build_catalog(
    items: &HashMap<String, RawItemDef>,
    plug_sets: &HashMap<String, RawPlugSetDef>,
    enhanced: &EnhancedPerks,
) -> Catalog {
    let mut catalog = Catalog::default();
    let mut perk_hashes = HashSet::new();
    for item in items.values().filter(|i| is_weapon(i)) {
        let mut columns = Vec::new();
        let mut socket_indexes = Vec::new();
        let mut pools = Vec::new();
        let perk_category = item.sockets.as_ref().and_then(|sockets| {
            let category =
                sockets.socket_categories.iter().find(|c| c.socket_category_hash == SOCKET_CATEGORY_WEAPON_PERKS)?;
            Some((sockets, category))
        });
        if let Some((sockets, category)) = perk_category {
            for &index in &category.socket_indexes {
                let Ok(index_u8) = u8::try_from(index) else { continue };
                let Some(entry) = sockets.socket_entries.get(index_u8 as usize) else { continue };
                if entry.socket_type_hash == 0 || SOCKET_TYPES_NOT_COLUMNS.contains(&entry.socket_type_hash) {
                    continue;
                }
                let plugs = candidate_plugs(entry, plug_sets);
                if let Some(role) = column_role(&plugs, items) {
                    columns.push(role);
                    socket_indexes.push(index_u8);
                    pools.push(column_pool(entry, plug_sets, enhanced));
                    perk_hashes.extend(plugs.iter().map(|p| enhanced.base(*p)));
                }
            }
        }
        // Weapons without random perk columns (most exotics) are kept, so they still show in the vault.
        catalog.weapons.push(WeaponDef {
            hash: WeaponHash(item.hash),
            name: item.display_properties.name.clone(),
            type_name: item.item_type_display_name.clone(),
            columns,
            socket_indexes,
            look: look(item),
            pools,
        });
    }
    for hash in perk_hashes {
        if let Some(def) = items.get(&hash.to_string()) {
            catalog.perks.push(PerkInfo {
                hash: PerkHash(hash),
                name: def.display_properties.name.clone(),
                plug_category: def.plug.as_ref().map(|p| p.plug_category_identifier.clone()).unwrap_or_default(),
                icon: def.display_properties.icon.clone(),
                description: def.display_properties.description.clone(),
            });
        }
    }
    catalog.weapons.sort_by_key(|w| w.hash);
    catalog.perks.sort_by_key(|p| p.hash);
    catalog
}

// ---- Profile ----

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawItem {
    pub item_hash: u32,
    pub item_instance_id: Option<String>,
    pub state: u32,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct RawItemList {
    pub items: Vec<RawItem>,
}

/// A component wrapper: `data` is missing when privacy settings hide the component.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct Component<T> {
    pub data: Option<T>,
    pub privacy: i32,
}

impl<T> Default for Component<T> {
    fn default() -> Self {
        Self { data: None, privacy: 0 }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawStat {
    pub stat_hash: u32,
    pub value: i32,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct RawItemStats {
    pub stats: HashMap<String, RawStat>,
}

/// Profile component 100: who the player is.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawProfileData {
    pub user_info: RawUserInfo,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawUserInfo {
    pub display_name: String,
    pub bungie_global_display_name: String,
    pub bungie_global_display_name_code: Option<u16>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawInstance {
    pub gear_tier: Option<i32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawSocketState {
    pub plug_hash: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct RawItemSockets {
    pub sockets: Vec<RawSocketState>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct RawReusablePlugs {
    pub plugs: HashMap<String, Vec<RawPlugItem>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawItemComponents {
    pub instances: Component<HashMap<String, RawInstance>>,
    pub sockets: Component<HashMap<String, RawItemSockets>>,
    pub reusable_plugs: Component<HashMap<String, RawReusablePlugs>>,
    /// Stats are optional: without them the weapon page just shows no stat bars.
    pub stats: Component<HashMap<String, RawItemStats>>,
}

/// The parts of a `DestinyProfileResponse` that ParaForge reads.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawProfile {
    pub profile: Component<RawProfileData>,
    pub profile_inventory: Component<RawItemList>,
    pub character_inventories: Component<HashMap<String, RawItemList>>,
    pub character_equipment: Component<HashMap<String, RawItemList>>,
    pub item_components: RawItemComponents,
}

impl RawProfile {
    /// Parts of the profile that Bungie left out. Storing a profile with any of these missing
    /// would look like the player had deleted weapons, so the sync refuses it instead.
    pub fn missing_parts(&self) -> Vec<&'static str> {
        let c = &self.item_components;
        [
            ("vault", self.profile_inventory.data.is_none()),
            ("character inventories", self.character_inventories.data.is_none()),
            ("equipped items", self.character_equipment.data.is_none()),
            ("item details", c.instances.data.is_none()),
            ("equipped perks", c.sockets.data.is_none()),
            ("selectable perks", c.reusable_plugs.data.is_none()),
        ]
        .into_iter()
        .filter_map(|(name, missing)| missing.then_some(name))
        .collect()
    }

    /// The player's Bungie Name, for example "NightOwl#4821", when Bungie sent it.
    pub fn player_name(&self) -> Option<String> {
        let info = &self.profile.data.as_ref()?.user_info;
        if !info.bungie_global_display_name.is_empty() {
            Some(match info.bungie_global_display_name_code {
                Some(code) => format!("{}#{code:04}", info.bungie_global_display_name),
                None => info.bungie_global_display_name.clone(),
            })
        } else if !info.display_name.is_empty() {
            Some(info.display_name.clone())
        } else {
            None
        }
    }
}

/// Owned weapons read from a profile, plus what could not be read.
#[derive(Debug, Default, PartialEq)]
pub struct ProfileWeapons {
    pub copies: Vec<WeaponCopy>,
    /// Instance ids of weapons whose perks could not be read (usually hidden by privacy settings).
    pub unreadable: Vec<String>,
    /// True when Bungie hid character inventories, so the list may be incomplete.
    pub characters_hidden: bool,
}

/// Reads every owned weapon (vault, characters, equipped) that is in `weapons`.
pub fn read_profile(
    profile: &RawProfile,
    weapons: &HashMap<WeaponHash, WeaponDef>,
    enhanced: &EnhancedPerks,
) -> ProfileWeapons {
    let mut out = ProfileWeapons {
        characters_hidden: profile.character_inventories.data.is_none() || profile.character_equipment.data.is_none(),
        ..Default::default()
    };
    let mut lists: Vec<(CopyLocation, &RawItemList)> = Vec::new();
    lists.extend(profile.profile_inventory.data.iter().map(|l| (CopyLocation::Vault, l)));
    for (location, chars) in [
        (CopyLocation::Inventory, &profile.character_inventories),
        (CopyLocation::Equipped, &profile.character_equipment),
    ] {
        if let Some(map) = &chars.data {
            let mut ids: Vec<&String> = map.keys().collect();
            ids.sort();
            lists.extend(ids.into_iter().map(|id| (location, &map[id])));
        }
    }
    let comps = &profile.item_components;
    let mut seen = HashSet::new();
    for (location, item) in lists.into_iter().flat_map(|(loc, l)| l.items.iter().map(move |i| (loc, i))) {
        let Some(id) = &item.item_instance_id else { continue };
        let Some(def) = weapons.get(&WeaponHash(item.item_hash)) else { continue };
        if !seen.insert(id.clone()) {
            continue;
        }
        match read_copy(id, item, def, comps, enhanced) {
            Some(mut copy) => {
                copy.location = location;
                out.copies.push(copy);
            }
            None => out.unreadable.push(id.clone()),
        }
    }
    out
}

fn read_copy(
    id: &str,
    item: &RawItem,
    def: &WeaponDef,
    comps: &RawItemComponents,
    enhanced: &EnhancedPerks,
) -> Option<WeaponCopy> {
    let sockets = comps.sockets.data.as_ref()?.get(id)?;
    let reusable = comps.reusable_plugs.data.as_ref().and_then(|d| d.get(id));
    let gear_tier = comps.instances.data.as_ref().and_then(|d| d.get(id)).and_then(|i| i.gear_tier).unwrap_or(0);
    let tier = Tier::new(gear_tier.clamp(0, i32::from(Tier::MAX)) as u8)?;

    let mut columns = Vec::with_capacity(def.socket_indexes.len());
    for &index in &def.socket_indexes {
        let mut raw: Vec<u32> = reusable
            .and_then(|r| r.plugs.get(&index.to_string()))
            .map(|plugs| plugs.iter().map(|p| p.plug_item_hash).collect())
            .unwrap_or_default();
        if let Some(plugged) = sockets.sockets.get(index as usize).and_then(|s| s.plug_hash)
            && !raw.contains(&plugged)
        {
            raw.push(plugged);
        }
        let is_enhanced = raw.iter().any(|p| enhanced.is_enhanced(*p));
        let mut options: Vec<PerkHash> = Vec::new();
        for perk in raw.into_iter().filter(|p| *p != 0).map(|p| PerkHash(enhanced.base(p))) {
            if !options.contains(&perk) {
                options.push(perk);
            }
        }
        columns.push(CopyColumn { options, enhanced: is_enhanced });
    }
    if def.socket_indexes.len() != def.columns.len() {
        return None;
    }
    Some(WeaponCopy {
        instance_id: id.to_string(),
        weapon: def.hash,
        tier,
        columns,
        masterworked: item.state & STATE_MASTERWORK != 0,
        locked: item.state & STATE_LOCKED != 0,
        stats: comps
            .stats
            .data
            .as_ref()
            .and_then(|d| d.get(id))
            .map(|s| s.stats.values().map(|stat| (stat.stat_hash, stat.value)).collect())
            .unwrap_or_default(),
        location: CopyLocation::Vault,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enhanced() -> EnhancedPerks {
        EnhancedPerks::bundled()
    }

    #[test]
    fn bundled_enhanced_map_loads() {
        let e = enhanced();
        // From d2-additional-info: 1955165503 -> 2617553311.
        assert!(e.is_enhanced(2_617_553_311));
        assert_eq!(e.base(2_617_553_311), 1_955_165_503);
        assert!(!e.is_enhanced(1_955_165_503));
        assert_eq!(e.base(42), 42);
    }

    fn item(json: serde_json::Value) -> RawItemDef {
        serde_json::from_value(json).unwrap()
    }

    fn plug(hash: u32, name: &str, category: &str) -> (String, RawItemDef) {
        (
            hash.to_string(),
            item(serde_json::json!({
                "hash": hash, "displayProperties": {"name": name}, "itemType": 19,
                "itemCategoryHashes": [], "plug": {"plugCategoryIdentifier": category}
            })),
        )
    }

    /// A definition shaped like a random-roll legendary: intrinsic, barrel, magazine, two traits,
    /// origin trait, kill tracker, plus a cosmetic socket outside the perk category.
    fn manifest() -> (HashMap<String, RawItemDef>, HashMap<String, RawPlugSetDef>) {
        let weapon = item(serde_json::json!({
            "hash": 1000, "displayProperties": {"name": "Test Hand Cannon", "icon": "/icons/hc.jpg"},
            "itemTypeDisplayName": "Hand Cannon", "itemType": 3, "itemCategoryHashes": [1, 6],
            "iconWatermark": "/icons/season.png", "screenshot": "/screens/hc.jpg",
            "inventory": {"tierType": 5, "bucketTypeHash": 2465295065u32},
            "equippingBlock": {"ammoType": 1}, "defaultDamageType": 3,
            "sockets": {
                "socketEntries": [
                    {"socketTypeHash": 1, "singleInitialItemHash": 10},
                    {"socketTypeHash": 2, "singleInitialItemHash": 0, "randomizedPlugSetHash": 501},
                    {"socketTypeHash": 3, "singleInitialItemHash": 0, "randomizedPlugSetHash": 502},
                    {"socketTypeHash": 4, "singleInitialItemHash": 0, "randomizedPlugSetHash": 503},
                    {"socketTypeHash": 4, "singleInitialItemHash": 0, "randomizedPlugSetHash": 504},
                    {"socketTypeHash": 5, "singleInitialItemHash": 4248210736u32},
                    {"socketTypeHash": 6, "singleInitialItemHash": 60, "reusablePlugSetHash": 506},
                    {"socketTypeHash": 1282012138, "singleInitialItemHash": 70}
                ],
                "socketCategories": [
                    {"socketCategoryHash": 3956125808u32, "socketIndexes": [0]},
                    {"socketCategoryHash": 4241085061u32, "socketIndexes": [1, 2, 3, 4, 6, 7]},
                    {"socketCategoryHash": 2048875504, "socketIndexes": [5]}
                ]
            }
        }));
        let dummy = item(serde_json::json!({
            "hash": 2000, "displayProperties": {"name": "Dummy"}, "itemType": 3, "itemCategoryHashes": [1, 3109687656u32]
        }));
        let exotic = item(serde_json::json!({
            "hash": 3000, "displayProperties": {"name": "Test Exotic"}, "itemTypeDisplayName": "Rocket Launcher",
            "itemType": 3, "itemCategoryHashes": [1, 13],
            "inventory": {"tierType": 6, "bucketTypeHash": 953998645}, "equippingBlock": {"ammoType": 3},
            "defaultDamageType": 2
        }));
        let mut items: HashMap<String, RawItemDef> = [
            ("1000".to_string(), weapon),
            ("2000".to_string(), dummy),
            ("3000".to_string(), exotic),
            plug(10, "Adaptive Frame", "intrinsics"),
            plug(11, "Arrowhead Brake", "barrels"),
            plug(12, "Hammer-Forged Rifling", "barrels"),
            plug(21, "Ricochet Rounds", "magazines"),
            plug(31, "Rapid Hit", "frames"),
            plug(32, "Outlaw", "frames"),
            plug(33, "Retired Perk", "frames"),
            plug(41, "Kill Clip", "frames"),
            plug(42, "Explosive Payload", "frames"),
            plug(60, "Origin", "origins"),
        ]
        .into_iter()
        .collect();
        items.get_mut("60").unwrap().item_category_hashes = vec![ICH_ORIGIN_TRAITS];
        let set = |hashes: &[u32]| RawPlugSetDef {
            reusable_plug_items: hashes
                .iter()
                // 33 is a retired perk: it is in the set but no longer drops.
                .map(|h| RawPlugItem { plug_item_hash: *h, currently_can_roll: (*h == 33).then_some(false) })
                .collect(),
        };
        let sets = [
            ("501", set(&[11, 12])),
            ("502", set(&[21])),
            ("503", set(&[31, 32, 33])),
            ("504", set(&[41, 42])),
            ("506", set(&[60])),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        (items, sets)
    }

    #[test]
    fn catalog_finds_random_roll_columns() {
        let (items, sets) = manifest();
        let c = build_catalog(&items, &sets, &enhanced());
        assert_eq!(c.weapons.len(), 2, "dummies are skipped");
        let w = c.weapons.iter().find(|w| w.hash == WeaponHash(1000)).unwrap();
        assert_eq!(w.name, "Test Hand Cannon");
        assert_eq!(w.type_name, "Hand Cannon");
        use ColumnRole::*;
        assert_eq!(w.columns, vec![Barrel, Magazine, Trait, Trait]);
        assert_eq!(w.socket_indexes, vec![1, 2, 3, 4], "origin trait and kill tracker are not columns");
        let names: Vec<&str> = c.perks.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"Outlaw") && names.contains(&"Arrowhead Brake"));
        assert!(!names.contains(&"Origin"));
        let pool = |hashes: &[u32]| hashes.iter().map(|h| PerkHash(*h)).collect::<Vec<_>>();
        assert_eq!(
            w.pools,
            vec![pool(&[11, 12]), pool(&[21]), pool(&[31, 32]), pool(&[41, 42])],
            "each column's pool, without the retired perk"
        );
    }

    #[test]
    fn catalog_reads_how_weapons_look() {
        let (items, sets) = manifest();
        let c = build_catalog(&items, &sets, &enhanced());
        let hc = c.weapons.iter().find(|w| w.hash == WeaponHash(1000)).unwrap();
        assert_eq!(
            hc.look,
            WeaponLook {
                icon: "/icons/hc.jpg".into(),
                watermark: "/icons/season.png".into(),
                screenshot: "/screens/hc.jpg".into(),
                slot: 2,
                damage: 3,
                ammo: 1,
                rarity: 5,
            }
        );
        let exotic = c.weapons.iter().find(|w| w.hash == WeaponHash(3000)).expect("exotics are kept");
        assert!(exotic.columns.is_empty());
        assert_eq!((exotic.look.slot, exotic.look.damage, exotic.look.ammo, exotic.look.rarity), (3, 2, 3, 6));
    }

    fn fixture() -> RawProfile {
        let text = include_str!("../tests/fixtures/profile-trimmed.json");
        let envelope: serde_json::Value = serde_json::from_str(text).unwrap();
        serde_json::from_value(envelope["Response"].clone()).unwrap()
    }

    fn layout(hash: u32) -> WeaponDef {
        use ColumnRole::*;
        WeaponDef {
            hash: WeaponHash(hash),
            name: format!("w{hash}"),
            type_name: String::new(),
            columns: vec![Barrel, Magazine, Trait, Trait],
            socket_indexes: vec![1, 2, 3, 4],
            look: Default::default(),
            pools: Vec::new(),
        }
    }

    #[test]
    fn reads_stats_location_and_player_name() {
        let profile: RawProfile = serde_json::from_value(serde_json::json!({
            "profile": {"data": {"userInfo": {"displayName": "old", "bungieGlobalDisplayName": "NightOwl",
                "bungieGlobalDisplayNameCode": 21}}},
            "profileInventory": {"data": {"items": [{"itemHash": 1, "itemInstanceId": "a", "state": 0}]}},
            "characterInventories": {"data": {"c1": {"items": [{"itemHash": 1, "itemInstanceId": "b"}]}}},
            "characterEquipment": {"data": {"c1": {"items": [{"itemHash": 1, "itemInstanceId": "c"}]}}},
            "itemComponents": {
                "instances": {"data": {}},
                "sockets": {"data": {"a": {"sockets": []}, "b": {"sockets": []}, "c": {"sockets": []}}},
                "reusablePlugs": {"data": {}},
                "stats": {"data": {"a": {"stats": {
                    "4043523819": {"statHash": 4043523819u32, "value": 70},
                    "3871231066": {"statHash": 3871231066u32, "value": 12}
                }}}}
            }
        }))
        .unwrap();
        assert_eq!(profile.player_name().as_deref(), Some("NightOwl#0021"));
        let fixed = WeaponDef { columns: vec![], socket_indexes: vec![], ..layout(1) };
        let defs: HashMap<WeaponHash, WeaponDef> = [(WeaponHash(1), fixed)].into_iter().collect();
        let out = read_profile(&profile, &defs, &enhanced());
        let by_id: HashMap<&str, &WeaponCopy> = out.copies.iter().map(|c| (c.instance_id.as_str(), c)).collect();
        assert_eq!(by_id["a"].location, CopyLocation::Vault);
        assert_eq!(by_id["b"].location, CopyLocation::Inventory);
        assert_eq!(by_id["c"].location, CopyLocation::Equipped);
        assert_eq!(by_id["a"].stats.get(&4_043_523_819), Some(&70));
        assert_eq!(by_id["a"].stats.get(&3_871_231_066), Some(&12));
        assert!(by_id["b"].stats.is_empty(), "stats are optional");
    }

    #[test]
    fn reads_real_profile_shape() {
        // Trimmed from DIM's test profile (2026-06-09). Weapon layouts are assumed (sockets 1-4),
        // since the manifest is not available offline.
        let defs: HashMap<WeaponHash, WeaponDef> =
            [2_922_964_484, 3_281_285_075, 2_218_569_744].into_iter().map(|h| (WeaponHash(h), layout(h))).collect();
        let out = read_profile(&fixture(), &defs, &enhanced());
        assert!(out.unreadable.is_empty());
        assert!(!out.characters_hidden);
        assert_eq!(out.copies.len(), 3);
        let by_id: HashMap<&str, &WeaponCopy> = out.copies.iter().map(|c| (c.instance_id.as_str(), c)).collect();

        // Tier 4 copy, every column enhanced, two selectable options per column.
        let t4 = by_id["6917530166076737087"];
        assert_eq!(t4.tier.get(), 4);
        assert!(!t4.locked && !t4.masterworked);
        assert!(t4.columns.iter().all(|c| c.enhanced && c.options.len() == 2), "{:?}", t4.columns);
        // Enhanced 2617553311 is stored as its normal version 1955165503.
        assert!(t4.columns[2].options.contains(&PerkHash(1_955_165_503)));
        assert!(!t4.columns[2].options.contains(&PerkHash(2_617_553_311)));

        // Untiered legacy copy, locked.
        let legacy = by_id["6917529257805248292"];
        assert_eq!(legacy.tier.get(), 0);
        assert!(legacy.locked);
        assert_eq!(legacy.columns[0].options.len(), 2);
        assert_eq!(legacy.columns[2].options.len(), 1);

        // Crafted, masterworked, locked (state 13).
        let crafted = by_id["6917529855341690372"];
        assert!(crafted.masterworked && crafted.locked);
    }

    #[test]
    fn hidden_components_are_reported_not_fatal() {
        let mut p = fixture();
        p.character_inventories.data = None;
        p.item_components.sockets.data = None;
        let defs: HashMap<WeaponHash, WeaponDef> = [(WeaponHash(2_922_964_484), layout(2_922_964_484))].into();
        let out = read_profile(&p, &defs, &enhanced());
        assert!(out.characters_hidden);
        assert!(out.copies.is_empty());
        assert_eq!(out.unreadable, vec!["6917530166076737087".to_string()]);
        assert_eq!(p.missing_parts(), vec!["character inventories", "equipped perks"]);
        assert!(fixture().missing_parts().is_empty());
    }
}
