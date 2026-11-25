//! In-app updates from this repository's rolling "test-build" release.
//!
//! CI publishes `latest.json` (version, installer address, SHA-256) next to the installer. ParaForge
//! reads it, downloads the installer only from that release, checks its SHA-256, and runs it in
//! passive mode, which updates ParaForge in place and starts it again. The addresses are fixed here,
//! so the interface can never point ParaForge at another download.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

const RELEASE_URL: &str = "https://github.com/Muaphdaan/paraforge/releases/download/test-build/";
const MANIFEST: &str = "latest.json";
const USER_AGENT: &str = concat!("ParaForge/", env!("CARGO_PKG_VERSION"), " (updater)");

#[derive(Default)]
pub struct UpdateState {
    /// The downloaded and checked installer, ready to run.
    ready: Mutex<Option<(String, PathBuf)>>,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    version: String,
    url: String,
    sha256: String,
}

#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    version: String,
}

/// "0.1.57" as numbers, so 0.1.100 sorts after 0.1.99.
fn version_key(v: &str) -> Option<Vec<u64>> {
    v.trim().split('.').map(|p| p.parse().ok()).collect()
}

fn is_newer(candidate: &str, current: &str) -> bool {
    match (version_key(candidate), version_key(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// Only installers in this repository's test-build release, with a plain file name.
fn allowed_url(url: &str) -> bool {
    url.strip_prefix(RELEASE_URL).is_some_and(|name| {
        name.ends_with(".exe")
            && !name.is_empty()
            && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    })
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

async fn manifest(http: &reqwest::Client) -> Result<Manifest, String> {
    let resp = http
        .get(format!("{RELEASE_URL}{MANIFEST}"))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("could not reach GitHub: {e}"))?;
    if resp.status().as_u16() == 404 {
        return Err("no test build has been published yet".into());
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub answered {}", resp.status().as_u16()));
    }
    resp.json().await.map_err(|e| format!("unexpected update details: {e}"))
}

/// Looks for a newer build and, when there is one, downloads and checks it. Returns its version,
/// or nothing when ParaForge is up to date.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, UpdateState>) -> Result<Option<UpdateInfo>, String> {
    let current = app.package_info().version.to_string();
    let http = client()?;
    let m = manifest(&http).await?;
    if !is_newer(&m.version, &current) {
        return Ok(None);
    }
    if let Some((version, path)) = state.ready.lock().map_err(|e| e.to_string())?.as_ref()
        && *version == m.version
        && path.exists()
    {
        return Ok(Some(UpdateInfo { version: version.clone() }));
    }
    if !allowed_url(&m.url) {
        return Err("the update points somewhere other than ParaForge's releases, so it was ignored".into());
    }
    let expected = m.sha256.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("the update has no valid checksum, so it was ignored".into());
    }

    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("ParaForge-{}-setup.exe", m.version.replace(|c: char| !c.is_ascii_digit(), "_")));
    let partial = dest.with_extension("part");

    let mut resp = http.get(&m.url).send().await.map_err(|e| format!("could not download the update: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("could not download the update (GitHub answered {})", resp.status().as_u16()));
    }
    let result: Result<String, String> = async {
        let mut file = std::io::BufWriter::new(std::fs::File::create(&partial).map_err(|e| e.to_string())?);
        let mut hash = Sha256::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("the download stopped: {e}"))? {
            hash.update(&chunk);
            file.write_all(&chunk).map_err(|e| e.to_string())?;
        }
        file.into_inner().map_err(|e| e.into_error().to_string())?.sync_all().map_err(|e| e.to_string())?;
        Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
    }
    .await;
    let got = match result {
        Ok(got) => got,
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            return Err(e);
        }
    };
    if got != expected {
        let _ = std::fs::remove_file(&partial);
        return Err("the downloaded update did not match its checksum, so it was thrown away".into());
    }
    std::fs::rename(&partial, &dest).map_err(|e| e.to_string())?;
    // Older downloads are no longer needed.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.path() != dest {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    *state.ready.lock().map_err(|e| e.to_string())? = Some((m.version.clone(), dest));
    Ok(Some(UpdateInfo { version: m.version }))
}

/// Runs the downloaded installer (passive: a progress bar, no questions) and closes ParaForge; the
/// installer starts ParaForge again when it is done.
#[tauri::command]
pub fn update_install(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let ready = state.ready.lock().map_err(|e| e.to_string())?.clone();
    let (_, path) = ready.ok_or("No update has been downloaded yet.")?;
    if !path.exists() {
        return Err("The downloaded update is gone. Check for updates again.".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new(&path)
            .args(["/P", "/R", "/UPDATE"])
            .spawn()
            .map_err(|e| format!("could not start the installer: {e}"))?;
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Updates install on Windows only.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_numbers() {
        assert!(is_newer("0.1.100", "0.1.99"));
        assert!(is_newer("0.1.57", "0.1.0"));
        assert!(!is_newer("0.1.57", "0.1.57"));
        assert!(!is_newer("garbage", "0.1.0"));
    }

    #[test]
    fn only_our_release_installers_are_allowed() {
        assert!(allowed_url(&format!("{RELEASE_URL}ParaForge_0.1.57_x64-setup.exe")));
        assert!(!allowed_url("https://example.com/ParaForge_0.1.57_x64-setup.exe"));
        assert!(!allowed_url(&format!("{RELEASE_URL}../other/x.exe")));
        assert!(!allowed_url(&format!("{RELEASE_URL}latest.json")));
        assert!(!allowed_url(&format!("{RELEASE_URL}x.exe?y=1")));
    }
}
