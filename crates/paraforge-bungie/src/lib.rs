//! Bungie.net sign-in for ParaForge: OAuth for a private Confidential app, and token refresh.
//!
//! Secrets in this crate never implement a revealing `Debug`, so they cannot leak into logs.
//! See <https://github.com/Bungie-net/api/wiki/OAuth-Documentation>.

use std::fmt;

use base64::Engine;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

pub const AUTHORIZE_URL: &str = "https://www.bungie.net/en/OAuth/Authorize";
pub const TOKEN_URL: &str = "https://www.bungie.net/platform/app/oauth/token/";
/// Where Bungie sends the player back after sign-in; registered on the Bungie app.
pub const REDIRECT_URL: &str = "paraforge://auth";
pub const USER_AGENT: &str = concat!("ParaForge/", env!("CARGO_PKG_VERSION"), " (personal build)");

/// Refresh the access token when it has less than this many seconds left.
const REFRESH_MARGIN_SECS: i64 = 300;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("sign-in was cancelled or refused by Bungie: {0}")]
    Denied(String),
    #[error("the sign-in reply did not match the sign-in ParaForge started")]
    StateMismatch,
    #[error("the sign-in reply had no code")]
    MissingCode,
    #[error("not a ParaForge sign-in address")]
    NotOurCallback,
    #[error("Bungie rejected the request ({status}): {message}")]
    Rejected { status: u16, message: String },
    #[error("your Bungie sign-in has expired; please sign in again")]
    SignInExpired,
    #[error("could not reach Bungie: {0}")]
    Network(#[from] reqwest::Error),
    #[error("unexpected reply from Bungie: {0}")]
    BadReply(String),
    #[error("could not generate a random value: {0}")]
    Random(String),
}

/// A secret string whose `Debug` output is redacted.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(***)")
    }
}

/// The keys of the player's own Bungie app (bungie.net/en/Application).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppCredentials {
    pub api_key: Secret,
    pub client_id: String,
    pub client_secret: Secret,
}

impl AppCredentials {
    /// Checks the shape of the keys before saving them, to catch paste mistakes early.
    pub fn validate(&self) -> Result<(), String> {
        let key = self.api_key.expose();
        if key.len() != 32 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("The API key should be 32 letters and numbers (0-9, a-f).".into());
        }
        if self.client_id.is_empty() || !self.client_id.chars().all(|c| c.is_ascii_digit()) {
            return Err("The OAuth client_id should be a number.".into());
        }
        let secret = self.client_secret.expose();
        if secret.len() < 20 || secret.chars().any(char::is_whitespace) {
            return Err("The OAuth client_secret looks incomplete.".into());
        }
        Ok(())
    }
}

/// Tokens from a successful sign-in. Times are Unix seconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: Secret,
    pub access_expires_at: i64,
    pub refresh_token: Secret,
    pub refresh_expires_at: i64,
    /// The player's Bungie.net membership id.
    pub membership_id: String,
}

impl Tokens {
    pub fn access_valid(&self, now: i64) -> bool {
        now + REFRESH_MARGIN_SECS < self.access_expires_at
    }

    pub fn refresh_valid(&self, now: i64) -> bool {
        now < self.refresh_expires_at
    }
}

/// A sign-in ParaForge has started and is waiting to hear back about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingSignIn {
    state: Secret,
    pub url: Url,
}

impl PendingSignIn {
    /// Builds the Bungie sign-in address with a fresh random `state` to tie the reply to this request.
    pub fn start(client_id: &str) -> Result<Self, AuthError> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| AuthError::Random(e.to_string()))?;
        let state = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        Ok(Self::with_state(client_id, state))
    }

    fn with_state(client_id: &str, state: String) -> Self {
        let mut url = Url::parse(AUTHORIZE_URL).expect("valid constant URL");
        url.query_pairs_mut()
            .append_pair("client_id", client_id)
            .append_pair("response_type", "code")
            .append_pair("state", &state);
        Self { state: Secret(state), url }
    }

    /// Checks a `paraforge://auth?...` reply and returns the authorization code.
    pub fn accept(&self, callback: &str) -> Result<Secret, AuthError> {
        let url = Url::parse(callback).map_err(|_| AuthError::NotOurCallback)?;
        if url.scheme() != "paraforge" || url.host_str() != Some("auth") {
            return Err(AuthError::NotOurCallback);
        }
        let mut code = None;
        let mut state = None;
        let mut error = None;
        for (k, v) in url.query_pairs() {
            match k.as_ref() {
                "code" => code = Some(v.into_owned()),
                "state" => state = Some(v.into_owned()),
                "error" | "error_description" => error = Some(v.into_owned()),
                _ => {}
            }
        }
        if !constant_time_eq(state.as_deref().unwrap_or("").as_bytes(), self.state.0.as_bytes()) {
            return Err(AuthError::StateMismatch);
        }
        if let Some(e) = error {
            return Err(AuthError::Denied(e));
        }
        code.filter(|c| !c.is_empty()).map(Secret).ok_or(AuthError::MissingCode)
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: String,
    expires_in: i64,
    refresh_token: Option<String>,
    refresh_expires_in: Option<i64>,
    membership_id: String,
}

#[derive(Deserialize)]
struct ErrorReply {
    error: Option<String>,
    error_description: Option<String>,
}

/// Turns Bungie's token endpoint reply into [`Tokens`]. `now` is Unix seconds at request time.
pub fn parse_token_reply(status: u16, body: &str, now: i64) -> Result<Tokens, AuthError> {
    if !(200..300).contains(&status) {
        let reply = serde_json::from_str::<ErrorReply>(body).ok();
        // invalid_grant: the code or refresh token is no longer accepted, so the player signs in again.
        if reply.as_ref().and_then(|e| e.error.as_deref()) == Some("invalid_grant") {
            return Err(AuthError::SignInExpired);
        }
        let message = reply.and_then(|e| e.error_description.or(e.error)).unwrap_or_else(|| format!("HTTP {status}"));
        return Err(AuthError::Rejected { status, message });
    }
    let reply: TokenReply = serde_json::from_str(body).map_err(|e| AuthError::BadReply(e.to_string()))?;
    let (Some(refresh), Some(refresh_in)) = (reply.refresh_token, reply.refresh_expires_in) else {
        return Err(AuthError::BadReply("no refresh token; the Bungie app must be set to Confidential".into()));
    };
    Ok(Tokens {
        access_token: Secret(reply.access_token),
        access_expires_at: now + reply.expires_in,
        refresh_token: Secret(refresh),
        refresh_expires_at: now + refresh_in,
        membership_id: reply.membership_id,
    })
}

/// Talks to Bungie's token endpoint.
pub struct AuthClient {
    http: reqwest::Client,
    token_url: String,
}

impl AuthClient {
    pub fn new() -> Result<Self, AuthError> {
        Self::with_token_url(TOKEN_URL)
    }

    /// For tests against a local server.
    pub fn with_token_url(token_url: &str) -> Result<Self, AuthError> {
        let http =
            reqwest::Client::builder().user_agent(USER_AGENT).timeout(std::time::Duration::from_secs(30)).build()?;
        Ok(Self { http, token_url: token_url.to_string() })
    }

    /// Swaps the sign-in code for tokens.
    pub async fn exchange_code(&self, app: &AppCredentials, code: &Secret, now: i64) -> Result<Tokens, AuthError> {
        self.token_request(app, &[("grant_type", "authorization_code"), ("code", code.expose())], now).await
    }

    /// Gets a fresh access token. Fails with [`AuthError::SignInExpired`] once the refresh token is too old.
    pub async fn refresh(&self, app: &AppCredentials, tokens: &Tokens, now: i64) -> Result<Tokens, AuthError> {
        if !tokens.refresh_valid(now) {
            return Err(AuthError::SignInExpired);
        }
        self.token_request(
            app,
            &[("grant_type", "refresh_token"), ("refresh_token", tokens.refresh_token.expose())],
            now,
        )
        .await
    }

    async fn token_request(&self, app: &AppCredentials, form: &[(&str, &str)], now: i64) -> Result<Tokens, AuthError> {
        let response = self
            .http
            .post(&self.token_url)
            .basic_auth(&app.client_id, Some(app.client_secret.expose()))
            .header("X-API-Key", app.api_key.expose())
            .form(form)
            .send()
            .await?;
        let status = response.status().as_u16();
        let body = response.text().await?;
        parse_token_reply(status, &body, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> AppCredentials {
        AppCredentials {
            api_key: Secret::new("0123456789abcdef0123456789abcdef"),
            client_id: "12345".into(),
            client_secret: Secret::new("s3cr3t-s3cr3t-s3cr3t-s3cr3t"),
        }
    }

    // Shape of a real Bungie reply, values invented.
    const GOOD_REPLY: &str = r#"{"access_token":"AT","token_type":"Bearer","expires_in":3600,
        "refresh_token":"RT","refresh_expires_in":7776000,"membership_id":"4611686018400000000"}"#;

    #[test]
    fn secrets_do_not_show_in_debug() {
        let text = format!("{:?}", app());
        assert!(!text.contains("0123456789abcdef"), "{text}");
        assert!(!text.contains("s3cr3t"), "{text}");
        let tokens = parse_token_reply(200, GOOD_REPLY, 0).unwrap();
        let text = format!("{tokens:?}");
        assert!(!text.contains("\"AT\"") && !text.contains("\"RT\""), "{text}");
    }

    #[test]
    fn validates_pasted_keys() {
        assert!(app().validate().is_ok());
        let mut bad = app();
        bad.api_key = Secret::new("not a key");
        assert!(bad.validate().is_err());
        let mut bad = app();
        bad.client_id = "abc".into();
        assert!(bad.validate().is_err());
        let mut bad = app();
        bad.client_secret = Secret::new("short");
        assert!(bad.validate().is_err());
    }

    #[test]
    fn sign_in_url_has_client_and_state() {
        let p = PendingSignIn::start("12345").unwrap();
        let q: Vec<(String, String)> = p.url.query_pairs().into_owned().collect();
        assert!(p.url.as_str().starts_with(AUTHORIZE_URL));
        assert!(q.contains(&("client_id".into(), "12345".into())));
        assert!(q.contains(&("response_type".into(), "code".into())));
        let state = &q.iter().find(|(k, _)| k == "state").unwrap().1;
        assert_eq!(state.len(), 43, "32 random bytes, base64url");
        assert_ne!(PendingSignIn::start("12345").unwrap().url, p.url, "state is random");
    }

    #[test]
    fn accepts_only_the_matching_reply() {
        let p = PendingSignIn::with_state("1", "abc".into());
        assert_eq!(p.accept("paraforge://auth?code=XYZ&state=abc").unwrap(), Secret::new("XYZ"));
        assert!(matches!(p.accept("paraforge://auth?code=XYZ&state=abd"), Err(AuthError::StateMismatch)));
        assert!(matches!(p.accept("paraforge://auth?code=XYZ"), Err(AuthError::StateMismatch)));
        assert!(matches!(p.accept("paraforge://auth?state=abc"), Err(AuthError::MissingCode)));
        assert!(matches!(p.accept("paraforge://auth?error=access_denied&state=abc"), Err(AuthError::Denied(_))));
        assert!(matches!(p.accept("https://evil.example/auth?code=X&state=abc"), Err(AuthError::NotOurCallback)));
        assert!(matches!(p.accept("paraforge://other?code=X&state=abc"), Err(AuthError::NotOurCallback)));
        assert!(matches!(p.accept("not a url"), Err(AuthError::NotOurCallback)));
    }

    #[test]
    fn parses_token_replies() {
        let t = parse_token_reply(200, GOOD_REPLY, 1_000).unwrap();
        assert_eq!(t.access_token.expose(), "AT");
        assert_eq!(t.access_expires_at, 4_600);
        assert_eq!(t.refresh_expires_at, 1_000 + 7_776_000);
        assert_eq!(t.membership_id, "4611686018400000000");
        assert!(t.access_valid(1_000));
        assert!(!t.access_valid(4_400), "refresh 5 minutes early");
        assert!(t.refresh_valid(4_400));
    }

    #[test]
    fn public_app_reply_is_explained() {
        let body = r#"{"access_token":"AT","token_type":"Bearer","expires_in":3600,"membership_id":"1"}"#;
        let err = parse_token_reply(200, body, 0).unwrap_err();
        assert!(err.to_string().contains("Confidential"), "{err}");
    }

    #[test]
    fn expired_refresh_means_sign_in_again() {
        let body = r#"{"error":"invalid_grant","error_description":"ApplicationTokenKeyIdDoesNotExist"}"#;
        assert!(matches!(parse_token_reply(400, body, 0), Err(AuthError::SignInExpired)));
        let body = r#"{"error":"invalid_client","error_description":"AuthorizationCodeInvalid"}"#;
        match parse_token_reply(400, body, 0) {
            Err(AuthError::Rejected { status: 400, message }) => assert_eq!(message, "AuthorizationCodeInvalid"),
            other => panic!("{other:?}"),
        }
        assert!(matches!(parse_token_reply(503, "<html>", 0), Err(AuthError::Rejected { status: 503, .. })));
    }

    /// One-shot local HTTP server that records the request and returns `reply`.
    async fn serve_once(reply: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let mut request = String::new();
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                request.push_str(&String::from_utf8_lossy(&buf[..n]));
                if let Some(end) = request.find("\r\n\r\n") {
                    let len = request[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                reply.len()
            );
            sock.write_all(response.as_bytes()).await.unwrap();
            request
        });
        (format!("http://{addr}/token/"), handle)
    }

    #[tokio::test]
    async fn exchange_sends_confidential_client_request() {
        let (url, server) = serve_once(GOOD_REPLY).await;
        let client = AuthClient::with_token_url(&url).unwrap();
        let tokens = client.exchange_code(&app(), &Secret::new("CODE123"), 50).await.unwrap();
        assert_eq!(tokens.refresh_token.expose(), "RT");

        let request = server.await.unwrap();
        let lower = request.to_ascii_lowercase();
        let basic = base64::engine::general_purpose::STANDARD.encode("12345:s3cr3t-s3cr3t-s3cr3t-s3cr3t");
        assert!(request.starts_with("POST /token/ "), "{request}");
        assert!(request.contains(&format!("Basic {basic}")), "client id and secret go in basic auth");
        assert!(lower.contains("x-api-key: 0123456789abcdef0123456789abcdef"));
        assert!(lower.contains("user-agent: paraforge/"));
        assert!(request.ends_with("grant_type=authorization_code&code=CODE123"), "{request}");
    }

    #[tokio::test]
    async fn refresh_uses_refresh_token_and_refuses_when_expired() {
        let (url, server) = serve_once(GOOD_REPLY).await;
        let client = AuthClient::with_token_url(&url).unwrap();
        let old = parse_token_reply(200, GOOD_REPLY, 0).unwrap();
        client.refresh(&app(), &old, 4_000).await.unwrap();
        assert!(server.await.unwrap().ends_with("grant_type=refresh_token&refresh_token=RT"));

        let err = client.refresh(&app(), &old, old.refresh_expires_at).await.unwrap_err();
        assert!(matches!(err, AuthError::SignInExpired));
    }
}
