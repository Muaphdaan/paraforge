//! Scoring rules and perk ratings.
//!
//! The defaults here are placeholders for development. The real values ship in the
//! signed data pack built from the `paraforge-data` repository, pinned to a ruleset version.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::model::{ColumnRole, Context, PerkHash};

/// Weights and thresholds for turning a copy into a score and a verdict.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScoringRules {
    /// Version of the game-rules file these values come from.
    pub ruleset: String,
    /// Share of the score from perk quality (weighted by column role).
    pub w_perks: f64,
    /// Share of the score from matching the best curated roll.
    pub w_roll: f64,
    /// Share of the score from gear tier.
    pub w_tier: f64,
    /// Share of the score from masterwork.
    pub w_masterwork: f64,
    /// Share of the score from enhanced perks.
    pub w_enhanced: f64,
    pub barrel_weight: f64,
    pub magazine_weight: f64,
    pub trait_weight: f64,
    /// Rating used for a perk nobody has rated yet. Lowers confidence.
    pub unknown_perk_rating: f64,
    /// A trait at or above this rating counts as a "top" perk.
    pub top_perk_rating: f64,
    /// Best copy at or above this score is KEEP.
    pub keep_at: f64,
    /// Best copy below this score is SHARD.
    pub shard_below: f64,
    /// A copy this many points or more behind the best copy is a duplicate to shard.
    pub duplicate_margin: f64,
}

impl Default for ScoringRules {
    fn default() -> Self {
        Self {
            ruleset: "dev-0".into(),
            w_perks: 0.55,
            w_roll: 0.25,
            w_tier: 0.12,
            w_masterwork: 0.04,
            w_enhanced: 0.04,
            barrel_weight: 0.2,
            magazine_weight: 0.2,
            trait_weight: 0.3,
            unknown_perk_rating: 0.5,
            top_perk_rating: 0.85,
            keep_at: 75.0,
            shard_below: 45.0,
            duplicate_margin: 5.0,
        }
    }
}

impl ScoringRules {
    pub fn column_weight(&self, role: ColumnRole) -> f64 {
        match role {
            ColumnRole::Barrel => self.barrel_weight,
            ColumnRole::Magazine => self.magazine_weight,
            ColumnRole::Trait => self.trait_weight,
        }
    }
}

/// How good each perk is in each context, from 0.0 (bad) to 1.0 (best in slot).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PerkRatings {
    ratings: HashMap<(Context, PerkHash), f64>,
}

impl PerkRatings {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets a rating, clamped to 0.0 to 1.0.
    pub fn set(&mut self, context: Context, perk: PerkHash, rating: f64) {
        self.ratings.insert((context, perk), rating.clamp(0.0, 1.0));
    }

    pub fn get(&self, context: Context, perk: PerkHash) -> Option<f64> {
        self.ratings.get(&(context, perk)).copied()
    }

    pub fn iter(&self) -> impl Iterator<Item = (Context, PerkHash, f64)> + '_ {
        self.ratings.iter().map(|(&(c, p), &r)| (c, p, r))
    }

    pub fn len(&self) -> usize {
        self.ratings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ratings.is_empty()
    }
}
