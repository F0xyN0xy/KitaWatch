use std::env;
use std::path::PathBuf;

fn try_load(path: &PathBuf) -> bool {
    if path.exists() {
        match dotenvy::from_path(path) {
            Ok(_) => {
                eprintln!("[kitawatch] loaded .env from {}", path.display());
                return true;
            }
            Err(e) => eprintln!("[kitawatch] failed to load {}: {e}", path.display()),
        }
    } else {
        eprintln!("[kitawatch] .env not found at {}", path.display());
    }
    false
}

pub fn load() {
    let mut loaded = false;
    // 1) Next to the executable (Windows installer, dev)
    if let Ok(mut p) = std::env::current_exe() {
        p.pop();
        p.push(".env");
        loaded |= try_load(&p);
        // 1b) Linux bundle layouts: exe in /usr/bin, resources in /usr/lib/<app>/resources or ../lib/<app>
        for rel in [
            "resources/.env",
            "../lib/KitaWatch/.env",
            "../lib/KitaWatch/resources/.env",
            "../lib/kitawatch/.env",
            "../lib/kitawatch/resources/.env",
            "../lib/com.kitawatch.app/.env",
            "../lib/com.kitawatch.app/resources/.env",
            "../share/KitaWatch/.env",
            "../share/kitawatch/.env",
        ] {
            if let Ok(mut exe) = std::env::current_exe() {
                exe.pop();
                let cand = exe.join(rel);
                loaded |= try_load(&cand);
            }
        }
        // 1c) AppImage: resources next to squashfs mount -> check $APPDIR/resources
        if let Ok(appdir) = std::env::var("APPDIR") {
            loaded |= try_load(&PathBuf::from(format!("{appdir}/resources/.env")));
            loaded |= try_load(&PathBuf::from(format!("{appdir}/.env")));
        }
    }
    // 2) Tauri resource dir via env var set by some launchers
    if let Ok(res) = std::env::var("TAURI_RESOURCE_DIR") {
        loaded |= try_load(&PathBuf::from(format!("{res}/.env")));
        loaded |= try_load(&PathBuf::from(format!("{res}/resources/.env")));
    }
    // 3) Current working directory (cargo tauri dev)
    loaded |= try_load(&PathBuf::from(".env"));
    loaded |= try_load(&PathBuf::from("src-tauri/.env"));
    // 4) Fallback: try CWD via dotenvy (searches parent dirs)
    if !loaded {
        if dotenvy::dotenv().is_ok() {
            eprintln!("[kitawatch] loaded .env via dotenvy search");
        }
    } else {
        dotenvy::dotenv().ok();
    }
    if !loaded {
        eprintln!("[kitawatch] WARNING: no .env found in any known location - AniList login will fail with 401");
    }
}

/// Load .env from the Tauri resource directory (Linux AppImage/deb need this).
pub fn load_with_resource_dir(resource_dir: &std::path::Path) {
    let mut found = false;
    found |= try_load(&resource_dir.join(".env"));
    found |= try_load(&resource_dir.join("resources/.env"));
    // deb layout: resource_dir is /usr/lib/KitaWatch, but .env may be at /usr/lib/KitaWatch/resources/.env
    // also try parent
    if let Some(parent) = resource_dir.parent() {
        found |= try_load(&parent.join(".env"));
    }
    if !found {
        eprintln!("[kitawatch] load_with_resource_dir: no .env under {}", resource_dir.display());
    }
    load();
}

pub fn get_var(key: &str) -> Result<String, String> {
    env::var(key).map_err(|_| format!("{} is not configured", key))
}