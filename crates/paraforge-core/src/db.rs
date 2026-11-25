//! The local SQLite database. Everything about the player's vault stays on their PC.
//!
//! Schema changes are numbered migrations tracked in SQLite's `user_version`.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use thiserror::Error;

use crate::model::{
    ColumnRole, Context, CopyColumn, CopyLocation, CopyPart, CuratedRoll, PerkHash, PerkInfo, Provenance, Tier,
    WeaponCopy, WeaponDef, WeaponHash, WeaponLook, WeaponPart,
};
use crate::rules::PerkRatings;
use crate::score::CopyScore;

#[derive(Debug, Error)]
pub enum DbError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("bad data in the database: {0}")]
    Corrupt(String),
    #[error("database schema version {found} is newer than this app supports ({supported})")]
    TooNew { found: i64, supported: i64 },
}

pub type Result<T> = std::result::Result<T, DbError>;

const MIGRATIONS: &[&str] = &[
    // 1: initial schema
    r#"
    CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    -- Data sources with provenance, referenced by curated rows.
    CREATE TABLE source (
        id      TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        license TEXT NOT NULL,
        fetched TEXT NOT NULL
    );

    CREATE TABLE weapon (
        hash      INTEGER PRIMARY KEY,
        name      TEXT NOT NULL,
        type_name TEXT NOT NULL,
        columns   TEXT NOT NULL            -- JSON array of column roles
    );

    CREATE VIRTUAL TABLE weapon_fts USING fts5(
        name, type_name, content='weapon', content_rowid='hash', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER weapon_ai AFTER INSERT ON weapon BEGIN
        INSERT INTO weapon_fts(rowid, name, type_name) VALUES (new.hash, new.name, new.type_name);
    END;
    CREATE TRIGGER weapon_ad AFTER DELETE ON weapon BEGIN
        INSERT INTO weapon_fts(weapon_fts, rowid, name, type_name) VALUES ('delete', old.hash, old.name, old.type_name);
    END;
    CREATE TRIGGER weapon_au AFTER UPDATE ON weapon BEGIN
        INSERT INTO weapon_fts(weapon_fts, rowid, name, type_name) VALUES ('delete', old.hash, old.name, old.type_name);
        INSERT INTO weapon_fts(rowid, name, type_name) VALUES (new.hash, new.name, new.type_name);
    END;

    CREATE TABLE weapon_copy (
        instance_id  TEXT PRIMARY KEY,
        weapon_hash  INTEGER NOT NULL,
        tier         INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 5),
        columns      TEXT NOT NULL,         -- JSON array of CopyColumn
        masterworked INTEGER NOT NULL DEFAULT 0,
        locked       INTEGER NOT NULL DEFAULT 0,
        synced_at    TEXT NOT NULL
    );
    CREATE INDEX weapon_copy_by_weapon ON weapon_copy(weapon_hash);

    CREATE TABLE perk_rating (
        perk_hash INTEGER NOT NULL,
        context   TEXT NOT NULL,
        rating    REAL NOT NULL CHECK (rating BETWEEN 0 AND 1),
        source_id TEXT NOT NULL REFERENCES source(id),
        PRIMARY KEY (perk_hash, context)
    );

    CREATE TABLE curated_roll (
        id          INTEGER PRIMARY KEY,
        weapon_hash INTEGER NOT NULL,
        context     TEXT NOT NULL,
        columns     TEXT NOT NULL,          -- JSON array of arrays of perk hashes
        curator     TEXT NOT NULL,
        source_id   TEXT NOT NULL REFERENCES source(id)
    );
    CREATE INDEX curated_roll_by_weapon ON curated_roll(weapon_hash, context);

    CREATE TABLE chase_item (
        id          INTEGER PRIMARY KEY,
        weapon_hash INTEGER NOT NULL,
        context     TEXT NOT NULL,
        perks       TEXT NOT NULL,          -- JSON array of arrays of perk hashes
        priority    INTEGER NOT NULL DEFAULT 0,
        note        TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL
    );

    CREATE TABLE copy_score (
        instance_id TEXT NOT NULL,
        context     TEXT NOT NULL,
        score       REAL NOT NULL,
        verdict     TEXT NOT NULL,
        ruleset     TEXT NOT NULL,
        detail      TEXT NOT NULL,          -- JSON CopyScore
        PRIMARY KEY (instance_id, context)
    );
    "#,
    // 2: untiered weapons (tier 0), column socket indexes, perk names
    r#"
    CREATE TABLE weapon_copy_v2 (
        instance_id  TEXT PRIMARY KEY,
        weapon_hash  INTEGER NOT NULL,
        tier         INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 5),
        columns      TEXT NOT NULL,
        masterworked INTEGER NOT NULL DEFAULT 0,
        locked       INTEGER NOT NULL DEFAULT 0,
        synced_at    TEXT NOT NULL
    );
    INSERT INTO weapon_copy_v2 SELECT * FROM weapon_copy;
    DROP TABLE weapon_copy;
    ALTER TABLE weapon_copy_v2 RENAME TO weapon_copy;
    CREATE INDEX weapon_copy_by_weapon ON weapon_copy(weapon_hash);

    ALTER TABLE weapon ADD COLUMN socket_indexes TEXT NOT NULL DEFAULT '[]';

    CREATE TABLE perk (
        hash          INTEGER PRIMARY KEY,
        name          TEXT NOT NULL,
        plug_category TEXT NOT NULL DEFAULT ''
    );
    "#,
    // 3: weapon icons, slot, element, ammo and rarity; perk icons and descriptions
    r#"
    ALTER TABLE weapon ADD COLUMN look TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE perk ADD COLUMN icon TEXT NOT NULL DEFAULT '';
    ALTER TABLE perk ADD COLUMN description TEXT NOT NULL DEFAULT '';
    "#,
    // 4: each column's perk pool; each copy's stats and where it is
    r#"
    ALTER TABLE weapon ADD COLUMN pools TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE weapon_copy ADD COLUMN stats TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE weapon_copy ADD COLUMN location TEXT NOT NULL DEFAULT 'vault';
    "#,
    // 5: the Chase list, rolls the player is hunting
    r#"
    CREATE TABLE chase (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        weapon_hash INTEGER NOT NULL,
        perks       TEXT NOT NULL,          -- JSON: wanted perks per column, [] for any
        added       TEXT NOT NULL
    );
    "#,
    // 6: intrinsic, origin trait, masterwork, mod and catalyst sockets, on weapons and copies
    r#"
    ALTER TABLE weapon ADD COLUMN parts TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE weapon_copy ADD COLUMN parts TEXT NOT NULL DEFAULT '[]';
    "#,
    // 7: god-roll titles, notes, tags and picks; the wish-list section each roll came from
    r#"
    ALTER TABLE curated_roll ADD COLUMN detail TEXT NOT NULL DEFAULT '';
    ALTER TABLE curated_roll ADD COLUMN origin TEXT NOT NULL DEFAULT '';
    "#,
];

const WEAPON_COLUMNS: &str = "hash, name, type_name, columns, socket_indexes, look, pools, parts";

type WeaponRow = (u32, String, String, String, String, String, String, String);

fn weapon_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<WeaponRow> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
}

fn parse_weapon(row: WeaponRow) -> Result<WeaponDef> {
    let (hash, name, type_name, columns, sockets, look, pools, parts) = row;
    Ok(WeaponDef {
        hash: WeaponHash(hash),
        name,
        type_name,
        columns: serde_json::from_str(&columns)?,
        socket_indexes: serde_json::from_str(&sockets)?,
        look: serde_json::from_str::<WeaponLook>(&look)?,
        pools: serde_json::from_str(&pools)?,
        parts: serde_json::from_str(&parts)?,
    })
}

pub struct Database {
    conn: Connection,
}

impl Database {
    /// Opens (or creates) the database file and brings the schema up to date.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    /// An in-memory database, for tests.
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", true)?;
        let mut db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    fn migrate(&mut self) -> Result<()> {
        let current = self.schema_version()?;
        let supported = MIGRATIONS.len() as i64;
        if current > supported {
            return Err(DbError::TooNew { found: current, supported });
        }
        for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            let tx = self.conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", index as i64 + 1)?;
            tx.commit()?;
        }
        Ok(())
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn upsert_source(&self, id: &str, p: &Provenance) -> Result<()> {
        self.conn.execute(
            "INSERT INTO source(id, version, license, fetched) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET version = excluded.version, license = excluded.license, fetched = excluded.fetched",
            params![id, p.version, p.license, p.fetched],
        )?;
        Ok(())
    }

    pub fn upsert_weapons(&mut self, weapons: &[WeaponDef]) -> Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO weapon(hash, name, type_name, columns, socket_indexes, look, pools, parts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(hash) DO UPDATE SET name = excluded.name, type_name = excluded.type_name,
                     columns = excluded.columns, socket_indexes = excluded.socket_indexes, look = excluded.look,
                     pools = excluded.pools, parts = excluded.parts",
            )?;
            for w in weapons {
                stmt.execute(params![
                    w.hash.0,
                    w.name,
                    w.type_name,
                    serde_json::to_string(&w.columns)?,
                    serde_json::to_string(&w.socket_indexes)?,
                    serde_json::to_string(&w.look)?,
                    serde_json::to_string(&w.pools)?,
                    serde_json::to_string(&w.parts)?
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn weapons(&self) -> Result<HashMap<WeaponHash, WeaponDef>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {WEAPON_COLUMNS} FROM weapon"))?;
        let rows = stmt.query_map([], weapon_from_row)?;
        let mut out = HashMap::new();
        for row in rows {
            let def = parse_weapon(row?)?;
            out.insert(def.hash, def);
        }
        Ok(out)
    }

    /// Number of rows in one of ParaForge's own tables.
    pub fn count(&self, table: &str) -> Result<usize> {
        if !["weapon", "perk", "weapon_copy", "curated_roll"].contains(&table) {
            return Err(DbError::Corrupt(format!("no count for table {table:?}")));
        }
        let n: i64 = self.conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
        Ok(n as usize)
    }

    /// One weapon's definition, with its perk pools.
    pub fn weapon(&self, hash: WeaponHash) -> Result<Option<WeaponDef>> {
        let row = self
            .conn
            .query_row(&format!("SELECT {WEAPON_COLUMNS} FROM weapon WHERE hash = ?1"), [hash.0], weapon_from_row)
            .optional()?;
        row.map(parse_weapon).transpose()
    }

    /// Every Legendary and Exotic weapon in the game with what can roll on it and how many copies
    /// the player owns, by name.
    pub fn codex(&self) -> Result<Vec<CodexRow>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {WEAPON_COLUMNS}, (SELECT COUNT(*) FROM weapon_copy c WHERE c.weapon_hash = weapon.hash) FROM weapon"
        ))?;
        let rows = stmt.query_map([], |r| Ok((weapon_from_row(r)?, r.get::<_, i64>(8)?)))?;
        let meta = self.meta_counts()?;
        let mut out = Vec::new();
        for row in rows {
            let (raw, owned) = row?;
            let def = parse_weapon(raw)?;
            if def.look.rarity < RARITY_LEGENDARY {
                continue;
            }
            out.push(CodexRow {
                hash: def.hash,
                name: def.name,
                type_name: def.type_name,
                look: def.look,
                roles: def.columns,
                pools: def.pools,
                parts: def.parts,
                owned: owned as u32,
                meta: meta.get(&def.hash).copied().unwrap_or(0),
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name).then(a.hash.cmp(&b.hash)));
        Ok(out)
    }

    /// Adds a roll to the Chase list and returns its id. Chasing the same roll twice keeps one entry.
    pub fn add_chase(&self, weapon: WeaponHash, perks: &[Vec<PerkHash>], added: &str) -> Result<i64> {
        let mut perks: Vec<Vec<PerkHash>> = perks.to_vec();
        for column in &mut perks {
            column.sort();
            column.dedup();
        }
        let json = serde_json::to_string(&perks)?;
        let existing: Option<i64> = self
            .conn
            .query_row("SELECT id FROM chase WHERE weapon_hash = ?1 AND perks = ?2", params![weapon.0, json], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(id) = existing {
            return Ok(id);
        }
        self.conn.execute(
            "INSERT INTO chase(weapon_hash, perks, added) VALUES (?1, ?2, ?3)",
            params![weapon.0, json, added],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// The Chase list, oldest first.
    pub fn chases(&self) -> Result<Vec<ChaseRoll>> {
        let mut stmt = self.conn.prepare("SELECT id, weapon_hash, perks, added FROM chase ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, u32>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, weapon, perks, added) = row?;
            out.push(ChaseRoll { id, weapon: WeaponHash(weapon), perks: serde_json::from_str(&perks)?, added });
        }
        Ok(out)
    }

    /// Removes a roll from the Chase list; removing one that is not there does nothing.
    pub fn remove_chase(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM chase WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Full-text search over weapon names and types; prefix matching on each word.
    pub fn search_weapons(&self, query: &str, limit: usize) -> Result<Vec<WeaponHash>> {
        let terms: Vec<String> = query
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| !t.is_empty())
            .map(|t| format!("\"{t}\"*"))
            .collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt =
            self.conn.prepare("SELECT rowid FROM weapon_fts WHERE weapon_fts MATCH ?1 ORDER BY rank LIMIT ?2")?;
        let rows = stmt.query_map(params![terms.join(" "), limit as i64], |r| r.get::<_, u32>(0))?;
        rows.map(|r| r.map(WeaponHash).map_err(DbError::from)).collect()
    }

    /// Replaces the whole vault with a fresh sync snapshot. Copies no longer owned are removed,
    /// and stored scores are dropped for any copy that is gone or has changed since it was scored.
    pub fn replace_copies(&mut self, copies: &[WeaponCopy], synced_at: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        let old: HashMap<String, (u32, u8, String, bool)> = {
            let mut stmt =
                tx.prepare("SELECT instance_id, weapon_hash, tier, columns, masterworked FROM weapon_copy")?;
            stmt.query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))))?
                .collect::<rusqlite::Result<_>>()?
        };
        tx.execute("DELETE FROM weapon_copy", [])?;
        {
            let mut insert = tx.prepare(
                "INSERT INTO weapon_copy(instance_id, weapon_hash, tier, columns, masterworked, locked, synced_at,
                     stats, location, parts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )?;
            let mut stale = tx.prepare("DELETE FROM copy_score WHERE instance_id = ?1")?;
            for c in copies {
                let columns = serde_json::to_string(&c.columns)?;
                let now = (c.weapon.0, c.tier.get(), columns.clone(), c.masterworked);
                if old.get(&c.instance_id) != Some(&now) {
                    stale.execute([&c.instance_id])?;
                }
                insert.execute(params![
                    c.instance_id,
                    c.weapon.0,
                    c.tier.get(),
                    columns,
                    c.masterworked,
                    c.locked,
                    synced_at,
                    serde_json::to_string(&c.stats)?,
                    c.location.as_str(),
                    serde_json::to_string(&c.parts)?
                ])?;
            }
        }
        // Keep scores only for copies still owned.
        tx.execute("DELETE FROM copy_score WHERE instance_id NOT IN (SELECT instance_id FROM weapon_copy)", [])?;
        tx.commit()?;
        Ok(())
    }

    pub fn copies(&self) -> Result<Vec<WeaponCopy>> {
        let mut stmt = self.conn.prepare(
            "SELECT instance_id, weapon_hash, tier, columns, masterworked, locked, stats, location, parts
             FROM weapon_copy ORDER BY instance_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, u8>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, bool>(4)?,
                r.get::<_, bool>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, String>(8)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (instance_id, weapon, tier, columns, masterworked, locked, stats, location, parts) = row?;
            let tier = Tier::new(tier).ok_or_else(|| DbError::Corrupt(format!("tier {tier} on {instance_id}")))?;
            let columns: Vec<CopyColumn> = serde_json::from_str(&columns)?;
            out.push(WeaponCopy {
                instance_id,
                weapon: WeaponHash(weapon),
                tier,
                columns,
                masterworked,
                locked,
                stats: serde_json::from_str(&stats)?,
                location: CopyLocation::parse(&location),
                parts: serde_json::from_str(&parts)?,
            });
        }
        Ok(out)
    }

    pub fn replace_ratings(&mut self, ratings: &PerkRatings, source_id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM perk_rating WHERE source_id = ?1", [source_id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO perk_rating(perk_hash, context, rating, source_id) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(perk_hash, context) DO UPDATE SET rating = excluded.rating, source_id = excluded.source_id",
            )?;
            for (context, perk, rating) in ratings.iter() {
                stmt.execute(params![perk.0, context.as_str(), rating, source_id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn ratings(&self) -> Result<PerkRatings> {
        let mut stmt = self.conn.prepare("SELECT perk_hash, context, rating FROM perk_rating")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?)))?;
        let mut out = PerkRatings::new();
        for row in rows {
            let (perk, context, rating) = row?;
            out.set(parse_context(&context)?, PerkHash(perk), rating);
        }
        Ok(out)
    }

    pub fn replace_rolls(&mut self, rolls: &[CuratedRoll], source_id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM curated_roll WHERE source_id = ?1", [source_id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO curated_roll(weapon_hash, context, columns, curator, source_id, detail, origin)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for roll in rolls {
                stmt.execute(params![
                    roll.weapon.0,
                    roll.context.as_str(),
                    serde_json::to_string(&roll.columns)?,
                    roll.curator,
                    source_id,
                    serde_json::to_string(roll)?,
                    roll.source
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn rolls(&self) -> Result<Vec<CuratedRoll>> {
        self.rolls_where("", [])
    }

    /// Every curated roll for one weapon, in list order.
    pub fn rolls_for(&self, weapon: WeaponHash) -> Result<Vec<CuratedRoll>> {
        self.rolls_where("WHERE weapon_hash = ?1", [weapon.0])
    }

    fn rolls_where<P: rusqlite::Params>(&self, filter: &str, params: P) -> Result<Vec<CuratedRoll>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT weapon_hash, context, columns, curator, detail FROM curated_roll {filter} ORDER BY id"
        ))?;
        let rows = stmt.query_map(params, |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (weapon, context, columns, curator, detail) = row?;
            if !detail.is_empty() {
                out.push(serde_json::from_str(&detail)?);
                continue;
            }
            out.push(CuratedRoll {
                weapon: WeaponHash(weapon),
                context: parse_context(&context)?,
                columns: serde_json::from_str(&columns)?,
                curator,
                title: String::new(),
                notes: String::new(),
                tags: Vec::new(),
                masterwork: String::new(),
                mods: String::new(),
                source: String::new(),
            });
        }
        Ok(out)
    }

    /// How many separate wish-list sections recommend each weapon: ParaForge's meta measure
    /// (curator consensus). Weapons no curator lists are missing from the map.
    pub fn meta_counts(&self) -> Result<HashMap<WeaponHash, u32>> {
        let mut stmt = self.conn.prepare(
            "SELECT weapon_hash, COUNT(DISTINCT CASE WHEN origin = '' THEN curator ELSE origin END)
             FROM curated_roll GROUP BY weapon_hash",
        )?;
        let rows = stmt.query_map([], |r| Ok((WeaponHash(r.get(0)?), r.get::<_, u32>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Stores the result of a scoring pass for one context, replacing that context's previous scores,
    /// so a copy that could not be scored this time does not keep an old verdict.
    pub fn save_scores(&mut self, context: Context, scores: &[CopyScore]) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM copy_score WHERE context = ?1", [context.as_str()])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO copy_score(instance_id, context, score, verdict, ruleset, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for s in scores {
                if s.context != context {
                    return Err(DbError::Corrupt(format!("score for {} is not in context {context}", s.instance_id)));
                }
                stmt.execute(params![
                    s.instance_id,
                    s.context.as_str(),
                    s.score,
                    s.verdict.label(),
                    s.ruleset,
                    serde_json::to_string(s)?
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn scores(&self, context: Context) -> Result<Vec<CopyScore>> {
        let mut stmt =
            self.conn.prepare("SELECT detail FROM copy_score WHERE context = ?1 ORDER BY score DESC, instance_id")?;
        let rows = stmt.query_map([context.as_str()], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row?)?);
        }
        Ok(out)
    }
}

impl Database {
    /// Replaces all weapon and perk definitions with a fresh manifest import, in one transaction.
    pub fn replace_definitions(&mut self, weapons: &[WeaponDef], perks: &[PerkInfo]) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM weapon", [])?;
        tx.execute("DELETE FROM perk", [])?;
        {
            let mut w = tx.prepare(
                "INSERT INTO weapon(hash, name, type_name, columns, socket_indexes, look, pools, parts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for d in weapons {
                w.execute(params![
                    d.hash.0,
                    d.name,
                    d.type_name,
                    serde_json::to_string(&d.columns)?,
                    serde_json::to_string(&d.socket_indexes)?,
                    serde_json::to_string(&d.look)?,
                    serde_json::to_string(&d.pools)?,
                    serde_json::to_string(&d.parts)?
                ])?;
            }
            let mut p = tx.prepare(
                "INSERT OR REPLACE INTO perk(hash, name, plug_category, icon, description) VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for perk in perks {
                p.execute(params![perk.hash.0, perk.name, perk.plug_category, perk.icon, perk.description])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Every known perk with its name, icon and description.
    pub fn perks(&self) -> Result<Vec<PerkInfo>> {
        let mut stmt = self.conn.prepare("SELECT hash, name, plug_category, icon, description FROM perk")?;
        let rows = stmt.query_map([], |r| {
            Ok(PerkInfo {
                hash: PerkHash(r.get(0)?),
                name: r.get(1)?,
                plug_category: r.get(2)?,
                icon: r.get(3)?,
                description: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn perk_names(&self) -> Result<HashMap<PerkHash, String>> {
        let mut stmt = self.conn.prepare("SELECT hash, name FROM perk")?;
        let rows = stmt.query_map([], |r| Ok((PerkHash(r.get(0)?), r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Every owned copy with its weapon name and its score in `context`, best first.
    pub fn vault_rows(&self, context: Context) -> Result<Vec<VaultRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.instance_id, c.weapon_hash, w.name, w.type_name, c.tier, c.masterworked, c.locked, s.detail,
                    w.look, w.columns, c.columns, c.stats, c.location, c.parts
             FROM weapon_copy c
             JOIN weapon w ON w.hash = c.weapon_hash
             LEFT JOIN copy_score s ON s.instance_id = c.instance_id AND s.context = ?1
             ORDER BY s.score IS NULL, s.score DESC, w.name, c.instance_id",
        )?;
        let rows = stmt.query_map([context.as_str()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, u8>(4)?,
                r.get::<_, bool>(5)?,
                r.get::<_, bool>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, String>(9)?,
                r.get::<_, String>(10)?,
                r.get::<_, String>(11)?,
                r.get::<_, String>(12)?,
                r.get::<_, String>(13)?,
            ))
        })?;
        let meta = self.meta_counts()?;
        let mut out = Vec::new();
        for row in rows {
            let (
                instance_id,
                weapon,
                name,
                type_name,
                tier,
                masterworked,
                locked,
                detail,
                look,
                roles,
                columns,
                stats,
                location,
                parts,
            ) = row?;
            out.push(VaultRow {
                instance_id,
                weapon: WeaponHash(weapon),
                name,
                type_name,
                tier,
                masterworked,
                locked,
                score: detail.map(|d| serde_json::from_str(&d)).transpose()?,
                look: serde_json::from_str(&look)?,
                roles: serde_json::from_str(&roles)?,
                columns: serde_json::from_str(&columns)?,
                stats: serde_json::from_str(&stats)?,
                location: CopyLocation::parse(&location),
                parts: serde_json::from_str(&parts)?,
                meta: meta.get(&WeaponHash(weapon)).copied().unwrap_or(0),
            });
        }
        Ok(out)
    }
}

/// Bungie TierType of Legendary weapons; Exotic is 6. Lower tiers are not in the Codex.
const RARITY_LEGENDARY: u8 = 5;

/// A roll on the Chase list.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ChaseRoll {
    pub id: i64,
    pub weapon: WeaponHash,
    /// The perks wanted in each column, in column order; an empty column takes any perk.
    pub perks: Vec<Vec<PerkHash>>,
    /// When it was added, Unix seconds.
    pub added: String,
}

/// One weapon in the Codex.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CodexRow {
    pub hash: WeaponHash,
    pub name: String,
    pub type_name: String,
    pub look: WeaponLook,
    /// What each perk column is, same order as `pools`.
    pub roles: Vec<ColumnRole>,
    /// Every perk that can currently roll in each column.
    pub pools: Vec<Vec<PerkHash>>,
    /// Intrinsic, origin trait, masterwork, mod and catalyst sockets.
    pub parts: Vec<WeaponPart>,
    /// Copies the player owns.
    pub owned: u32,
    /// How many curator sources recommend it (see [`Database::meta_counts`]); 0 for none.
    pub meta: u32,
}

/// One line of the vault list.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct VaultRow {
    pub instance_id: String,
    pub weapon: WeaponHash,
    pub name: String,
    pub type_name: String,
    pub tier: u8,
    pub masterworked: bool,
    pub locked: bool,
    pub score: Option<CopyScore>,
    pub look: WeaponLook,
    /// What each perk column is (barrel, magazine, trait), same order as `columns`.
    pub roles: Vec<ColumnRole>,
    /// This copy's perks, column by column.
    pub columns: Vec<CopyColumn>,
    /// Stat values by Bungie stat hash.
    pub stats: std::collections::BTreeMap<u32, i32>,
    pub location: CopyLocation,
    /// Intrinsic, origin trait, masterwork, mod and catalyst on this copy.
    pub parts: Vec<CopyPart>,
    /// How many curator sources recommend this weapon; 0 for none.
    pub meta: u32,
}

fn parse_context(value: &str) -> Result<Context> {
    Context::parse(value).ok_or_else(|| DbError::Corrupt(format!("unknown context {value:?}")))
}
