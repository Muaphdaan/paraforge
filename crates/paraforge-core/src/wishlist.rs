//! Reads DIM-format wish lists (such as the community "voltron" list, MIT) into curated rolls.
//!
//! A wish list is plain text: `title:` lines start a section, `//` comment lines name the roll,
//! a `//notes:` line explains it (ending in `|tags:pve,mkb...`), and each
//! `dimwishlist:item=<weapon>&perks=<perk>,<perk>...` line lists one accepted perk combination.
//! Consecutive lines with the same notes form one roll. Pure parsing, no I/O.

use std::collections::HashMap;

use crate::model::{Context, CuratedRoll, PerkHash, WeaponDef, WeaponHash};

/// One roll as written in the list, before it is matched to weapon columns.
#[derive(Debug, Clone, PartialEq)]
pub struct WishBlock {
    /// The section title the roll sits under, for example "PvE Podcast 177 - The Best Trace Rifles".
    pub source: String,
    /// The roll's own name from the comment above it, for example "Action Item - PvE Minor god 1".
    pub title: String,
    /// The notes, including the trailing tags.
    pub notes: String,
    /// Weapon hash and perk hashes of each accepted combination.
    pub lines: Vec<(u32, Vec<u32>)>,
}

/// Splits a wish list into rolls. Trash entries (negative item hashes) and wildcard entries
/// (`item=-69420`, any weapon) are skipped: ParaForge shows rolls per weapon.
pub fn parse_blocks(text: &str) -> Vec<WishBlock> {
    let mut blocks = Vec::new();
    let mut source = String::new();
    let mut comments: Vec<String> = Vec::new();
    let mut notes: Option<String> = None;
    let mut open: Option<WishBlock> = None;
    let close = |open: &mut Option<WishBlock>, blocks: &mut Vec<WishBlock>| {
        if let Some(block) = open.take()
            && !block.lines.is_empty()
        {
            blocks.push(block);
        }
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            close(&mut open, &mut blocks);
            comments.clear();
            notes = None;
        } else if let Some(title) = line.strip_prefix("title:") {
            close(&mut open, &mut blocks);
            source = title.trim().to_string();
            comments.clear();
            notes = None;
        } else if line.starts_with("description:") {
            continue;
        } else if let Some(text) = line.strip_prefix("//notes:") {
            close(&mut open, &mut blocks);
            notes = Some(text.trim().to_string());
        } else if let Some(comment) = line.strip_prefix("//") {
            if open.is_some() {
                close(&mut open, &mut blocks);
                comments.clear();
                notes = None;
            }
            comments.push(comment.trim().to_string());
        } else if let Some(entry) = line.strip_prefix("dimwishlist:") {
            let (query, inline) = match entry.split_once("#notes:") {
                Some((q, n)) => (q, Some(n.trim().to_string())),
                None => (entry, None),
            };
            let Some((weapon, perks)) = parse_entry(query) else { continue };
            let line_notes = inline.or_else(|| notes.clone()).unwrap_or_default();
            if open.as_ref().is_some_and(|b| b.notes != line_notes) {
                close(&mut open, &mut blocks);
            }
            let block = open.get_or_insert_with(|| WishBlock {
                source: source.clone(),
                title: block_title(&comments),
                notes: line_notes,
                lines: Vec::new(),
            });
            block.lines.push((weapon, perks));
        }
    }
    close(&mut open, &mut blocks);
    blocks
}

/// `item=123&perks=1,2,3` into the weapon hash and perks; `None` for trash and wildcard entries.
fn parse_entry(query: &str) -> Option<(u32, Vec<u32>)> {
    let mut weapon = None;
    let mut perks = Vec::new();
    for pair in query.trim().split('&') {
        let (key, value) = pair.split_once('=')?;
        match key.trim() {
            "item" => weapon = value.trim().parse::<i64>().ok().filter(|h| *h > 0).and_then(|h| u32::try_from(h).ok()),
            "perks" => perks = value.split(',').filter_map(|p| p.trim().parse::<u32>().ok()).collect(),
            _ => {}
        }
    }
    Some((weapon?, perks))
}

/// The roll's name: the first comment that is not a list of perk names or a link.
fn block_title(comments: &[String]) -> String {
    comments
        .iter()
        .find(|c| !c.is_empty() && !c.starts_with('(') && !c.contains("http") && !c.starts_with("taken from"))
        .cloned()
        .unwrap_or_default()
}

/// Notes split from their tags, with tags lowercased and spelled one way.
fn split_tags(notes: &str) -> (String, Vec<String>) {
    let lower = notes.to_ascii_lowercase();
    let Some(at) = lower.rfind("tags:") else { return (notes.trim().to_string(), Vec::new()) };
    let text = notes[..at].trim().trim_end_matches('|').trim().to_string();
    let mut tags: Vec<String> = Vec::new();
    for raw in lower[at + 5..].split([',', ' ', '|']) {
        let tag = match raw.trim() {
            "" => continue,
            "m+kb" => "mkb",
            "pve-god" => "god-pve",
            "pvp-god" => "god-pvp",
            other => other,
        }
        .to_string();
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    (text, tags)
}

/// The text after a marker such as "Recommended MW", up to the end of its phrase.
fn after_marker(notes: &str, marker: &str) -> String {
    let lower = notes.to_ascii_lowercase();
    let Some(at) = lower.find(&marker.to_ascii_lowercase()) else { return String::new() };
    let rest = notes[at + marker.len()..].trim_start_matches(|c: char| c == ':' || c == '-' || c.is_whitespace());
    let end = rest.find(['.', '|', ',', ';', '(']).unwrap_or(rest.len());
    let mut pick = rest[..end].trim();
    for stop in [" with your", " tags:", " and "] {
        if let Some(i) = pick.to_ascii_lowercase().find(stop) {
            pick = pick[..i].trim();
        }
    }
    pick.to_string()
}

/// The masterwork and the mod from a "Recommended MW: Handling, with a Backup Mag mod." phrase.
/// Curators give the mod inside the masterwork sentence; "your preferred choice of mod" names none.
fn masterwork_and_mod(notes: &str) -> (String, String) {
    let lower = notes.to_ascii_lowercase();
    let Some(at) = lower.find("recommended mw") else { return (String::new(), String::new()) };
    let rest =
        notes[at + "recommended mw".len()..].trim_start_matches(|c: char| c == ':' || c == '-' || c.is_whitespace());
    // The phrase ends at a full stop, a separator or a quoted remark.
    let end = rest.find(['.', '|', ';', '\u{201c}', '"']).unwrap_or(rest.len());
    let phrase = rest[..end].trim();
    let lower = phrase.to_ascii_lowercase();
    let (mw, modtext) = match lower.find(" with ") {
        Some(i) => (&phrase[..i], &phrase[i + " with ".len()..]),
        None => (phrase, ""),
    };
    let mut mw = mw.trim().trim_end_matches(',').trim();
    for stop in [" - ", " (", " tags:"] {
        if let Some(i) = mw.to_ascii_lowercase().find(stop) {
            mw = mw[..i].trim();
        }
    }
    let mw = mw.replace('/', " or ").replace("Handing", "Handling");
    // "Reload" is the Reload Speed masterwork.
    let mw = mw
        .split(" or ")
        .map(|part| if part.trim().eq_ignore_ascii_case("reload") { "Reload Speed" } else { part })
        .collect::<Vec<_>>()
        .join(" or ");

    let mut m = modtext.trim();
    let ml = m.to_ascii_lowercase();
    if ml.starts_with("your") {
        m = "";
    }
    for stop in [", or ", " or your", " or, ", " depending", ", and ", " for builds", " to boost"] {
        if let Some(i) = find_outside_brackets(m, stop) {
            m = m[..i].trim();
        }
    }
    let mut m = m.trim_end_matches(',').trim();
    for prefix in ["a ", "an ", "the "] {
        if m.len() > prefix.len() && m[..prefix.len()].eq_ignore_ascii_case(prefix) {
            m = &m[prefix.len()..];
        }
    }
    for suffix in [" mods", " mod"] {
        if m.to_ascii_lowercase().ends_with(suffix) {
            m = m[..m.len() - suffix.len()].trim();
        }
    }
    (capitalise(mw.trim()), capitalise(m))
}

/// Where `pat` first appears outside round brackets, ignoring case.
fn find_outside_brackets(text: &str, pat: &str) -> Option<usize> {
    let lower = text.to_ascii_lowercase();
    let mut depth = 0i32;
    for (i, c) in lower.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ if depth <= 0 && lower[i..].starts_with(pat) => return Some(i),
            _ => {}
        }
    }
    None
}

fn capitalise(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Who made the roll: "Constructed by @Name", a u/ or @ handle in the notes, else the section.
fn curator(notes: &str, source: &str) -> String {
    let handle = |text: &str| -> Option<String> {
        let start = text.find("by @").map(|i| i + 3).or_else(|| text.find("by u/").map(|i| i + 3))?;
        let name: String = text[start..].chars().take_while(|c| !c.is_whitespace() && !"():,'".contains(*c)).collect();
        // Shown as "by Name", one way whether the notes wrote @Name, u/Name or Name.
        let name = name.trim_start_matches('@').trim_start_matches("u/").to_string();
        (name.len() > 1).then_some(name)
    };
    // The lead-in before the first bracket names the curator: "Constructed by @Name (",
    // "pandapaxxy (", "Adamsdown_Boy written as at v9.5.6.2 (". A "by @" later in the notes
    // credits someone else, such as a tier list the curator cites.
    let head = notes.split_once(" (").map_or("", |(h, _)| h);
    let lead = || -> Option<String> {
        let name = head.trim();
        let name = name.split_once(" written as at ").map_or(name, |(n, _)| n.trim());
        (!name.is_empty() && name.len() <= 32 && !name.contains(' ')).then(|| name.to_string())
    };
    // A section named for its author: "Pandapaxxy's S15 roundup", "u/Mercules904's Massive Breakdown".
    let owner = || -> Option<String> {
        let (name, _) = source.split_once("'s ")?;
        let name = name.trim_start_matches("u/").trim_start_matches('@');
        (!name.is_empty() && !name.contains(' ')).then(|| name.to_string())
    };
    handle(head)
        .or_else(lead)
        .or_else(|| handle(notes))
        .or_else(|| handle(source))
        .or_else(owner)
        .unwrap_or_else(|| source.to_string())
}

/// The notes without their "Constructed by @Name (tags):" lead-in, which ParaForge shows separately.
fn readable_notes(text: &str) -> String {
    // "Constructed by @Name (tags): ...", "name (PvE / M+KB): ..." or "Name written as at v9 (PvE): ...".
    // Any other "(...):" is part of the advice ("Pair Rampage with Kill Clip (or Frenzy): ...").
    let Some((lead, after)) = text.split_once(" (") else { return text.to_string() };
    let name = lead.trim();
    let name = name.split_once(" written as at ").map_or(name, |(n, _)| n.trim());
    let is_lead_in = name.contains("by @")
        || name.contains("by u/")
        || (!name.is_empty() && name.len() <= 32 && !name.contains(' '));
    let Some(close) = after.find("):") else { return text.to_string() };
    if !is_lead_in || lead.len() + 2 + close > 120 || after[..close].contains('(') {
        return text.to_string();
    }
    let rest = after[close + 2..].trim();
    rest.strip_prefix('"').and_then(|r| r.strip_suffix('"')).unwrap_or(rest).trim().to_string()
}

fn contexts(tags: &[String], title: &str, source: &str) -> Vec<Context> {
    let pvp = tags.iter().any(|t| t.starts_with("pvp") || t == "god-pvp");
    let pve = tags.iter().any(|t| t.starts_with("pve") || t == "god-pve");
    match (pve, pvp) {
        (true, true) => vec![Context::Pve, Context::Pvp],
        (true, false) => vec![Context::Pve],
        (false, true) => vec![Context::Pvp],
        (false, false) => {
            let text = format!("{title} {source}").to_ascii_lowercase();
            match (text.contains("pve"), text.contains("pvp")) {
                (true, false) => vec![Context::Pve],
                (false, true) => vec![Context::Pvp],
                _ => vec![Context::Pve, Context::Pvp],
            }
        }
    }
}

/// The spec mods a PvE roll is tagged for (PvE-MinorSpec and so on), as mod names.
fn spec_mods(tags: &[String]) -> Vec<&'static str> {
    let mut out = Vec::new();
    for (tag, name) in [("pve-minorspec", "Minor Spec"), ("pve-majorspec", "Major Spec"), ("pve-bossspec", "Boss Spec")]
    {
        if tags.iter().any(|t| t == tag) {
            out.push(name);
        }
    }
    out
}

/// Turns wish-list rolls into curated rolls with one perk list per weapon column. Each listed perk
/// goes to the column whose pool holds it (`base` maps enhanced perks to their normal version);
/// a perk in no pool falls back to its position when the line lists one perk per column. Rolls for
/// weapons not in `defs`, or with no perk columns, are skipped.
pub fn curated_rolls(
    blocks: &[WishBlock],
    defs: &HashMap<WeaponHash, WeaponDef>,
    base: impl Fn(u32) -> u32,
) -> Vec<CuratedRoll> {
    let mut out = Vec::new();
    for block in blocks {
        let (text, tags) = split_tags(&block.notes);
        let (masterwork, mw_mod) = masterwork_and_mod(&text);
        let mut mods = after_marker(&text, "Recommended Mod");
        if mods.is_empty() {
            mods = mw_mod;
        }
        if mods.is_empty() {
            mods = spec_mods(&tags).join(" or ");
        }
        let who = curator(&text, &block.source);
        let notes = readable_notes(&text);
        let mut weapons: Vec<u32> = Vec::new();
        for (weapon, _) in &block.lines {
            if !weapons.contains(weapon) {
                weapons.push(*weapon);
            }
        }
        for weapon in weapons {
            let Some(def) = defs.get(&WeaponHash(weapon)) else { continue };
            if def.columns.is_empty() {
                continue;
            }
            let mut columns: Vec<Vec<PerkHash>> = vec![Vec::new(); def.columns.len()];
            for (_, perks) in block.lines.iter().filter(|(w, _)| *w == weapon) {
                let placed: Option<Vec<(usize, PerkHash)>> = perks
                    .iter()
                    .enumerate()
                    .map(|(position, perk)| {
                        let perk = PerkHash(base(*perk));
                        def.pools
                            .iter()
                            .position(|pool| pool.contains(&perk))
                            .or_else(|| (perks.len() == columns.len()).then_some(position))
                            .map(|c| (c, perk))
                    })
                    .collect();
                // A line naming a perk no column can roll any more is skipped: dropping only that
                // perk would leave its column empty, which means "any perk".
                let Some(placed) = placed else { continue };
                for (c, perk) in placed {
                    if !columns[c].contains(&perk) {
                        columns[c].push(perk);
                    }
                }
            }
            if columns.iter().all(Vec::is_empty) {
                continue;
            }
            for context in contexts(&tags, &block.title, &block.source) {
                out.push(CuratedRoll {
                    weapon: WeaponHash(weapon),
                    context,
                    columns: columns.clone(),
                    curator: who.clone(),
                    title: block.title.clone(),
                    notes: notes.clone(),
                    tags: tags.clone(),
                    masterwork: masterwork.clone(),
                    mods: mods.clone(),
                    source: block.source.clone(),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ColumnRole;

    const LIST: &str = "title:Big list\n\
description:Thanks to everyone.\n\
\n\
title:PvE Podcast 177 - The Best Trace Rifles\n\
description:Rolls from the podcast.\n\
\n\
// Action Item - PvE Minor god 1\n\
// (Fluted Barrel, Arrowhead Brake), (Tactical Battery), (Rimestealer), (Headstone)\n\
//notes:Constructed by @Adamsdown_Boy (PvE PvE-Minor M+KB): First-choice roll. Recommended MW: Handling or Stability, with your preferred mod.|tags:PvE PvE-Minor PvE-God PvE-MinorSpec M+KB Controller\n\
dimwishlist:item=100&perks=1,10,20,30\n\
dimwishlist:item=100&perks=2,10,20,30\n\
dimwishlist:item=100&perks=2,10,21,31\n\
dimwishlist:item=-100&perks=3,10,20,30\n\
dimwishlist:item=-69420&perks=20,30\n\
\n\
// Action Item - PvP\n\
dimwishlist:item=100&perks=20,31#notes:Duel roll. Recommended Mod: Targeting tags:god-pvp,pvp,controller\n\
";

    fn defs() -> HashMap<WeaponHash, WeaponDef> {
        use ColumnRole::*;
        let def = WeaponDef {
            hash: WeaponHash(100),
            name: "Action Item".into(),
            type_name: "Trace Rifle".into(),
            columns: vec![Barrel, Magazine, Trait, Trait],
            socket_indexes: vec![1, 2, 3, 4],
            look: Default::default(),
            pools: [vec![1, 2, 3], vec![10], vec![20, 21], vec![30, 31]]
                .into_iter()
                .map(|p| p.into_iter().map(PerkHash).collect())
                .collect(),
            parts: Vec::new(),
        };
        [(def.hash, def)].into_iter().collect()
    }

    #[test]
    fn splits_blocks_and_skips_trash_and_wildcards() {
        let blocks = parse_blocks(LIST);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].source, "PvE Podcast 177 - The Best Trace Rifles");
        assert_eq!(blocks[0].title, "Action Item - PvE Minor god 1");
        assert_eq!(blocks[0].lines.len(), 3, "trash and wildcard lines are skipped");
        assert_eq!(blocks[1].title, "Action Item - PvP");
        assert!(blocks[1].notes.starts_with("Duel roll"));
    }

    #[test]
    fn builds_rolls_per_column_with_notes() {
        // 900 is an enhanced Rimestealer; nothing in this list uses it, but the mapper is applied.
        let rolls = curated_rolls(&parse_blocks(LIST), &defs(), |p| if p == 900 { 20 } else { p });
        assert_eq!(rolls.len(), 2);
        let pve = &rolls[0];
        assert_eq!(pve.context, Context::Pve);
        let col = |hashes: &[u32]| hashes.iter().map(|h| PerkHash(*h)).collect::<Vec<_>>();
        assert_eq!(pve.columns, vec![col(&[1, 2]), col(&[10]), col(&[20, 21]), col(&[30, 31])]);
        assert_eq!(pve.curator, "Adamsdown_Boy");
        assert_eq!(pve.masterwork, "Handling or Stability");
        assert_eq!(pve.mods, "Minor Spec");
        assert!(pve.notes.starts_with("First-choice roll."), "{}", pve.notes);
        assert!(pve.tags.contains(&"mkb".to_string()) && pve.tags.contains(&"god-pve".to_string()));

        let pvp = &rolls[1];
        assert_eq!(pvp.context, Context::Pvp);
        assert_eq!(pvp.columns, vec![vec![], vec![], col(&[20]), col(&[31])], "unlisted columns take any perk");
        assert_eq!(pvp.mods, "Targeting");
        assert_eq!(pvp.curator, "PvE Podcast 177 - The Best Trace Rifles");
    }

    #[test]
    fn reads_masterwork_and_mod_from_one_sentence() {
        let mm = |s: &str| masterwork_and_mod(s);
        assert_eq!(mm("Recommended MW: Handling, with a Backup Mag mod."), ("Handling".into(), "Backup Mag".into()));
        assert_eq!(
            mm("Recommended MW: Stability with Targeting Adjuster mod."),
            ("Stability".into(), "Targeting Adjuster".into())
        );
        assert_eq!(mm("Recommended MW - Reload"), ("Reload Speed".into(), String::new()));
        assert_eq!(
            mm("Recommended MW: Handling or Stability, with your preferred choice of mod to boost weapon stats."),
            ("Handling or Stability".into(), String::new())
        );
        assert_eq!(
            mm("Recommended MW: Range with Quick Access Sling or Targeting Adjuster mod depending on play style."),
            ("Range".into(), "Quick Access Sling or Targeting Adjuster".into())
        );
        assert_eq!(
            mm(
                "Recommended MW: Handling, with a Backup Mag mod or, when masterworked, Synergy to create Void Breaches."
            ),
            ("Handling".into(), "Backup Mag".into())
        );
        assert_eq!(
            mm("Recommended MW: Charge Time, with a Charge Time or Backup Mag mod, or your preferred choice."),
            ("Charge Time".into(), "Charge Time or Backup Mag".into())
        );
        assert_eq!(
            mm("Recommended MW: Reload Speed, with a damage boosting (Minor or Taken Spec) mod."),
            ("Reload Speed".into(), "Damage boosting (Minor or Taken Spec)".into())
        );
        assert_eq!(
            mm("Recommended MW: Handling if you don't get Threat Detector and Range if you do."),
            ("Handling if you don't get Threat Detector and Range if you do".into(), String::new())
        );
        assert_eq!(
            mm("Recommended MW: Range, with a damage-boosting (Minor, Major, or Taken Spec) mod."),
            ("Range".into(), "Damage-boosting (Minor, Major, or Taken Spec)".into())
        );
        assert_eq!(mm("Recommended MW - Handling/Reload"), ("Handling or Reload Speed".into(), String::new()));
        assert_eq!(mm("No masterwork advice here."), (String::new(), String::new()));
    }

    #[test]
    fn curator_comes_from_the_lead_in_not_a_cited_tier_list() {
        let notes = "Adamsdown_Boy written as at v9.5.6.2 (PvE): rated B-Tier for endgame PvE by @TheAegisRelic.";
        assert_eq!(curator(notes, "Section"), "Adamsdown_Boy");
        assert_eq!(curator("Constructed by @Name (PvE): Good roll by @Other.", "Section"), "Name");
        assert_eq!(curator("pandapaxxy (PvE / M+KB): Great.", "Section"), "pandapaxxy");
        assert_eq!(curator("A plain note with no lead-in.", "Section"), "Section");
        assert_eq!(curator("A plain note.", "u/Mercules904's Massive Breakdown"), "Mercules904");
    }

    #[test]
    fn notes_lose_only_a_curator_lead_in() {
        let advice = "Pair Rampage with Kill Clip (or Frenzy): huge add-clear in Onslaught.";
        assert_eq!(readable_notes(advice), advice);
        assert_eq!(
            readable_notes("Constructed by @Adamsdown_Boy (PvE PvE-Minor M+KB): First-choice roll."),
            "First-choice roll."
        );
        assert_eq!(readable_notes("Adamsdown_Boy written as at v9.5.6.2 (PvE): rated well."), "rated well.");
        assert_eq!(readable_notes("pandapaxxy (PvE / M+KB): \"Great roll.\""), "Great roll.");
    }

    #[test]
    fn a_line_with_a_retired_perk_is_skipped_not_widened() {
        // 22 rolls on no column any more; the line must not become "any perk" in its column.
        let list = "// Old roll\ndimwishlist:item=100&perks=22,31\ndimwishlist:item=100&perks=20,30\n";
        let rolls = curated_rolls(&parse_blocks(list), &defs(), |p| p);
        assert!(!rolls.is_empty());
        for roll in &rolls {
            let cols: Vec<Vec<u32>> = roll.columns.iter().map(|c| c.iter().map(|p| p.0).collect()).collect();
            assert_eq!(cols, vec![vec![], vec![], vec![20], vec![30]]);
        }
    }

    #[test]
    fn unknown_weapons_are_skipped() {
        let rolls = curated_rolls(&parse_blocks(LIST), &HashMap::new(), |p| p);
        assert!(rolls.is_empty());
    }
}
