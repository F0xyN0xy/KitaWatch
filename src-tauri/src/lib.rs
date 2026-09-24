mod api_sidecar;
mod commands;
mod config;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // single-instance MUST be the first plugin — with its "deep-link"
        // feature it forwards OAuth callbacks (kitawatch://auth) from the
        // second OS-spawned process into the running instance.
        builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}));
    }

    builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::exchange_anilist_token,
            commands::collect_debug_report,
        ]);

    builder
        .setup(|app| {
            // Ensure .env is loaded from resource dir early (Linux needs this for AniList secret)
            if let Ok(res_dir) = app.path().resource_dir() {
                config::load_with_resource_dir(&res_dir);
            } else {
                config::load();
            }

            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("[kitawatch] warning: failed to register deep links: {e}");
                    // Linux: deep-link registration needs a .desktop file; log but don't fail
                    #[cfg(target_os = "linux")]
                    eprintln!("[kitawatch] hint: on Linux the kitawatch:// scheme requires the .desktop file to be installed (deb does this automatically)");
                }
            }

            // Debug spawns from source checkouts; release spawns the bundled
            // binaries next to the app exe (windowless on Windows, logged to
            // the app log dir — launch with `--debug` for consoles).
            let sidecars = api_sidecar::start(app);

            app.manage(std::sync::Mutex::new(sidecars));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building KitaWatch")
        .run(move |app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mutex) = app_handle.try_state::<std::sync::Mutex<api_sidecar::Sidecars>>() {
                    if let Ok(mut sidecars) = mutex.lock() {
                        api_sidecar::stop(&mut sidecars);
                    }
                }
            }
        });
}