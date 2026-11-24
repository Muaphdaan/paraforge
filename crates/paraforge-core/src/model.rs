//! Data model shared by the database, the scoring engine and (later) the Bungie sync.
//!
//! Hashes are Bungie manifest hashes. Everything here is plain data: no I/O.

use std::fmt;

use serde::{Deserialize, Serialize};

/// A weapon definition hash from the Bungie manifest (`DestinyInventoryItemDefinition`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WeaponHash(pub u32);

/// A perk (plug) definition hash from the Bungie manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PerkHash(pub u32);

/// Gear tier, 0 to 5. 0 means the weapon has no tier (most weapons from before tiers existed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub struct Tier(u8);

impl Tier {
    pub const MIN: u8 = 0;
    pub const MAX: u8 = 5;

    pub fn new(value: u8) -> Option<Self> {
        (Self::MIN..=Self::MAX).contains(&value).then_some(Self(value))
    }

    pub fn get(self) -> u8 {
        self.0
    }
}

impl TryFrom<u8> for Tier {
    type Error = String;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        Tier::new(value).ok_or_else(|| format!("tier must be 0 to 5, got {value}"))
    }
}

impl From<Tier> for u8 {
    fn from(tier: Tier) -> u8 {
        tier.0
    }
}

/// What a roll is judged for. The UI shows these as "PvE endgame" and "PvP".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Context {
    Pve,
    Pvp,
}

impl Context {
    pub const ALL: [Context; 2] = [Context::Pve, Context::Pvp];

    pub fn as_str(self) -> &'static str {
        match self {
            Context::Pve => "pve",
            Context::Pvp => "pvp",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == value)
    }
}

impl fmt::Display for Context {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The role of a random-perk column. Scoring weights are set per role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnRole {
    Barrel,
    Magazine,
    Trait,
}

/// One weapon in the game (manifest data, trimmed to what the core needs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeaponDef {
    pub hash: WeaponHash,
    pub name: String,
    /// Display type, for example "Hand Cannon".
    pub type_name: String,
    /// The random-perk columns in socket order, for example barrel, magazine, trait, trait.
    pub columns: Vec<ColumnRole>,
    /// The item socket index of each column, same length and order as `columns`.
    #[serde(default)]
    pub socket_indexes: Vec<u8>,
    /// How the weapon looks and where it goes: icons, slot, element, ammo, rarity.
    #[serde(default)]
    pub look: WeaponLook,
}

/// Display data for a weapon, from Bungie's item definitions.
///
/// Image fields are bungie.net paths (for example `/common/destiny2_content/icons/...png`), empty when
/// Bungie has none. The numbers keep Bungie's own enum values, so 0 always means unknown.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WeaponLook {
    pub icon: String,
    /// The season badge Bungie draws over the icon's top-left corner.
    pub watermark: String,
    /// A wide screenshot of the weapon, for the detail panel.
    pub screenshot: String,
    /// 1 Kinetic, 2 Energy, 3 Power.
    pub slot: u8,
    /// Bungie DamageType: 1 Kinetic, 2 Arc, 3 Thermal (Solar), 4 Void, 6 Stasis, 7 Strand.
    pub damage: u8,
    /// Bungie DestinyAmmunitionType: 1 Primary, 2 Special, 3 Heavy.
    pub ammo: u8,
    /// Bungie TierType: 5 Legendary (Superior), 6 Exotic.
    pub rarity: u8,
}

/// One column on an owned copy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CopyColumn {
    /// Perks the player can select in this column (usually one, two on some drops).
    pub options: Vec<PerkHash>,
    /// Whether the perk in this column is the enhanced version.
    #[serde(default)]
    pub enhanced: bool,
}

/// One copy of a weapon the player owns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeaponCopy {
    /// Bungie item instance id (a decimal string; it does not fit in a JS number).
    pub instance_id: String,
    pub weapon: WeaponHash,
    pub tier: Tier,
    /// Same length and order as [`WeaponDef::columns`].
    pub columns: Vec<CopyColumn>,
    #[serde(default)]
    pub masterworked: bool,
    #[serde(default)]
    pub locked: bool,
}

/// A recommended perk set for a weapon in one context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CuratedRoll {
    pub weapon: WeaponHash,
    pub context: Context,
    /// Accepted perks per column. An empty list means any perk is fine in that column.
    pub columns: Vec<Vec<PerkHash>>,
    pub curator: String,
}

/// A perk's display data from the manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PerkInfo {
    pub hash: PerkHash,
    pub name: String,
    /// Bungie's plug category identifier, for example "barrels" or "frames".
    pub plug_category: String,
    /// bungie.net path of the perk's icon, empty when Bungie has none.
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub description: String,
}

/// Provenance of a value, so the UI can badge it (official, community, ParaForge).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provenance {
    pub source: String,
    pub version: String,
    pub license: String,
    /// RFC 3339 date the value was fetched or built.
    pub fetched: String,
}
