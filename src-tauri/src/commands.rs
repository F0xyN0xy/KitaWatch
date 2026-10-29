//! Tauri commands.
//!
//! exchange_anilist_token: OAuth code exchange. Runs in Rust so the client
//! secret never ships in frontend code. Credentials come from environment
//! variables (.env in dev) and fall back to values supplied by the frontend
//! (the user's Settings) — the latter is what makes the installed app work,
//! where no .env exists.
//!
//! collect_debug_report: one-click diagnostics for end users. Bundles sidecar
//! presence, port/HTTP probes, startup notes and recent sidecar logs into a
//! single paste-able string (Settings → "Copy debug report").

use serde_json::json;
use std::io::{Read as _, Write as _};
use futures_util::StreamExt;
use std::net::TcpStream;
use std::time::Duration;
use tauri::Manager;

macro_rules! push {
    ($r:expr, $($arg:tt)*) => {{
        $r.push_str(&format!($($arg)*));
        $r.push('\n');
    }};
}

fn env_or(key: &str, fallback: Option<String>) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .or(fallback)
        .unwrap_or_default()
}

#[tauri::command]
pub async fn exchange_anilist_token(
    app: tauri::AppHandle,
    code: String,
    client_id: Option<String>,
    client_secret: Option<String>,
    redirect_uri: Option<String>,
) -> Result<String, String> {
    // Load .env from resource dir (Linux AppImage/deb need this) + exe dir + cwd
    if let Ok(res_dir) = app.path().resource_dir() {
        crate::config::load_with_resource_dir(&res_dir);
    } else {
        crate::config::load();
    }

    let cid = env_or("ANILIST_CLIENT_ID", client_id);
    let csec = env_or("ANILIST_CLIENT_SECRET", client_secret);
    let ruri = redirect_uri
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| env_or("ANILIST_REDIRECT_URI", None));

    if cid.is_empty() || csec.is_empty() {
        eprintln!("[kitawatch] anilist token exchange: missing credentials (cid_empty={}, csec_empty={})", cid.is_empty(), csec.is_empty());
    }

    let res = reqwest::Client::new()
        .post("https://anilist.co/api/v2/oauth/token")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&json!({
            "grant_type": "authorization_code",
            "client_id": cid,
            "client_secret": csec,
            "redirect_uri": ruri,
            "code": code,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        // Surface AniList's error body (e.g. invalid_grant) for diagnostics
        if body.is_empty() {
            return Err(format!("AniList responded {}", status));
        } else {
            let preview: String = body.chars().take(300).collect();
            return Err(format!("AniList responded {}: {}", status, preview));
        }
    }
    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    json["access_token"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| "AniList returned no access_token".to_string())
}


/// Download a direct, non-HLS MP4 file into KitaWatch's app-data downloads folder.
/// Only HTTPS video/mp4 or application/octet-stream responses are accepted; HLS
/// manifests, embedded players, and non-HTTPS URLs are deliberately unsupported.
#[tauri::command]
pub async fn download_episode(
    app: tauri::AppHandle,
    url: String,
    filename: String,
    referer: Option<String>,
) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid download URL".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Downloads require a public HTTPS media URL".to_string());
    }

    let safe_stem: String = filename
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(80)
        .collect();
    let safe_stem = if safe_stem.is_empty() { "episode-download".to_string() } else { safe_stem };
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("downloads");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(Duration::from_secs(60 * 60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.get(parsed);
    if let Some(value) = referer {
        if let Ok(referer_url) = reqwest::Url::parse(&value) {
            if matches!(referer_url.scheme(), "https" | "http") && referer_url.host_str().is_some() {
                if let Ok(header) = reqwest::header::HeaderValue::from_str(referer_url.as_str()) {
                    request = request.header(reqwest::header::REFERER, header);
                }
            }
        }
    }

    let response = request.send().await.map_err(|e| format!("Download request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Media server returned {}", response.status()));
    }
    if response.url().scheme() != "https" {
        return Err("The media server redirected to a non-HTTPS URL; download cancelled".to_string());
    }
    let content_type = response.headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if content_type != "video/mp4" && content_type != "application/octet-stream" {
        return Err(format!("Unsupported media type: {}. Only direct MP4 files can be saved.", if content_type.is_empty() { "unknown" } else { &content_type }));
    }

    const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
    if response.content_length().is_some_and(|size| size > MAX_BYTES) {
        return Err("This file exceeds the 2 GiB download limit".to_string());
    }

    let temp_path = directory.join(format!("{safe_stem}.mp4.part"));
    let mut file = std::fs::File::create(&temp_path).map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut written: u64 = 0;
    let stream_result: Result<(), String> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
            written = written.saturating_add(chunk.len() as u64);
            if written > MAX_BYTES {
                return Err("This file exceeds the 2 GiB download limit".to_string());
            }
            file.write_all(&chunk).map_err(|e| e.to_string())?;
        }
        file.flush().map_err(|e| e.to_string())?;
        Ok(())
    }.await;
    drop(file);
    if let Err(error) = stream_result {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error);
    }
    if written == 0 {
        let _ = std::fs::remove_file(&temp_path);
        return Err("The media server returned an empty file".to_string());
    }

    let mut target = directory.join(format!("{safe_stem}.mp4"));
    let mut suffix = 2;
    while target.exists() {
        target = directory.join(format!("{safe_stem}-{suffix}.mp4"));
        suffix += 1;
    }
    std::fs::rename(&temp_path, &target).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        e.to_string()
    })?;
    Ok(target.to_string_lossy().into_owned())
}

/// Probe one local port: TCP connect + tiny HTTP GET (status + body prefix).
async fn probe(addr: &str, client: &reqwest::Client) -> String {
    let tcp = addr
        .parse()
        .ok()
        .and_then(|a| TcpStream::connect_timeout(&a, Duration::from_millis(500)).ok())
        .is_some();
    if !tcp {
        return format!("{addr}: CLOSED (nothing listening)");
    }
    let url = format!("http://{addr}/");
    match client.get(&url).send().await {
        Ok(res) => {
            let status = res.status();
            let ctype = res
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("?")
                .to_string();
            let body = res.text().await.unwrap_or_default();
            let preview: String = body.chars().filter(|c| *c != '\n').take(80).collect();
            format!("{addr}: OPEN — GET / -> {status} ({ctype}) body[:80]={preview:?}")
        }
        Err(e) => format!("{addr}: OPEN — but HTTP GET failed: {e}"),
    }
}

/// Tail the last `max_lines` of a log file.
fn tail(path: &std::path::Path, max_lines: usize) -> String {
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

#[tauri::command]
pub async fn collect_debug_report(app: tauri::AppHandle) -> Result<String, String> {
    if let Ok(res_dir) = app.path().resource_dir() {
        crate::config::load_with_resource_dir(&res_dir);
    } else {
        crate::config::load();
    }
    let mut r = String::new();

    push!(r, "KitaWatch v{} — debug report", env!("CARGO_PKG_VERSION"));
    push!(
        r,
        "os={} arch={} debug_flag={}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        crate::api_sidecar::debug_mode()
    );
    push!(r, "log_dir={}", crate::api_sidecar::log_dir(&app).display());
    if let Ok(res_dir) = app.path().resource_dir() {
        push!(r, "resource_dir={}", res_dir.display());
        // list resource_dir contents (helps diagnose missing .env)
        match std::fs::read_dir(&res_dir) {
            Ok(entries) => {
                let mut files: Vec<String> = Vec::new();
                for e in entries.flatten() {
                    let p = e.path();
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("?");
                    let is_dir = if p.is_dir() { "/" } else { "" };
                    files.push(format!("{name}{is_dir}"));
                }
                files.sort();
                push!(r, "resource_dir_contents={}", files.join(", "));
                // check nested resources/.env
                let nested = res_dir.join("resources/.env");
                push!(r, "resources/.env exists={}", nested.exists());
            }
            Err(e) => push!(r, "resource_dir read error: {e}"),
        }
        push!(r, ".env at resource_dir/.env exists={}", res_dir.join(".env").exists());
    } else {
        push!(r, "resource_dir=FAILED to resolve");
    }
    // check .env at exe dir
    if let Ok(mut exe) = std::env::current_exe() {
        exe.pop();
        push!(r, "exe_dir={}", exe.display());
        push!(r, "exe_dir/.env exists={}", exe.join(".env").exists());
        push!(r, "exe_dir/resources/.env exists={}", exe.join("resources/.env").exists());
    }
    if let Ok(v) = std::env::var("ANILIST_CLIENT_ID") {
        push!(r, "ANILIST_CLIENT_ID len={} prefix={}", v.len(), &v[..v.len().min(4)]);
        // also check if .env was loaded but empty
        if v.is_empty() {
            push!(r, "WARNING: ANILIST_CLIENT_ID is empty - .env exists but value empty (GitHub secrets missing?)");
        }
    } else {
        push!(r, "ANILIST_CLIENT_ID env not set at all");
    }
    if let Ok(v) = std::env::var("ANILIST_CLIENT_SECRET") {
        push!(r, "ANILIST_CLIENT_SECRET len={}", v.len());
        if v.is_empty() {
            push!(r, "WARNING: ANILIST_CLIENT_SECRET empty");
        }
    } else {
        push!(r, "ANILIST_CLIENT_SECRET env not set");
    }
    if let Ok(v) = std::env::var("ANILIST_REDIRECT_URI") {
        push!(r, "ANILIST_REDIRECT_URI={}", v);
    } else {
        push!(r, "ANILIST_REDIRECT_URI not set");
    }
    r.push('\n');

    // --- bundled sidecar binaries (exe dir + resource dir) -----------------
    push!(r, "[sidecar binaries]");
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let mut candidates_base: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(mut exe) = std::env::current_exe() {
        exe.pop();
        candidates_base.push(exe.clone());
        candidates_base.push(exe.join("binaries"));
    }
    if let Ok(res_dir) = app.path().resource_dir() {
        candidates_base.push(res_dir.clone());
        candidates_base.push(res_dir.join("binaries"));
    }
    // Linux specific fallbacks (deb/appimage layouts)
    for extra in ["../lib/kitawatch", "../lib/com.kitawatch.app"] {
        if let Ok(mut exe) = std::env::current_exe() {
            exe.pop();
            candidates_base.push(exe.join(extra));
            candidates_base.push(exe.join(format!("{extra}/resources")));
        }
    }
    for name in ["kitawatch-kuhi-api", "kitawatch-proxy", "kitawatch-anivexa"] {
        let mut found = None;
        for base in &candidates_base {
            for cand in [
                base.join(format!("{name}{ext}")),
                base.join(format!("{}-{}{}", name, crate::api_sidecar::SIDE_TRIPLE, ext)),
            ] {
                if cand.exists() {
                    found = Some(cand);
                    break;
                }
            }
            if found.is_some() { break; }
        }
        match found {
            Some(p) => {
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let executable = {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::metadata(&p).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
                    }
                    #[cfg(not(unix))]
                    { true }
                };
                push!(r, "  {name}: FOUND ({}, {} bytes, executable={})", p.display(), size, executable);
            }
            None => {
                let searched = candidates_base.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ");
                push!(r, "  {name}: MISSING (searched: {})", searched);
            }
        }
    }
    r.push('\n');

    // --- port + HTTP probes --------------------------------------------------
    push!(r, "[port probes]");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;
    for addr in ["127.0.0.1:8000", "127.0.0.1:8001", "127.0.0.1:4000"] {
        push!(r, "  {}", probe(addr, &client).await);
    }
    r.push('\n');

    // --- startup notes (why a sidecar was not started) -----------------------
    let notes = crate::api_sidecar::startup_notes();
    push!(r, "[startup notes]");
    if notes.is_empty() {
        push!(r, "  (none — all sidecars spawned normally)");
    } else {
        for n in notes {
            push!(r, "  {n}");
        }
    }
    r.push('\n');

    // --- recent sidecar logs --------------------------------------------------
    push!(r, "[recent sidecar logs]");
    let dir = crate::api_sidecar::log_dir(&app);
    match std::fs::read_dir(&dir) {
        Ok(entries) => {
            let mut any = false;
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "log") {
                    any = true;
                    push!(r, "--- {} (last 60 lines) ---", path.display());
                    r.push_str(&tail(&path, 60));
                    r.push('\n');
                }
            }
            if !any {
                push!(r, "  (no .log files in {})", dir.display());
            }
        }
        Err(e) => push!(r, "  cannot read {}: {e}", dir.display()),
    }

    Ok(r)
}

// ─── Discord Rich Presence ──────────────────────────────────────────────────

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use std::sync::Mutex;

static DISCORD_CLIENT: Mutex<Option<DiscordIpcClient>> = Mutex::new(None);

#[tauri::command]
pub fn discord_presence_set(
    app_id: String,
    details: String,
    state: Option<String>,
    start_unix: Option<i64>,
) -> Result<(), String> {
    let mut guard = DISCORD_CLIENT.lock().map_err(|e| e.to_string())?;

    if guard.is_none() {
        let mut client = DiscordIpcClient::new(&app_id);
        client.connect().map_err(|e| e.to_string())?;
        *guard = Some(client);
    }

    let client = guard.as_mut().ok_or("Discord client not initialized")?;

    let mut act = activity::Activity::new().details(&details);

    if let Some(ref s) = state {
        act = act.state(s);
    }

    if let Some(ts) = start_unix {
        act = act.timestamps(activity::Timestamps::new().start(ts));
    }

    if client.set_activity(act).is_err() {
        let mut client = DiscordIpcClient::new(&app_id);
        client.connect().map_err(|e| e.to_string())?;
        let mut act = activity::Activity::new().details(&details);
        if let Some(ref s) = state {
            act = act.state(s);
        }
        if let Some(ts) = start_unix {
            act = act.timestamps(activity::Timestamps::new().start(ts));
        }
        client.set_activity(act).map_err(|e| e.to_string())?;
        *guard = Some(client);
    }

    Ok(())
}

#[tauri::command]
pub fn discord_presence_clear() -> Result<(), String> {
    let mut guard = DISCORD_CLIENT.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut client) = *guard {
        let _ = client.clear_activity();
        let _ = client.close();
    }
    *guard = None;
    Ok(())
}