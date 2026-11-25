//! Signed-in calls to the Bungie.net platform API: memberships, profile, manifest, and the item
//! actions (move, equip, switch perks) that need the "Move or equip Destiny gear" scope.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use serde::de::{DeserializeOwned, IgnoredAny};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::actions::Transfer;
use crate::inventory::RawProfile;
use crate::{AppCredentials, Secret, USER_AGENT};

pub const PLATFORM_URL: &str = "https://www.bungie.net/Platform";
pub const CONTENT_URL: &str = "https://www.bungie.net";

/// Components for a weapon sync: profile, profile inventory (vault), characters, character
/// inventories, character equipment, item instances (tier), stats, item sockets (equipped perks),
/// reusable plugs (selectable perks).
pub const PROFILE_COMPONENTS: &str = "100,102,200,201,205,300,304,305,310";

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("Bungie.net is down for maintenance. Try again later.")]
    Maintenance,
    #[error("Bungie asked ParaForge to slow down. Try again in {0} seconds.")]
    Throttled(i32),
    #[error("your Bungie sign-in is no longer accepted; please sign in again")]
    SignInRequired,
    #[error("Bungie could not find a Destiny 2 account for this sign-in")]
    NoDestinyAccount,
    #[error(
        "your Bungie app does not have the \"Move or equip Destiny gear\" permission. Turn it on for \
         your ParaForge app at bungie.net/en/Application, then press Sign in again in ParaForge's Settings"
    )]
    MissingMoveScope,
    #[error("{0}")]
    Action(&'static str),
    #[error("Bungie returned an error ({code} {status}): {message}")]
    Bungie { code: i32, status: String, message: String },
    #[error("Bungie.net is having difficulties (HTTP {0}). Try again later.")]
    Http(u16),
    #[error("could not reach Bungie: {0}")]
    Network(#[from] reqwest::Error),
    #[error("unexpected reply from Bungie: {0}")]
    BadReply(String),
    #[error("could not save a download: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Envelope<T> {
    response: Option<T>,
    error_code: i32,
    #[serde(default)]
    throttle_seconds: i32,
    #[serde(default)]
    error_status: String,
    #[serde(default)]
    message: String,
}

/// Maps a Bungie envelope's ErrorCode to an error (codes from the Bungie OpenAPI spec, handling as in DIM).
fn check_code(code: i32, throttle: i32, status: &str, message: &str) -> Result<(), ApiError> {
    match code {
        1 => Ok(()),
        5 => Err(ApiError::Maintenance),
        31 | 35 | 36 | 37 | 51 | 54 | 55 | 56 | 57 | 1672 => Err(ApiError::Throttled(throttle.max(1))),
        99 | 22 | 2111 | 2106 | 2122 | 2123 | 2124 | 2110 | 2118 => Err(ApiError::SignInRequired),
        1601 | 1670 => Err(ApiError::NoDestinyAccount),
        _ => match action_error(status) {
            Some(e) => Err(e),
            None => Err(ApiError::Bungie { code, status: status.to_string(), message: message.to_string() }),
        },
    }
}

/// Item-action refusals worth explaining in plain words, by Bungie's ErrorStatus name.
fn action_error(status: &str) -> Option<ApiError> {
    Some(match status {
        "AccessNotPermittedByApplicationScope" => ApiError::MissingMoveScope,
        "DestinyCannotPerformActionAtThisLocation"
        | "DestinyCharacterNotInTower"
        | "DestinyCharacterNotInSocialSpace" => ApiError::Action(
            "Bungie only allows this while that character is in orbit, in a social space, or offline. \
                 Go to orbit or the Tower and try again.",
        ),
        "DestinyNoRoomInDestination" => {
            ApiError::Action("There is no room for it: your vault or that character's weapon slot is full.")
        }
        "DestinyItemUniqueEquipRestricted" => {
            ApiError::Action("Only one exotic weapon can be equipped at a time. Unequip the other exotic first.")
        }
        "DestinyItemNotFound" => {
            ApiError::Action("Bungie could not find that weapon where ParaForge expected it. Sync and try again.")
        }
        "DestinyItemActionForbidden" | "DestinySocketActionNotAllowed" | "DestinyItemFailedLevelCheck" => {
            ApiError::Action("Bungie refused this change for that weapon.")
        }
        _ => return None,
    })
}

/// Parses a platform reply. `status` is the HTTP status.
pub fn parse_envelope<T: DeserializeOwned>(status: u16, body: &[u8]) -> Result<T, ApiError> {
    if status == 401 {
        return Err(ApiError::SignInRequired);
    }
    match serde_json::from_slice::<Envelope<T>>(body) {
        Ok(env) => {
            check_code(env.error_code, env.throttle_seconds, &env.error_status, &env.message)?;
            env.response.ok_or_else(|| ApiError::BadReply("no Response in a successful reply".into()))
        }
        Err(e) if (500..600).contains(&status) => {
            let _ = e;
            Err(ApiError::Http(status))
        }
        Err(e) => Err(ApiError::BadReply(e.to_string())),
    }
}

/// A Bungie id: the API sends int64 values as strings, but accept numbers too.
fn id_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Id {
        S(String),
        N(i64),
    }
    Ok(match Id::deserialize(d)? {
        Id::S(s) => s,
        Id::N(n) => n.to_string(),
    })
}

fn opt_id_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    #[derive(Deserialize)]
    struct Wrap(#[serde(deserialize_with = "id_string")] String);
    Ok(Option::<Wrap>::deserialize(d)?.map(|w| w.0))
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinyMembership {
    pub membership_type: i32,
    #[serde(deserialize_with = "id_string")]
    pub membership_id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub cross_save_override: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMemberships {
    #[serde(default)]
    pub destiny_memberships: Vec<DestinyMembership>,
    #[serde(default, deserialize_with = "opt_id_string")]
    pub primary_membership_id: Option<String>,
}

impl UserMemberships {
    /// The Destiny account to sync: the cross-save primary if there is one, otherwise the first
    /// account that is not overridden by cross save.
    pub fn choose(&self) -> Option<&DestinyMembership> {
        self.candidates().into_iter().next()
    }

    /// Destiny accounts worth trying, best first: the cross-save primary, then accounts that cross
    /// save does not override, in Bungie's order. Without cross save, a player can have several
    /// accounts (for example an old Stadia one), and only the profile request shows which one has
    /// Destiny 2 data, so the sync tries them in turn.
    pub fn candidates(&self) -> Vec<&DestinyMembership> {
        let real = |m: &&DestinyMembership| m.membership_type > 0 && m.membership_type < 20;
        let mut out: Vec<&DestinyMembership> = Vec::new();
        if let Some(primary) = &self.primary_membership_id
            && let Some(m) = self.destiny_memberships.iter().filter(real).find(|m| &m.membership_id == primary)
        {
            out.push(m);
        }
        for m in self.destiny_memberships.iter().filter(real) {
            let own = m.cross_save_override == 0 || m.cross_save_override == m.membership_type;
            if own && !out.iter().any(|o| o.membership_id == m.membership_id) {
                out.push(m);
            }
        }
        out
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: String,
    /// language -> table name -> content path.
    pub json_world_component_content_paths:
        std::collections::HashMap<String, std::collections::HashMap<String, String>>,
}

impl Manifest {
    pub fn table_path(&self, table: &str) -> Option<&str> {
        self.json_world_component_content_paths.get("en")?.get(table).map(String::as_str)
    }
}

/// Signed-in Bungie.net client.
pub struct BungieApi {
    http: reqwest::Client,
    api_key: Secret,
    platform_url: String,
    content_url: String,
}

impl BungieApi {
    pub fn new(app: &AppCredentials) -> Result<Self, ApiError> {
        Self::with_urls(app, PLATFORM_URL, CONTENT_URL)
    }

    /// For tests against a local server.
    pub fn with_urls(app: &AppCredentials, platform_url: &str, content_url: &str) -> Result<Self, ApiError> {
        // read_timeout is per read, so a slow but steady manifest download is never cut off,
        // while a stalled connection fails after a minute.
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(60))
            .build()?;
        Ok(Self {
            http,
            api_key: app.api_key.clone(),
            platform_url: platform_url.trim_end_matches('/').to_string(),
            content_url: content_url.trim_end_matches('/').to_string(),
        })
    }

    async fn get<T: DeserializeOwned>(&self, path: &str, token: Option<&Secret>) -> Result<T, ApiError> {
        let mut req = self
            .http
            .get(format!("{}{path}", self.platform_url))
            .header("X-API-Key", self.api_key.expose())
            .timeout(Duration::from_secs(60));
        if let Some(token) = token {
            req = req.bearer_auth(token.expose());
        }
        let resp = req.send().await?;
        let status = resp.status().as_u16();
        let body = resp.bytes().await?;
        parse_envelope(status, &body)
    }

    async fn post<B: Serialize>(&self, path: &str, token: &Secret, body: &B) -> Result<(), ApiError> {
        let resp = self
            .http
            .post(format!("{}{path}", self.platform_url))
            .header("X-API-Key", self.api_key.expose())
            .bearer_auth(token.expose())
            .json(body)
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        let status = resp.status().as_u16();
        let body = resp.bytes().await?;
        parse_envelope::<IgnoredAny>(status, &body).map(|_| ())
    }

    /// Moves one weapon between a character and the vault.
    pub async fn transfer_item(
        &self,
        token: &Secret,
        account: &DestinyMembership,
        step: &Transfer,
    ) -> Result<(), ApiError> {
        let body = serde_json::json!({
            "itemReferenceHash": step.item_hash,
            "stackSize": 1,
            "transferToVault": step.to_vault,
            "itemId": step.item_id,
            "characterId": step.character_id,
            "membershipType": account.membership_type,
        });
        self.post("/Destiny2/Actions/Items/TransferItem/", token, &body).await
    }

    /// Equips a weapon that is already on the character.
    pub async fn equip_item(
        &self,
        token: &Secret,
        account: &DestinyMembership,
        item_id: &str,
        character_id: &str,
    ) -> Result<(), ApiError> {
        let body = serde_json::json!({
            "itemId": item_id,
            "characterId": character_id,
            "membershipType": account.membership_type,
        });
        self.post("/Destiny2/Actions/Items/EquipItem/", token, &body).await
    }

    /// Selects one of a weapon's rolled perks, the way the game's own perk switch does (free and
    /// reversible).
    pub async fn insert_socket_plug_free(
        &self,
        token: &Secret,
        account: &DestinyMembership,
        item_id: &str,
        character_id: &str,
        socket_index: u8,
        plug_hash: u32,
    ) -> Result<(), ApiError> {
        let body = serde_json::json!({
            "plug": {"socketIndex": socket_index, "socketArrayType": 0, "plugItemHash": plug_hash},
            "itemId": item_id,
            "characterId": character_id,
            "membershipType": account.membership_type,
        });
        self.post("/Destiny2/Actions/Items/InsertSocketPlugFree/", token, &body).await
    }

    pub async fn memberships(&self, token: &Secret) -> Result<UserMemberships, ApiError> {
        self.get("/User/GetMembershipsForCurrentUser/", Some(token)).await
    }

    pub async fn profile(&self, token: &Secret, account: &DestinyMembership) -> Result<RawProfile, ApiError> {
        let path = format!(
            "/Destiny2/{}/Profile/{}/?components={PROFILE_COMPONENTS}",
            account.membership_type, account.membership_id
        );
        self.get(&path, Some(token)).await
    }

    pub async fn manifest(&self) -> Result<Manifest, ApiError> {
        self.get("/Destiny2/Manifest/", None).await
    }

    /// Streams a manifest table (a large JSON file) to `dest`, replacing it only when complete.
    pub async fn download_table(&self, content_path: &str, dest: &Path) -> Result<(), ApiError> {
        if !content_path.starts_with('/') || content_path.contains("..") {
            return Err(ApiError::BadReply(format!("unexpected manifest path {content_path:?}")));
        }
        // No total timeout: the item table is over 100 MB and may take a long time on a slow
        // connection. The client's read timeout catches a stalled download.
        let mut resp = self.http.get(format!("{}{content_path}", self.content_url)).send().await?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(ApiError::Http(status));
        }
        let partial = dest.with_extension("part");
        let result: Result<(), ApiError> = async {
            let mut file = std::io::BufWriter::new(std::fs::File::create(&partial)?);
            while let Some(chunk) = resp.chunk().await? {
                file.write_all(&chunk)?;
            }
            file.into_inner().map_err(|e| e.into_error())?.sync_all()?;
            std::fs::rename(&partial, dest)?;
            Ok(())
        }
        .await;
        if result.is_err() {
            let _ = std::fs::remove_file(&partial);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_errors_are_classified() {
        let ok = br#"{"Response":{"version":"v1","jsonWorldComponentContentPaths":{"en":{"DestinyInventoryItemDefinition":"/x.json"}}},"ErrorCode":1,"ThrottleSeconds":0,"ErrorStatus":"Success","Message":"Ok"}"#;
        let m: Manifest = parse_envelope(200, ok).unwrap();
        assert_eq!(m.table_path("DestinyInventoryItemDefinition"), Some("/x.json"));

        let maint = br#"{"ErrorCode":5,"ThrottleSeconds":0,"ErrorStatus":"SystemDisabled","Message":"down"}"#;
        assert!(matches!(parse_envelope::<Manifest>(503, maint), Err(ApiError::Maintenance)));
        let throttled = br#"{"ErrorCode":36,"ThrottleSeconds":7,"ErrorStatus":"Throttled","Message":"slow"}"#;
        assert!(matches!(parse_envelope::<Manifest>(200, throttled), Err(ApiError::Throttled(7))));
        let auth = br#"{"ErrorCode":99,"ThrottleSeconds":0,"ErrorStatus":"WebAuthRequired","Message":"x"}"#;
        assert!(matches!(parse_envelope::<Manifest>(200, auth), Err(ApiError::SignInRequired)));
        assert!(matches!(parse_envelope::<Manifest>(401, b""), Err(ApiError::SignInRequired)));
        assert!(matches!(parse_envelope::<Manifest>(502, b"<html>bad gateway"), Err(ApiError::Http(502))));
        let other =
            br#"{"ErrorCode":1665,"ThrottleSeconds":0,"ErrorStatus":"DestinyPrivacyRestriction","Message":"private"}"#;
        assert!(matches!(parse_envelope::<Manifest>(200, other), Err(ApiError::Bungie { code: 1665, .. })));
        let scope = br#"{"ErrorCode":12,"ThrottleSeconds":0,"ErrorStatus":"AccessNotPermittedByApplicationScope","Message":"x"}"#;
        assert!(matches!(parse_envelope::<Manifest>(200, scope), Err(ApiError::MissingMoveScope)));
        let away = br#"{"ErrorCode":1634,"ThrottleSeconds":0,"ErrorStatus":"DestinyCannotPerformActionAtThisLocation","Message":"x"}"#;
        let msg = parse_envelope::<Manifest>(200, away).unwrap_err().to_string();
        assert!(msg.contains("orbit"), "{msg}");
    }

    #[test]
    fn chooses_cross_save_primary() {
        let body = br#"{"Response":{"destinyMemberships":[
            {"membershipType":2,"membershipId":"4611686018400000001","displayName":"PS","crossSaveOverride":3},
            {"membershipType":3,"membershipId":"4611686018400000002","displayName":"Steam","crossSaveOverride":3}],
            "primaryMembershipId":"4611686018400000002"},"ErrorCode":1,"ThrottleSeconds":0,"ErrorStatus":"Success","Message":"Ok"}"#;
        let m: UserMemberships = parse_envelope(200, body).unwrap();
        assert_eq!(m.choose().unwrap().membership_type, 3);

        let single = br#"{"Response":{"destinyMemberships":[
            {"membershipType":3,"membershipId":4611686018400000009,"displayName":"Steam","crossSaveOverride":0}]},
            "ErrorCode":1,"ThrottleSeconds":0,"ErrorStatus":"Success","Message":"Ok"}"#;
        let m: UserMemberships = parse_envelope(200, single).unwrap();
        assert_eq!(m.choose().unwrap().membership_id, "4611686018400000009");

        // No cross save, two accounts of their own: both are tried, in Bungie's order.
        let two = br#"{"Response":{"destinyMemberships":[
            {"membershipType":5,"membershipId":"4611686018400000005","displayName":"Stadia","crossSaveOverride":0},
            {"membershipType":3,"membershipId":"4611686018400000003","displayName":"Steam","crossSaveOverride":0},
            {"membershipType":2,"membershipId":"4611686018400000002","displayName":"PS","crossSaveOverride":3}]},
            "ErrorCode":1,"ThrottleSeconds":0,"ErrorStatus":"Success","Message":"Ok"}"#;
        let m: UserMemberships = parse_envelope(200, two).unwrap();
        let types: Vec<i32> = m.candidates().iter().map(|c| c.membership_type).collect();
        assert_eq!(types, vec![5, 3]);

        // The cross-save primary comes first and is not repeated.
        let body = br#"{"Response":{"destinyMemberships":[
            {"membershipType":3,"membershipId":"4611686018400000003","displayName":"Steam","crossSaveOverride":3},
            {"membershipType":2,"membershipId":"4611686018400000002","displayName":"PS","crossSaveOverride":3}],
            "primaryMembershipId":"4611686018400000003"},"ErrorCode":1,"ThrottleSeconds":0,"ErrorStatus":"Success","Message":"Ok"}"#;
        let m: UserMemberships = parse_envelope(200, body).unwrap();
        assert_eq!(m.candidates().len(), 1);

        let none = br#"{"Response":{"destinyMemberships":[]},"ErrorCode":1,"ThrottleSeconds":0,"ErrorStatus":"Success","Message":"Ok"}"#;
        assert!(parse_envelope::<UserMemberships>(200, none).unwrap().choose().is_none());
    }

    #[test]
    fn profile_fixture_parses_through_envelope() {
        let text = include_bytes!("../tests/fixtures/profile-trimmed.json");
        let p: RawProfile = parse_envelope(200, text).unwrap();
        assert!(p.profile_inventory.data.is_some());
        assert_eq!(p.item_components.instances.data.as_ref().unwrap().len(), 3);
    }
}
