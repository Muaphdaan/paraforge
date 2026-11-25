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

/// Who made the roll: "Constructed by @Name", a u/ or @ handle in the notes, else the section.
fn curator(notes: &str, source: &str) -> String {
    let handle = |text: &str| -> Option<String> {
        let start = text.find("by @").map(|i| i + 3).or_else(|| text.find("by u/").map(|i| i + 3))?;
        let name: String = text[start..].chars().take_while(|c| !c.is_whitespace() && !"():,".contains(*c)).collect();
        (name.len() > 1).then_some(name)
    };
    // "pandapaxxy (PvE / M+KB): ..." names the curator before the bracket.
    let lead = || -> Option<String> {
        let (name, _) = notes.split_once(" (")?;
        let name = name.trim();
        (!name.is_empty() && name.len() <= 32 && !name.contains(' ')).then(|| name.to_string())
    };
    handle(notes).or_else(lead).or_else(|| handle(source)).unwrap_or_else(|| source.to_string())
}

/// The notes without their "Constructed by @Name (tags):" lead-in, which ParaForge shows separately.
fn readable_notes(text: &str) -> String {
    // "Constructed by @Name (tags): ..." or "name (PvE / M+KB): ..." near the start.
    let head = &text[..text.char_indices().nth(120).map_or(text.len(), |(i, _)| i)];
    if let Some(i) = head.find("):") {
        let rest = text[i + 2..].trim();
        return rest.strip_prefix('"').and_then(|r| r.strip_suffix('"')).unwrap_or(rest).trim().to_string();
    }
    text.to_string()
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
        let masterwork = after_marker(&text, "Recommended MW");
        let mut mods = after_marker(&text, "Recommended Mod");
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
                for (position, perk) in perks.iter().enumerate() {
                    let perk = PerkHash(base(*perk));
                    let column = def
                        .pools
                        .iter()
                        .position(|pool| pool.contains(&perk))
                        .or_else(|| (perks.len() == columns.len()).then_some(position));
                    if let Some(c) = column
                        && !columns[c].contains(&perk)
                    {
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
        assert_eq!(pve.curator, "@Adamsdown_Boy");
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
    fn unknown_weapons_are_skipped() {
        let rolls = curated_rolls(&parse_blocks(LIST), &HashMap::new(), |p| p);
        assert!(rolls.is_empty());
    }
}
