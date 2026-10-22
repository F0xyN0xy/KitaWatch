mod api_sidecar;
mod commands;
mod config;
mod discord;
mod proc_group;
use tauri::Manager;

struct SidecarLifecycle {
    sidecars: Option<api_sidecar::Sidecars>,
    shutting_down: bool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // single-instance MUST be the first plugin — with its "deep-link"
        // feature it forwards OAuth callbacks (kitawatch://auth) from the
        // second OS-spawned process into the running instance.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Do not print argv: it can contain an OAuth authorization code.
            let has_kitawatch_url = args.iter().any(|arg| arg.starts_with("kitawatch://"));
            eprintln!(
                "[kitawatch][oauth] Single-instance activation received (argument_count={}, has_kitawatch_url={})",
                args.len(),
                has_kitawatch_url
            );

            // A deep link may activate an already-running instance instead of
            // launching a new window. Explicitly bring the main window forward.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                if let Err(error) = window.set_focus() {
                    eprintln!("[kitawatch][oauth] Could not focus main window: {error}");
                }
            } else {
                eprintln!("[kitawatch][oauth] Main window was not available during activation.");
            }
        }));
    }

    builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::exchange_anilist_token,
            commands::collect_debug_report,
            commands::discord_presence_set,
            commands::discord_presence_clear,
        ]);

    builder
        .setup(|app| {
            // Ensure .env is loaded from resource dir early (Linux needs this for AniList secret)
            if let Ok(res_dir) = app.path().resource_dir() {
                config::load_with_resource_dir(&res_dir);
            } else {
                config::load();
            }
            // Discord IPC can take time to connect when Discord is closed. Keep it
            // off the native setup path so it cannot delay the first app window.
            std::thread::spawn(|| {
                crate::discord::init("1553307716758536202");
            });

            {
                use tauri_plugin_deep_link::DeepLinkExt;
                match app.deep_link().register_all() {
                    Ok(()) => eprintln!("[kitawatch][oauth] Deep-link scheme registration completed."),
                    Err(e) => {
                        eprintln!("[kitawatch][oauth] warning: failed to register deep links: {e}");
                        // Linux: deep-link registration needs a .desktop file; log but don't fail.
                        #[cfg(target_os = "linux")]
                        eprintln!("[kitawatch] hint: on Linux, the kitawatch:// scheme requires the .desktop file to be installed (the deb package does this automatically).");
                    }
                }
            }

            // Tauri runs setup before creating configured windows. Sidecar
            // cleanup and spawn checks can take over a second, so run them off
            // this path to let the splash WebView start painting immediately.
            // Keep the lifecycle state managed now so exit can race safely with
            // background startup without leaving newly spawned children alive.
            let sidecar_state = std::sync::Mutex::new(SidecarLifecycle {
                sidecars: None,
                shutting_down: false,
            });
            app.manage(sidecar_state);

            let sidecar_app = app.handle().clone();
            std::thread::spawn(move || {
                let mut sidecars = api_sidecar::start(&sidecar_app);
                if let Some(state) = sidecar_app.try_state::<std::sync::Mutex<SidecarLifecycle>>() {
                    match state.lock() {
                        Ok(mut state) if !state.shutting_down => {
                            state.sidecars = Some(sidecars);
                        }
                        Ok(_) | Err(_) => {
                            api_sidecar::stop(&mut sidecars);
                        }
                    }
                } else {
                    api_sidecar::stop(&mut sidecars);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building KitaWatch")
        .run(move |app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<std::sync::Mutex<SidecarLifecycle>>() {
                    if let Ok(mut state) = state.lock() {
                        state.shutting_down = true;
                        if let Some(mut sidecars) = state.sidecars.take() {
                            api_sidecar::stop(&mut sidecars);
                        }
                    }
                }
            }
        });
}