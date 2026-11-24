//! ParaForge core: the data model, the local database and the scoring engine.
//!
//! This crate has no UI and makes no network calls, so it builds and tests on any OS.
//! The Tauri app and (later) the Bungie sync sit on top of it.

pub mod db;
pub mod model;
pub mod rules;
pub mod score;

pub use db::{Database, DbError};
pub use model::*;
pub use rules::{PerkRatings, ScoringRules};
pub use score::{CopyScore, MissingPiece, Reason, RollMatch, ScoreError, VaultScores, Verdict, score_vault};

/// Version of this crate, shown in the app's About box.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
