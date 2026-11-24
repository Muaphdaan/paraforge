//! Fixed sample vault with expected verdicts. If a rules change flips a verdict, this fails.
//!
//! The six weapons mirror the approved Vault mockup. Hashes are made up.

use std::collections::HashMap;

use paraforge_core::*;

const BARREL_GOOD: u32 = 100;
const BARREL_OK: u32 = 101;
const MAG_GOOD: u32 = 200;
const MAG_OK: u32 = 201;
const TRAIT_TOP_A: u32 = 300;
const TRAIT_TOP_B: u32 = 301;
const TRAIT_MID: u32 = 302;
const TRAIT_BAD: u32 = 303;
const TRAIT_UNRATED: u32 = 399;

fn ratings() -> PerkRatings {
    let mut r = PerkRatings::new();
    for (perk, pve) in [
        (BARREL_GOOD, 0.9),
        (BARREL_OK, 0.6),
        (MAG_GOOD, 0.9),
        (MAG_OK, 0.6),
        (TRAIT_TOP_A, 0.95),
        (TRAIT_TOP_B, 0.9),
        (TRAIT_MID, 0.6),
        (TRAIT_BAD, 0.2),
    ] {
        r.set(Context::Pve, PerkHash(perk), pve);
    }
    r
}

fn def(hash: u32, name: &str, type_name: &str) -> WeaponDef {
    use ColumnRole::*;
    WeaponDef {
        hash: WeaponHash(hash),
        name: name.into(),
        type_name: type_name.into(),
        columns: vec![Barrel, Magazine, Trait, Trait],
        socket_indexes: vec![1, 2, 3, 4],
        look: Default::default(),
    }
}

fn roll(hash: u32) -> CuratedRoll {
    CuratedRoll {
        weapon: WeaponHash(hash),
        context: Context::Pve,
        columns: vec![
            vec![PerkHash(BARREL_GOOD)],
            vec![PerkHash(MAG_GOOD)],
            vec![PerkHash(TRAIT_TOP_A)],
            vec![PerkHash(TRAIT_TOP_B)],
        ],
        curator: "test".into(),
    }
}

fn col(perk: u32, enhanced: bool) -> CopyColumn {
    CopyColumn { options: vec![PerkHash(perk)], enhanced }
}

fn copy(id: &str, weapon: u32, tier: u8, perks: [u32; 4], enhanced: [bool; 4], masterworked: bool) -> WeaponCopy {
    WeaponCopy {
        instance_id: id.into(),
        weapon: WeaponHash(weapon),
        tier: Tier::new(tier).unwrap(),
        columns: perks.iter().zip(enhanced).map(|(p, e)| col(*p, e)).collect(),
        masterworked,
        locked: false,
    }
}

struct Fixture {
    defs: HashMap<WeaponHash, WeaponDef>,
    rolls: Vec<CuratedRoll>,
}

fn fixture() -> Fixture {
    let defs = [
        def(1, "Static Verdict", "Hand Cannon"),
        def(2, "Glass Orchard", "Auto Rifle"),
        def(3, "Iron Cantor", "Pulse Rifle"),
        def(4, "Night Ledger", "Sniper Rifle"),
        def(5, "Paper Comet", "Submachine Gun"),
        def(6, "Quiet Engine", "Rocket Launcher"),
    ];
    let rolls = defs.iter().map(|d| roll(d.hash.0)).collect();
    Fixture { defs: defs.into_iter().map(|d| (d.hash, d)).collect(), rolls }
}

fn vault() -> Vec<WeaponCopy> {
    const E: [bool; 4] = [false; 4];
    vec![
        // Static Verdict: god roll, enhanced barrel and magazine, plus two weaker copies.
        copy("sv-1", 1, 4, [BARREL_GOOD, MAG_GOOD, TRAIT_TOP_A, TRAIT_TOP_B], [true, true, false, false], true),
        copy("sv-2", 1, 3, [BARREL_OK, MAG_OK, TRAIT_TOP_A, TRAIT_MID], E, false),
        copy("sv-3", 1, 2, [BARREL_OK, MAG_OK, TRAIT_MID, TRAIT_BAD], E, false),
        // Glass Orchard: 3 of 4, not masterworked: upgrade.
        copy("go-1", 2, 3, [BARREL_GOOD, MAG_GOOD, TRAIT_TOP_A, TRAIT_MID], E, false),
        // Iron Cantor: 2 of 4, low tier: replace.
        copy("ic-1", 3, 2, [BARREL_GOOD, MAG_OK, TRAIT_TOP_A, TRAIT_BAD], E, false),
        // Night Ledger: tier 5 god roll.
        copy("nl-1", 4, 5, [BARREL_GOOD, MAG_GOOD, TRAIT_TOP_A, TRAIT_TOP_B], E, true),
        // Paper Comet: 1 of 4, tier 1: shard.
        copy("pc-1", 5, 1, [BARREL_GOOD, MAG_OK, TRAIT_MID, TRAIT_BAD], E, false),
        // Quiet Engine: 3 of 4, masterworked with an enhanced magazine: keep.
        copy("qe-1", 6, 3, [BARREL_GOOD, MAG_GOOD, TRAIT_TOP_A, TRAIT_MID], [false, true, false, false], true),
    ]
}

fn scored() -> HashMap<String, CopyScore> {
    let f = fixture();
    let out = score_vault(&f.defs, &vault(), Context::Pve, &ratings(), &f.rolls, &ScoringRules::default());
    assert!(out.skipped.is_empty(), "skipped: {:?}", out.skipped);
    out.scores.into_iter().map(|s| (s.instance_id.clone(), s)).collect()
}

#[test]
fn verdicts_match_expectations() {
    let s = scored();
    let expected = [
        ("sv-1", Verdict::Keep, 4),
        ("sv-2", Verdict::Shard, 1),
        ("sv-3", Verdict::Shard, 0),
        ("go-1", Verdict::Upgrade, 3),
        ("ic-1", Verdict::Replace, 2),
        ("nl-1", Verdict::Keep, 4),
        ("pc-1", Verdict::Shard, 1),
        ("qe-1", Verdict::Keep, 3),
    ];
    for (id, verdict, matched) in expected {
        let c = &s[id];
        assert_eq!(c.verdict, verdict, "{id}: score {} potential {} {:?}", c.score, c.potential, c.reasons);
        assert_eq!(c.god_roll, Some(RollMatch { matched, total: 4 }), "{id}");
    }
}

#[test]
fn scores_are_ordered_sensibly() {
    let s = scored();
    assert!(s["nl-1"].score > s["sv-1"].score, "tier 5 god roll beats tier 4");
    assert!(s["sv-1"].score > s["qe-1"].score);
    assert!(s["qe-1"].score > s["go-1"].score, "masterwork matters");
    assert!(s["go-1"].score > s["ic-1"].score);
    assert!(s["ic-1"].score > s["pc-1"].score);
    for c in s.values() {
        assert!((0.0..=100.0).contains(&c.score));
        assert!(c.potential >= c.score);
    }
}

#[test]
fn reasons_read_like_the_mockup() {
    let s = scored();
    let texts: Vec<String> = s["sv-1"].reasons.iter().map(|r| r.text(Context::Pve)).collect();
    assert!(texts.contains(&"Has both top PvE perks".to_string()), "{texts:?}");
    assert!(texts.contains(&"Best of your 3 copies".to_string()), "{texts:?}");
    assert!(texts.contains(&"Enhanced barrel and magazine".to_string()), "{texts:?}");
    assert!(
        s["sv-2"]
            .reasons
            .iter()
            .any(|r| matches!(r, Reason::BetterCopyOwned { instance_id, .. } if instance_id == "sv-1"))
    );
}

#[test]
fn missing_pieces_point_at_the_chase_roll() {
    let s = scored();
    let go = &s["go-1"];
    assert_eq!(go.missing.len(), 1, "1 perk away");
    assert_eq!(go.missing[0].column, 3);
    assert_eq!(go.missing[0].wanted, vec![PerkHash(TRAIT_TOP_B)]);
}

#[test]
fn selectable_perks_count_and_unrated_perks_lower_confidence() {
    let f = fixture();
    let mut c = copy("x", 2, 3, [BARREL_GOOD, MAG_GOOD, TRAIT_TOP_A, TRAIT_UNRATED], [false; 4], false);
    let base =
        score_vault(&f.defs, std::slice::from_ref(&c), Context::Pve, &ratings(), &f.rolls, &ScoringRules::default());
    assert!(base.scores[0].confidence < 1.0);

    c.columns[3].options.push(PerkHash(TRAIT_TOP_B));
    let picked =
        score_vault(&f.defs, std::slice::from_ref(&c), Context::Pve, &ratings(), &f.rolls, &ScoringRules::default());
    let p = &picked.scores[0];
    assert_eq!(p.confidence, 1.0);
    assert_eq!(p.god_roll, Some(RollMatch { matched: 4, total: 4 }));
    assert!(p.score > base.scores[0].score);
}

#[test]
fn no_curated_roll_is_neutral_not_fatal() {
    let f = fixture();
    let c = copy("x", 2, 3, [BARREL_GOOD, MAG_GOOD, TRAIT_TOP_A, TRAIT_TOP_B], [false; 4], false);
    let out = score_vault(&f.defs, &[c], Context::Pve, &ratings(), &[], &ScoringRules::default());
    let s = &out.scores[0];
    assert_eq!(s.god_roll, None);
    assert!(s.reasons.contains(&Reason::NoCuratedRoll));
    assert!(s.confidence < 1.0);
}

#[test]
fn bad_copies_are_skipped_not_fatal() {
    let f = fixture();
    let mut short = copy("short", 1, 3, [BARREL_GOOD, MAG_GOOD, TRAIT_TOP_A, TRAIT_TOP_B], [false; 4], false);
    short.columns.pop();
    let unknown = copy("unknown", 999, 3, [BARREL_GOOD, MAG_GOOD, TRAIT_TOP_A, TRAIT_TOP_B], [false; 4], false);
    let good = copy("good", 1, 3, [BARREL_GOOD, MAG_GOOD, TRAIT_TOP_A, TRAIT_TOP_B], [false; 4], false);
    let out =
        score_vault(&f.defs, &[short, unknown, good], Context::Pve, &ratings(), &f.rolls, &ScoringRules::default());
    assert_eq!(out.scores.len(), 1);
    assert_eq!(out.skipped.len(), 2);
    assert_eq!(out.skipped[0].1, ScoreError::ColumnMismatch { copy: 3, weapon: 4 });
    assert_eq!(out.skipped[1].1, ScoreError::UnknownWeapon(WeaponHash(999)));
}

#[test]
fn database_round_trip() {
    let f = fixture();
    let mut db = Database::open_in_memory().unwrap();
    assert_eq!(db.schema_version().unwrap(), 3);

    let mut defs: Vec<WeaponDef> = f.defs.values().cloned().collect();
    defs[0].look = WeaponLook {
        icon: "/common/destiny2_content/icons/a.jpg".into(),
        slot: 2,
        damage: 3,
        ammo: 1,
        rarity: 5,
        ..Default::default()
    };
    db.upsert_weapons(&defs).unwrap();
    let expected: HashMap<WeaponHash, WeaponDef> = defs.iter().map(|d| (d.hash, d.clone())).collect();
    assert_eq!(db.weapons().unwrap(), expected);
    assert_eq!(db.search_weapons("static", 10).unwrap(), vec![WeaponHash(1)]);
    assert_eq!(db.search_weapons("sniper", 10).unwrap(), vec![WeaponHash(4)]);
    assert!(db.search_weapons("  ", 10).unwrap().is_empty());

    let prov =
        Provenance { source: "test".into(), version: "1".into(), license: "MIT".into(), fetched: "2026-11-24".into() };
    db.upsert_source("test", &prov).unwrap();
    db.replace_ratings(&ratings(), "test").unwrap();
    db.replace_rolls(&f.rolls, "test").unwrap();
    let mut v = vault();
    db.replace_copies(&v, "2026-11-24T21:00:00Z").unwrap();

    let mut loaded = db.copies().unwrap();
    v.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
    loaded.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
    assert_eq!(loaded, v);
    assert_eq!(db.ratings().unwrap(), ratings());
    assert_eq!(db.rolls().unwrap(), f.rolls);

    let out = score_vault(
        &db.weapons().unwrap(),
        &loaded,
        Context::Pve,
        &db.ratings().unwrap(),
        &db.rolls().unwrap(),
        &ScoringRules::default(),
    );
    db.save_scores(Context::Pve, &out.scores).unwrap();
    let stored = db.scores(Context::Pve).unwrap();
    assert_eq!(stored.len(), 8);
    assert_eq!(stored[0].instance_id, "nl-1", "highest score first");

    // A changed copy loses its stale score; an unchanged one keeps it.
    let mut changed = v.clone();
    changed.iter_mut().find(|c| c.instance_id == "go-1").unwrap().masterworked = true;
    db.replace_copies(&changed, "2026-11-24T21:01:00Z").unwrap();
    let ids: Vec<String> = db.scores(Context::Pve).unwrap().into_iter().map(|s| s.instance_id).collect();
    assert!(!ids.contains(&"go-1".to_string()));
    assert!(ids.contains(&"nl-1".to_string()));

    // Saving a pass replaces the context's scores: a copy skipped this time keeps no old verdict.
    db.save_scores(Context::Pve, &out.scores[..2]).unwrap();
    assert_eq!(db.scores(Context::Pve).unwrap().len(), 2);
    db.save_scores(Context::Pve, &out.scores).unwrap();

    // A new sync without sv-3 drops the copy and its score.
    v.retain(|c| c.instance_id != "sv-3");
    db.replace_copies(&v, "2026-11-24T21:02:00Z").unwrap();
    assert_eq!(db.copies().unwrap().len(), 7);
    assert!(db.scores(Context::Pve).unwrap().iter().all(|s| s.instance_id != "sv-3"));

    let rows = db.vault_rows(Context::Pve).unwrap();
    assert_eq!(rows.len(), 7);
    assert_eq!(rows[0].name, "Night Ledger");
    assert_eq!(rows[0].score.as_ref().unwrap().verdict, Verdict::Keep);

    let perks = [PerkInfo {
        hash: PerkHash(BARREL_GOOD),
        name: "Arrowhead Brake".into(),
        plug_category: "barrels".into(),
        icon: "/common/destiny2_content/icons/brake.png".into(),
        description: "Lightly vented barrel.".into(),
    }];
    db.replace_definitions(&defs, &perks).unwrap();
    assert_eq!(db.perk_names().unwrap()[&PerkHash(BARREL_GOOD)], "Arrowhead Brake");
    assert_eq!(db.perks().unwrap(), perks.to_vec());
    assert_eq!(db.weapons().unwrap(), expected);

    // An untiered (legacy) copy is stored and scored at the bottom of the tier range.
    let mut legacy = v.clone();
    legacy[0].tier = Tier::new(0).unwrap();
    db.replace_copies(&legacy, "2026-11-24T21:03:00Z").unwrap();
    assert_eq!(db.copies().unwrap().iter().filter(|c| c.tier.get() == 0).count(), 1);

    db.set_meta("data_pack", "dev").unwrap();
    assert_eq!(db.meta("data_pack").unwrap().as_deref(), Some("dev"));
}

#[test]
fn reopening_a_file_keeps_data() {
    let dir = std::env::temp_dir().join(format!("paraforge-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("pf.sqlite");
    {
        let db = Database::open(&path).unwrap();
        db.set_meta("k", "v").unwrap();
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(db.schema_version().unwrap(), 3);
    assert_eq!(db.meta("k").unwrap().as_deref(), Some("v"));
    drop(db);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_worse_copy_that_can_catch_up_is_not_sharded() {
    // Same weapon and tier, no curated roll. A is upgraded but has weaker perks; B has better
    // perks but is not upgraded yet, so it scores lower today and higher once upgraded.
    let f = fixture();
    let mut r = PerkRatings::new();
    for (perk, v) in
        [(BARREL_OK, 0.8), (MAG_OK, 0.8), (TRAIT_MID, 0.8), (BARREL_GOOD, 0.81), (MAG_GOOD, 0.81), (TRAIT_TOP_A, 0.81)]
    {
        r.set(Context::Pve, PerkHash(perk), v);
    }
    let a = copy("a", 2, 3, [BARREL_OK, MAG_OK, TRAIT_MID, TRAIT_MID], [true; 4], true);
    let b = copy("b", 2, 3, [BARREL_GOOD, MAG_GOOD, TRAIT_TOP_A, TRAIT_TOP_A], [false; 4], false);
    let out = score_vault(&f.defs, &[a, b], Context::Pve, &r, &[], &ScoringRules::default());
    let (sa, sb) = (&out.scores[0], &out.scores[1]);
    assert!(sa.score > sb.score && sb.potential > sa.score, "a {} b {}..{}", sa.score, sb.score, sb.potential);
    assert_ne!(sb.verdict, Verdict::Shard, "{:?}", sb.reasons);
}

#[test]
fn empty_columns_lower_confidence() {
    let f = fixture();
    let mut c = copy("x", 2, 3, [BARREL_GOOD, MAG_GOOD, TRAIT_TOP_A, TRAIT_TOP_B], [false; 4], false);
    for col in &mut c.columns {
        col.options.clear();
    }
    let out = score_vault(&f.defs, &[c], Context::Pve, &ratings(), &f.rolls, &ScoringRules::default());
    assert_eq!(out.scores[0].confidence, 0.0);
}
