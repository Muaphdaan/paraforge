//! Bungie sign-in for the desktop app.
//!
//! App keys and tokens live only here and in the OS credential store (Windows Credential Manager).
//! The interface gets yes/no status and a membership id, never a key or a token.

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use keyring_core::Entry;
use paraforge_bungie::{
    AppCredentials, AuthClient, AuthError, Callback, PendingSignIn, Secret, Tokens, normalize_client_id,
    resolve_callback,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

const SERVICE: &str = "ParaForge";
const APP_KEYS: &str = "bungie-app-keys";
// Tokens are split across two entries: a Windows credential holds at most 2560 bytes.
const ACCESS: &str = "bungie-access";
const REFRESH: &str = "bungie-refresh";

pub struct AuthState {
    pending: Mutex<Option<PendingSignIn>>,
    client: AuthClient,
    /// Serialises refreshes so two callers do not both spend the refresh token.
    refresh_lock: tokio::sync::Mutex<()>,
}

impl AuthState {
    pub fn new() -> Result<Self, AuthError> {
        Ok(Self { pending: Mutex::new(None), client: AuthClient::new()?, refresh_lock: tokio::sync::Mutex::new(()) })
    }
}

/// Picks the OS credential store. Windows Credential Manager on Windows; an in-memory
/// store elsewhere, which is only for development on other systems.
pub fn init_credential_store() -> Result<(), String> {
    #[cfg(windows)]
    let store: Arc<keyring_core::CredentialStore> =
        windows_native_keyring_store::Store::new().map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    let store: Arc<keyring_core::CredentialStore> = keyring_core::mock::Store::new().map_err(|e| e.to_string())?;
    keyring_core::set_default_store(store);
    Ok(())
}

fn load<T: serde::de::DeserializeOwned>(user: &str) -> Result<Option<T>, String> {
    let entry = Entry::new(SERVICE, user).map_err(|e| e.to_string())?;
    match entry.get_secret() {
        Ok(json) => serde_json::from_slice(&json).map(Some).map_err(|e| e.to_string()),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn save<T: Serialize>(user: &str, value: &T) -> Result<(), String> {
    let json = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    Entry::new(SERVICE, user).and_then(|e| e.set_secret(&json)).map_err(|e| e.to_string())
}

fn delete(user: &str) -> Result<(), String> {
    match Entry::new(SERVICE, user).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Serialize, serde::Deserialize)]
struct AccessPart {
    access_token: Secret,
    access_expires_at: i64,
}

#[derive(Serialize, serde::Deserialize)]
struct RefreshPart {
    refresh_token: Secret,
    refresh_expires_at: i64,
    membership_id: String,
}

fn load_tokens() -> Result<Option<Tokens>, String> {
    let (Some(r), Some(a)) = (load::<RefreshPart>(REFRESH)?, load::<AccessPart>(ACCESS)?) else {
        return Ok(None);
    };
    Ok(Some(Tokens {
        access_token: a.access_token,
        access_expires_at: a.access_expires_at,
        refresh_token: r.refresh_token,
        refresh_expires_at: r.refresh_expires_at,
        membership_id: r.membership_id,
    }))
}

fn save_tokens(t: &Tokens) -> Result<(), String> {
    save(
        REFRESH,
        &RefreshPart {
            refresh_token: t.refresh_token.clone(),
            refresh_expires_at: t.refresh_expires_at,
            membership_id: t.membership_id.clone(),
        },
    )?;
    save(ACCESS, &AccessPart { access_token: t.access_token.clone(), access_expires_at: t.access_expires_at })
}

fn delete_tokens() -> Result<(), String> {
    delete(ACCESS)?;
    delete(REFRESH)
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthStatus {
    has_app_keys: bool,
    signed_in: bool,
    membership_id: Option<String>,
    /// Unix seconds when the player has to sign in again.
    sign_in_expires_at: Option<i64>,
}

fn status() -> Result<AuthStatus, String> {
    let has_app_keys = load::<AppCredentials>(APP_KEYS)?.is_some();
    let tokens = load_tokens()?.filter(|t| t.refresh_valid(now()));
    Ok(AuthStatus {
        has_app_keys,
        signed_in: tokens.is_some(),
        membership_id: tokens.as_ref().map(|t| t.membership_id.clone()),
        sign_in_expires_at: tokens.as_ref().map(|t| t.refresh_expires_at),
    })
}

#[tauri::command]
pub fn auth_status() -> Result<AuthStatus, String> {
    status()
}

/// Saves the player's Bungie app keys. This is the only time a key passes through the interface.
#[tauri::command]
pub async fn save_app_keys(
    state: State<'_, AuthState>,
    api_key: String,
    client_id: String,
    client_secret: String,
) -> Result<AuthStatus, String> {
    let keys = AppCredentials {
        api_key: Secret::new(api_key.trim()),
        client_id: normalize_client_id(&client_id),
        client_secret: Secret::new(client_secret.trim()),
    };
    keys.validate()?;
    // Wait for any token refresh in flight, so it cannot write old tokens back afterwards.
    let _guard = state.refresh_lock.lock().await;
    save(APP_KEYS, &keys)?;
    // New keys invalidate tokens issued to the old app.
    delete_tokens()?;
    status()
}

#[tauri::command]
pub fn start_sign_in(app: AppHandle, state: State<'_, AuthState>) -> Result<(), String> {
    let keys = load::<AppCredentials>(APP_KEYS)?.ok_or("Add your Bungie app keys first.")?;
    let pending = PendingSignIn::start(&keys.client_id).map_err(|e| e.to_string())?;
    let url = pending.url.to_string();
    *state.pending.lock().map_err(|e| e.to_string())? = Some(pending);
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sign_out(state: State<'_, AuthState>) -> Result<AuthStatus, String> {
    // Wait for any token refresh in flight, so it cannot sign the user back in afterwards.
    let _guard = state.refresh_lock.lock().await;
    delete_tokens()?;
    status()
}

/// Handles a `paraforge://` address the OS hands to the app.
pub fn handle_deep_link(app: &AppHandle, url: String) {
    let state = app.state::<AuthState>();
    let outcome = match state.pending.lock() {
        Ok(mut pending) => resolve_callback(&mut pending, &url),
        Err(_) => return,
    };
    let code = match outcome {
        Callback::Code(code) => code,
        Callback::Failed(e) => {
            let _ = app.emit("auth-error", e.to_string());
            return;
        }
        // Not a reply to this sign-in: keep waiting for the real one. Never log the address, it may hold a code.
        Callback::Ignored(_) => return,
        Callback::NoneInProgress => {
            let _ = app.emit("auth-error", "No sign-in was in progress. Please start sign-in from ParaForge.");
            return;
        }
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let keys = load::<AppCredentials>(APP_KEYS)?.ok_or("Bungie app keys are missing.")?;
            let state = app.state::<AuthState>();
            let tokens = state.client.exchange_code(&keys, &code, now()).await.map_err(|e| e.to_string())?;
            save_tokens(&tokens)?;
            status()
        }
        .await;
        match result {
            Ok(status) => {
                let _ = app.emit("auth-changed", status);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
            }
            Err(e) => {
                let _ = app.emit("auth-error", e);
            }
        }
    });
}

/// A valid access token for Bungie API calls, refreshed if needed.
pub async fn access_token(state: &AuthState) -> Result<(AppCredentials, Tokens), String> {
    token_with_refresh(state, None).await
}

/// A new access token after Bungie rejected `rejected` early (it was revoked or the clock is off).
/// If another call already refreshed it, that newer token is returned instead.
pub async fn refresh_after_rejection(state: &AuthState, rejected: &Tokens) -> Result<(AppCredentials, Tokens), String> {
    token_with_refresh(state, Some(rejected)).await
}

async fn token_with_refresh(state: &AuthState, rejected: Option<&Tokens>) -> Result<(AppCredentials, Tokens), String> {
    let _guard = state.refresh_lock.lock().await;
    let keys = load::<AppCredentials>(APP_KEYS)?.ok_or("Add your Bungie app keys first.")?;
    let tokens = load_tokens()?.ok_or("Please sign in to Bungie.")?;
    let rejected_this_one = rejected.is_some_and(|r| r.access_token.expose() == tokens.access_token.expose());
    if tokens.access_valid(now()) && !rejected_this_one {
        return Ok((keys, tokens));
    }
    match state.client.refresh(&keys, &tokens, now()).await {
        Ok(fresh) => {
            save_tokens(&fresh)?;
            Ok((keys, fresh))
        }
        Err(AuthError::SignInExpired) => {
            delete_tokens()?;
            Err(AuthError::SignInExpired.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}
