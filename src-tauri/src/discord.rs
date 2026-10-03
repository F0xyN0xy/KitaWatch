//! Discord Rich Presence via discord-rich-presence crate.
use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use std::sync::Mutex;

static DISCORD_CLIENT: Mutex<Option<DiscordIpcClient>> = Mutex::new(None);

fn log(msg: &str) {
    eprintln!("[discord] {}", msg);
}

pub fn init(app_id: &str) {
    let mut guard = match DISCORD_CLIENT.lock() {
        Ok(g) => g,
        Err(_) => {
            log("ERROR: mutex poisoned in init");
            return;
        }
    };

    // Already initialized
    if guard.is_some() {
        log("already initialized, skipping");
        return;
    }

    log(&format!("init: connecting with app_id={}", app_id));
    match DiscordIpcClient::new(app_id) {
        Ok(mut client) => {
            match client.connect() {
                Ok(_) => {
                    log("init: connected successfully");
                    *guard = Some(client);
                }
                Err(e) => {
                    log(&format!("init: connect FAILED - {}", e));
                }
            }
        }
        Err(e) => {
            log(&format!("init: client creation FAILED - {}", e));
        }
    }
}

pub fn set(details: &str, state: Option<&str>, start: Option<i64>) {
    let mut guard = match DISCORD_CLIENT.lock() {
        Ok(g) => g,
        Err(_) => {
            log("ERROR: mutex poisoned in set");
            return;
        }
    };

    // Initialize if needed (Discord might not have been running at startup)
    if guard.is_none() {
        log("set: not initialized, attempting lazy init");
        match DiscordIpcClient::new("1553307716758536202") {
            Ok(mut client) => {
                match client.connect() {
                    Ok(_) => {
                        log("set: lazy init connected");
                        *guard = Some(client);
                    }
                    Err(e) => {
                        log(&format!("set: lazy init connect FAILED - {}", e));
                        return;
                    }
                }
            }
            Err(e) => {
                log(&format!("set: lazy init client creation FAILED - {}", e));
                return;
            }
        }
    }

    let client = match guard.as_mut() {
        Some(c) => c,
        None => {
            log("set: no client available");
            return;
        }
    };

    let mut act = activity::Activity::new().details(details);

    if let Some(s) = state {
        act = act.state(s);
    }

    if let Some(ts) = start {
        act = act.timestamps(activity::Timestamps::new().start(ts));
    }

    log(&format!("set: setting activity details={:?} state={:?}", details, state));

    // Try to set activity; reconnect on failure
    match client.set_activity(act.clone()) {
        Ok(_) => {
            log("set: activity set successfully");
        }
        Err(e) => {
            log(&format!("set: set_activity FAILED - {}, attempting reconnect", e));
            let app_id = client.client_id.clone();

            match DiscordIpcClient::new(&app_id) {
                Ok(mut new_client) => {
                    match new_client.connect() {
                        Ok(_) => {
                            match new_client.set_activity(act) {
                                Ok(_) => {
                                    log("set: reconnect + activity set successfully");
                                    *guard = Some(new_client);
                                }
                                Err(e2) => {
                                    log(&format!("set: reconnect set_activity FAILED - {}", e2));
                                }
                            }
                        }
                        Err(e2) => {
                            log(&format!("set: reconnect connect FAILED - {}", e2));
                        }
                    }
                }
                Err(e2) => {
                    log(&format!("set: reconnect client creation FAILED - {}", e2));
                }
            }
        }
    }
}

pub fn clear() {
    let mut guard = match DISCORD_CLIENT.lock() {
        Ok(g) => g,
        Err(_) => {
            log("ERROR: mutex poisoned in clear");
            return;
        }
    };

    if let Some(ref mut client) = *guard {
        let _ = client.clear_activity();
        let _ = client.close();
        log("clear: activity cleared");
    }

    *guard = None;
}
