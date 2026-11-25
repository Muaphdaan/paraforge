//! Downloads the community god-roll list "voltron" (48klocs/dim-wish-list-sources, MIT), the same
//! list DIM offers by default. Parsing lives in `paraforge_core::wishlist`.

use std::time::Duration;

use crate::USER_AGENT;

/// The raw voltron list on GitHub.
pub const VOLTRON_URL: &str = "https://raw.githubusercontent.com/48klocs/dim-wish-list-sources/master/voltron.txt";

/// The list is about 30 MB; anything far larger is not a wish list.
const MAX_BYTES: usize = 200 * 1024 * 1024;

/// What a check for a new list found.
#[derive(Debug)]
pub enum Fetched {
    /// The list has not changed since the copy with the given ETag.
    Unchanged,
    /// A new list, with its ETag for the next check.
    New { text: String, etag: Option<String> },
}

/// Fetches the list unless it still matches `etag`. Errors are written for the player.
pub async fn fetch(url: &str, etag: Option<&str>) -> Result<Fetched, String> {
    let reach = |e: reqwest::Error| format!("could not download the god-roll list: {e}");
    let http = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(reach)?;
    let mut req = http.get(url);
    if let Some(tag) = etag {
        req = req.header(reqwest::header::IF_NONE_MATCH, tag);
    }
    let mut resp = req.send().await.map_err(reach)?;
    let status = resp.status().as_u16();
    if status == 304 {
        return Ok(Fetched::Unchanged);
    }
    if !(200..300).contains(&status) {
        return Err(format!("could not download the god-roll list (HTTP {status})"));
    }
    let etag = resp.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(reach)? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BYTES {
            return Err("the god-roll list is far larger than expected, so it was not used".into());
        }
    }
    let text = String::from_utf8_lossy(&body).into_owned();
    if !text.contains("dimwishlist:") {
        return Err("the god-roll list did not look like a wish list, so it was not used".into());
    }
    Ok(Fetched::New { text, etag })
}
