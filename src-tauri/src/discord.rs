//! Discord Rich Presence via direct local socket (pure std, no crate).
use std::io::{Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::sync::OnceLock;

pub struct DiscordPresence {
    app_id: String,
}

impl DiscordPresence {
    pub fn new(app_id: &str) -> Self {
        Self { app_id: app_id.to_string() }
    }
    pub fn set(&self, details: &str, state: Option<&str>, _start: Option<i64>) {
        for port in 6463..=6472 {
            if let Ok(mut stream) = TcpStream::connect(format!("127.0.0.1:{}", port)) {
                stream.set_nonblocking(false).ok();
                let handshake = format!(r#"{{"v":1,"client_id":"{}"}}"#, self.app_id);
                let payload_json = serde_json::json!({
                    "cmd": "SET_ACTIVITY",
                    "args": {
                        "pid": std::process::id(),
                        "activity": {
                            "details": details,
                            "state": state.unwrap_or("Watching anime"),
                            "assets": {
                                "large_image": "logo",
                                "large_text": "KitaWatch"
                            }
                        }
                    }
                });
                let payload = payload_json.to_string();
                let msg = format!("{}{}", handshake.len(), handshake);
                let _ = stream.write_all(msg.as_bytes());
                let _ = stream.write_all(payload.as_bytes());
                break;
            }
        }
    }
    pub fn clear(&self) {
        for port in 6463..=6472 {
            if let Ok(mut stream) = TcpStream::connect(format!("127.0.0.1:{}", port)) {
                stream.set_nonblocking(false).ok();
                let handshake = format!(r#"{{"v":1,"client_id":"{}"}}"#, self.app_id);
                let payload = r#"{"cmd":"SET_ACTIVITY","args":{"pid":0},"activity":{"details":"","state":"","assets":{"large_image":"","large_text":""}}}"#;
                let msg = format!("{}{}", handshake.len(), handshake);
                let _ = stream.write_all(msg.as_bytes());
                let _ = stream.write_all(payload.as_bytes());
            }
        }
    }
}

static PRESENCE: OnceLock<Arc<Mutex<DiscordPresence>>> = OnceLock::new();

pub fn init(app_id: &str) {
    let _ = PRESENCE.set(Arc::new(Mutex::new(DiscordPresence::new(app_id))));
}

pub fn set(details: &str, state: Option<&str>, start: Option<i64>) {
    if let Some(presence) = PRESENCE.get() {
        if let Ok(p) = presence.lock() {
            p.set(details, state, start);
        }
    }
}

pub fn clear() {
    if let Some(presence) = PRESENCE.get() {
        if let Ok(p) = presence.lock() {
            p.clear();
        }
    }
}
