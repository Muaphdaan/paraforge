//! The scoring engine: rates each owned copy for a context and gives it a verdict.
//!
//! Pure functions over plain data, so the same inputs always give the same verdicts.
//! Perk hashes on copies are expected to be base (non-enhanced) hashes, with
//! enhancement carried by [`CopyColumn::enhanced`]; the sync layer normalises this.

use std::cmp::Ordering;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::model::{ColumnRole, Context, CopyColumn, CuratedRoll, PerkHash, WeaponCopy, WeaponDef, WeaponHash};
use crate::rules::{PerkRatings, ScoringRules};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// A good copy: keep it.
    Keep,
    /// Good perks; masterwork and enhanced perks would make it a keeper.
    Upgrade,
    /// Usable for now, but worth farming a better copy.
    Replace,
    /// Not worth the space.
    Shard,
}

impl Verdict {
    pub fn label(self) -> &'static str {
        match self {
            Verdict::Keep => "KEEP",
            Verdict::Upgrade => "UPGRADE",
            Verdict::Replace => "REPLACE",
            Verdict::Shard => "SHARD",
        }
    }
}

/// How many columns of the best curated roll a copy matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RollMatch {
    pub matched: u8,
    pub total: u8,
}

/// A column where the copy lacks a perk from the best curated roll.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissingPiece {
    pub column: usize,
    pub role: ColumnRole,
    pub wanted: Vec<PerkHash>,
}

/// A reason behind a score, kept structured so the interface can word it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reason {
    TopTraits { count: usize, of: usize },
    Enhanced { roles: Vec<ColumnRole> },
    RollMatch { matched: u8, total: u8 },
    NoCuratedRoll,
    BestOfCopies { copies: usize },
    BetterCopyOwned { instance_id: String, score: f64 },
    UpgradePotential { potential: f64 },
}

impl Reason {
    /// Plain English wording, matching the approved mockups.
    pub fn text(&self, context: Context) -> String {
        let ctx = match context {
            Context::Pve => "PvE",
            Context::Pvp => "PvP",
        };
        match self {
            Reason::TopTraits { count, of } if count == of && *of == 2 => format!("Has both top {ctx} perks"),
            Reason::TopTraits { count, of } if count == of => format!("Has all top {ctx} perks"),
            Reason::TopTraits { count: 1, .. } => format!("Has a top {ctx} perk"),
            Reason::TopTraits { count, of } => format!("Has {count} of {of} top {ctx} perks"),
            Reason::Enhanced { roles } => format!("Enhanced {}", join_roles(roles)),
            Reason::RollMatch { matched, total } => format!("Matches the curated roll in {matched} of {total} columns"),
            Reason::NoCuratedRoll => "No curated roll yet, scored on perk ratings only".into(),
            Reason::BestOfCopies { copies } => format!("Best of your {copies} copies"),
            Reason::BetterCopyOwned { score, .. } => format!("You own a better copy ({score:.0})"),
            Reason::UpgradePotential { potential } => {
                format!("Masterwork and enhanced perks would take it to {potential:.0}")
            }
        }
    }
}

fn join_roles(roles: &[ColumnRole]) -> String {
    let mut names: Vec<&str> = Vec::new();
    for role in roles {
        let name = match role {
            ColumnRole::Barrel => "barrel",
            ColumnRole::Magazine => "magazine",
            ColumnRole::Trait => "traits",
        };
        if !names.contains(&name) {
            names.push(name);
        }
    }
    match names.as_slice() {
        [] => String::new(),
        [one] => (*one).to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The result for one copy in one context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CopyScore {
    pub instance_id: String,
    pub weapon: WeaponHash,
    pub context: Context,
    /// 0 to 100, one decimal.
    pub score: f64,
    /// The score this copy would reach fully masterworked with every perk enhanced.
    pub potential: f64,
    /// 0.0 to 1.0: how much of the score rests on rated perks and a curated roll.
    pub confidence: f64,
    pub verdict: Verdict,
    pub god_roll: Option<RollMatch>,
    pub reasons: Vec<Reason>,
    pub missing: Vec<MissingPiece>,
    pub ruleset: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
pub enum ScoreError {
    #[error("weapon {0:?} is not in the manifest")]
    UnknownWeapon(WeaponHash),
    #[error("copy has {copy} perk columns but the weapon has {weapon}")]
    ColumnMismatch { copy: usize, weapon: usize },
    #[error("weapon has no perk columns to score")]
    NoColumns,
}

/// Everything about a copy that does not depend on the player's other copies.
#[derive(Debug, Clone, PartialEq)]
struct Analysis {
    score: f64,
    potential: f64,
    confidence: f64,
    god_roll: Option<RollMatch>,
    reasons: Vec<Reason>,
    missing: Vec<MissingPiece>,
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn column_quality(column: &CopyColumn, context: Context, ratings: &PerkRatings, rules: &ScoringRules) -> (f64, bool) {
    if column.options.is_empty() {
        // No perk data for this column: score it as nothing, and do not count it as known.
        return (0.0, false);
    }
    // The player can pick any option, so the column is as good as its best option.
    // The column counts as known when that best option is rated (rated wins ties).
    let mut best = f64::NEG_INFINITY;
    let mut known = false;
    for perk in &column.options {
        let (rating, rated) = match ratings.get(context, *perk) {
            Some(r) => (r, true),
            None => (rules.unknown_perk_rating, false),
        };
        if rating > best || (rating == best && rated) {
            best = rating;
            known = rated;
        }
    }
    (best, known)
}

fn best_roll_match<'a>(
    def: &WeaponDef,
    copy: &WeaponCopy,
    context: Context,
    rolls: impl Iterator<Item = &'a CuratedRoll>,
) -> Option<(RollMatch, Vec<MissingPiece>)> {
    let total = def.columns.len();
    let mut best: Option<(RollMatch, Vec<MissingPiece>)> = None;
    for roll in rolls.filter(|r| r.weapon == def.hash && r.context == context && r.columns.len() == total) {
        let mut missing = Vec::new();
        for (index, (wanted, have)) in roll.columns.iter().zip(&copy.columns).enumerate() {
            let ok = wanted.is_empty() || have.options.iter().any(|p| wanted.contains(p));
            if !ok {
                missing.push(MissingPiece { column: index, role: def.columns[index], wanted: wanted.clone() });
            }
        }
        let matched = (total - missing.len()) as u8;
        let candidate = (RollMatch { matched, total: total as u8 }, missing);
        if best.as_ref().is_none_or(|(b, _)| matched > b.matched) {
            best = Some(candidate);
        }
    }
    best
}

fn analyse<'a>(
    def: &WeaponDef,
    copy: &WeaponCopy,
    context: Context,
    ratings: &PerkRatings,
    rolls: impl Iterator<Item = &'a CuratedRoll>,
    rules: &ScoringRules,
) -> Result<Analysis, ScoreError> {
    if def.columns.is_empty() {
        return Err(ScoreError::NoColumns);
    }
    if copy.columns.len() != def.columns.len() {
        return Err(ScoreError::ColumnMismatch { copy: copy.columns.len(), weapon: def.columns.len() });
    }

    let mut weighted = 0.0;
    let mut weight_sum = 0.0;
    let mut known_columns = 0usize;
    let mut traits = 0usize;
    let mut top_traits = 0usize;
    let mut enhanced_roles = Vec::new();
    for (role, column) in def.columns.iter().zip(&copy.columns) {
        let (quality, known) = column_quality(column, context, ratings, rules);
        let w = rules.column_weight(*role);
        weighted += w * quality;
        weight_sum += w;
        if known {
            known_columns += 1;
        }
        if *role == ColumnRole::Trait {
            traits += 1;
            if known && quality >= rules.top_perk_rating {
                top_traits += 1;
            }
        }
        if column.enhanced {
            enhanced_roles.push(*role);
        }
    }
    let n = def.columns.len() as f64;
    let perk_quality = if weight_sum > 0.0 { weighted / weight_sum } else { 0.0 };

    let roll = best_roll_match(def, copy, context, rolls);
    let roll_fraction = match &roll {
        Some((m, _)) => f64::from(m.matched) / f64::from(m.total),
        // No curated roll: stay neutral rather than punish the copy.
        None => perk_quality,
    };
    let tier_factor = f64::from(copy.tier.get() - 1) / f64::from(crate::model::Tier::MAX - 1);
    let enhanced_fraction = enhanced_roles.len() as f64 / n;

    let total_w = rules.w_perks + rules.w_roll + rules.w_tier + rules.w_masterwork + rules.w_enhanced;
    let compose = |masterwork: f64, enhanced: f64| {
        let raw = rules.w_perks * perk_quality
            + rules.w_roll * roll_fraction
            + rules.w_tier * tier_factor
            + rules.w_masterwork * masterwork
            + rules.w_enhanced * enhanced;
        round1(100.0 * raw / total_w)
    };
    let score = compose(if copy.masterworked { 1.0 } else { 0.0 }, enhanced_fraction);
    let potential = compose(1.0, 1.0);

    let confidence = round2((known_columns as f64 / n) * if roll.is_some() { 1.0 } else { 0.7 });

    let mut reasons = Vec::new();
    if top_traits > 0 {
        reasons.push(Reason::TopTraits { count: top_traits, of: traits });
    }
    if !enhanced_roles.is_empty() {
        reasons.push(Reason::Enhanced { roles: enhanced_roles });
    }
    let (god_roll, missing) = match roll {
        Some((m, missing)) => {
            reasons.push(Reason::RollMatch { matched: m.matched, total: m.total });
            (Some(m), missing)
        }
        None => {
            reasons.push(Reason::NoCuratedRoll);
            (None, Vec::new())
        }
    };

    Ok(Analysis { score, potential, confidence, god_roll, reasons, missing })
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn standalone_verdict(a: &Analysis, rules: &ScoringRules) -> Verdict {
    if a.score >= rules.keep_at {
        Verdict::Keep
    } else if a.potential >= rules.keep_at {
        Verdict::Upgrade
    } else if a.score >= rules.shard_below {
        Verdict::Replace
    } else {
        Verdict::Shard
    }
}

/// Scores of a whole vault, plus copies that could not be scored and why.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VaultScores {
    pub scores: Vec<CopyScore>,
    pub skipped: Vec<(String, ScoreError)>,
}

/// Scores every copy for one context and assigns verdicts, comparing copies of the same weapon.
///
/// Output order follows the input order of `copies`.
pub fn score_vault(
    defs: &HashMap<WeaponHash, WeaponDef>,
    copies: &[WeaponCopy],
    context: Context,
    ratings: &PerkRatings,
    rolls: &[CuratedRoll],
    rules: &ScoringRules,
) -> VaultScores {
    let mut out = VaultScores::default();
    // (index into copies, analysis), grouped by weapon.
    let mut groups: HashMap<WeaponHash, Vec<(usize, Analysis)>> = HashMap::new();
    for (index, copy) in copies.iter().enumerate() {
        let Some(def) = defs.get(&copy.weapon) else {
            out.skipped.push((copy.instance_id.clone(), ScoreError::UnknownWeapon(copy.weapon)));
            continue;
        };
        match analyse(def, copy, context, ratings, rolls.iter(), rules) {
            Ok(a) => groups.entry(copy.weapon).or_default().push((index, a)),
            Err(e) => out.skipped.push((copy.instance_id.clone(), e)),
        }
    }

    let mut results: Vec<(usize, CopyScore)> = Vec::new();
    for (_, mut group) in groups {
        group.sort_by(|(ia, a), (ib, b)| rank(&copies[*ia], a, &copies[*ib], b));
        let count = group.len();
        let (best_index, best_score) = (group[0].0, group[0].1.score);
        for (position, (index, mut a)) in group.into_iter().enumerate() {
            let copy = &copies[index];
            // A worse copy is a duplicate to shard only if even fully upgraded it stays clearly
            // behind the best copy; otherwise it is judged on its own (it may be worth upgrading).
            let verdict = if position > 0 && best_score - a.potential >= rules.duplicate_margin {
                a.reasons.push(Reason::BetterCopyOwned {
                    instance_id: copies[best_index].instance_id.clone(),
                    score: best_score,
                });
                Verdict::Shard
            } else {
                if position == 0 && count > 1 {
                    a.reasons.push(Reason::BestOfCopies { copies: count });
                }
                let v = standalone_verdict(&a, rules);
                if v == Verdict::Upgrade {
                    a.reasons.push(Reason::UpgradePotential { potential: a.potential });
                }
                v
            };
            results.push((
                index,
                CopyScore {
                    instance_id: copy.instance_id.clone(),
                    weapon: copy.weapon,
                    context,
                    score: a.score,
                    potential: a.potential,
                    confidence: a.confidence,
                    verdict,
                    god_roll: a.god_roll,
                    reasons: a.reasons,
                    missing: a.missing,
                    ruleset: rules.ruleset.clone(),
                },
            ));
        }
    }
    results.sort_by_key(|(index, _)| *index);
    out.scores = results.into_iter().map(|(_, s)| s).collect();
    out
}

/// Best first: higher score, then higher tier, then masterworked, then instance id for a stable order.
fn rank(ca: &WeaponCopy, a: &Analysis, cb: &WeaponCopy, b: &Analysis) -> Ordering {
    b.score
        .total_cmp(&a.score)
        .then(cb.tier.cmp(&ca.tier))
        .then(cb.masterworked.cmp(&ca.masterworked))
        .then(ca.instance_id.cmp(&cb.instance_id))
}
