//! The local SQLite database. Everything about the player's vault stays on their PC.
//!
//! Schema changes are numbered migrations tracked in SQLite's `user_version`.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use thiserror::Error;

use crate::model::{
    ColumnRole, Context, CopyColumn, CuratedRoll, PerkHash, PerkInfo, Provenance, Tier, WeaponCopy, WeaponDef,
    WeaponHash, WeaponLook,
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
];

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
                "INSERT INTO weapon(hash, name, type_name, columns, socket_indexes, look) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(hash) DO UPDATE SET name = excluded.name, type_name = excluded.type_name,
                     columns = excluded.columns, socket_indexes = excluded.socket_indexes, look = excluded.look",
            )?;
            for w in weapons {
                stmt.execute(params![
                    w.hash.0,
                    w.name,
                    w.type_name,
                    serde_json::to_string(&w.columns)?,
                    serde_json::to_string(&w.socket_indexes)?,
                    serde_json::to_string(&w.look)?
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn weapons(&self) -> Result<HashMap<WeaponHash, WeaponDef>> {
        let mut stmt = self.conn.prepare("SELECT hash, name, type_name, columns, socket_indexes, look FROM weapon")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        let mut out = HashMap::new();
        for row in rows {
            let (hash, name, type_name, columns, sockets, look) = row?;
            let columns: Vec<ColumnRole> = serde_json::from_str(&columns)?;
            let socket_indexes: Vec<u8> = serde_json::from_str(&sockets)?;
            let look: WeaponLook = serde_json::from_str(&look)?;
            out.insert(
                WeaponHash(hash),
                WeaponDef { hash: WeaponHash(hash), name, type_name, columns, socket_indexes, look },
            );
        }
        Ok(out)
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
                "INSERT INTO weapon_copy(instance_id, weapon_hash, tier, columns, masterworked, locked, synced_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
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
                    synced_at
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
            "SELECT instance_id, weapon_hash, tier, columns, masterworked, locked FROM weapon_copy ORDER BY instance_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, u8>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, bool>(4)?,
                r.get::<_, bool>(5)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (instance_id, weapon, tier, columns, masterworked, locked) = row?;
            let tier = Tier::new(tier).ok_or_else(|| DbError::Corrupt(format!("tier {tier} on {instance_id}")))?;
            let columns: Vec<CopyColumn> = serde_json::from_str(&columns)?;
            out.push(WeaponCopy { instance_id, weapon: WeaponHash(weapon), tier, columns, masterworked, locked });
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
                "INSERT INTO curated_roll(weapon_hash, context, columns, curator, source_id) VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for roll in rolls {
                stmt.execute(params![
                    roll.weapon.0,
                    roll.context.as_str(),
                    serde_json::to_string(&roll.columns)?,
                    roll.curator,
                    source_id
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn rolls(&self) -> Result<Vec<CuratedRoll>> {
        let mut stmt =
            self.conn.prepare("SELECT weapon_hash, context, columns, curator FROM curated_roll ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (weapon, context, columns, curator) = row?;
            out.push(CuratedRoll {
                weapon: WeaponHash(weapon),
                context: parse_context(&context)?,
                columns: serde_json::from_str(&columns)?,
                curator,
            });
        }
        Ok(out)
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
                "INSERT INTO weapon(hash, name, type_name, columns, socket_indexes, look)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for d in weapons {
                w.execute(params![
                    d.hash.0,
                    d.name,
                    d.type_name,
                    serde_json::to_string(&d.columns)?,
                    serde_json::to_string(&d.socket_indexes)?,
                    serde_json::to_string(&d.look)?
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
                    w.look, w.columns, c.columns
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
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (instance_id, weapon, name, type_name, tier, masterworked, locked, detail, look, roles, columns) = row?;
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
            });
        }
        Ok(out)
    }
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
}

fn parse_context(value: &str) -> Result<Context> {
    Context::parse(value).ok_or_else(|| DbError::Corrupt(format!("unknown context {value:?}")))
}
