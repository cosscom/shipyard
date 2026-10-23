use serde::Serialize;
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use tauri::Manager;

mod agent;
mod browser;
mod cli_link;
mod keys;
#[cfg(target_os = "linux")]
mod linux;
mod menu;

// The app is a view over the laptop agent (`berth agent`), which serves it on
// loopback. The agent writes a token to its state directory; this shell reads
// it and hands it to the webview, which sends it with every request.

const AGENT_URL: &str = "http://127.0.0.1:1378";

#[derive(Serialize)]
struct Endpoint {
    url: String,
    token: String,
}

// The agent's state directory: $BERTH_HOME/client when set, otherwise the
// OS config directory's berth/client (~/Library/Application Support on macOS),
// matching statefile.Home in the Go code.
fn token_path() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("BERTH_HOME") {
        if !home.is_empty() {
            return Ok(PathBuf::from(home).join("client").join("ui-token"));
        }
    }
    let base = dirs::config_dir().ok_or("no config directory on this system")?;
    Ok(base.join("berth").join("client").join("ui-token"))
}

#[tauri::command]
fn ui_endpoint() -> Result<Endpoint, String> {
    let path = token_path()?;
    let token = std::fs::read_to_string(&path)
        .map_err(|e| format!("the Shipyard agent has not started yet ({}: {e})", path.display()))?;
    Ok(Endpoint {
        url: AGENT_URL.to_string(),
        token: token.trim().to_string(),
    })
}

// Developer tools for the page that asked, from Settings → Developer. The
// "devtools" feature (Cargo.toml) keeps them in release builds too, for the
// Browser tab's Web Inspector.
#[tauri::command]
fn open_devtools(webview: tauri::Webview) -> Result<(), String> {
    webview.open_devtools();
    Ok(())
}

// restart_app relaunches Shipyard, after the webview has installed a
// downloaded update (Settings → About, or the status bar's "Restart to
// update"). Only ever on that click: agents run on their boxes, so a
// restart stops none of them, but it still closes the window.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.request_restart();
}

// open_terminal brings up Terminal on this Mac, for a card that copied a
// command to paste there (installing tmux for this Mac's box, whose own
// terminals need tmux). It never types or runs anything: the person pastes
// the command, reads it and presses Enter.
#[tauri::command]
fn open_terminal() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .args(["-a", "Terminal"])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("couldn't open Terminal: {e}"))
    }
    #[cfg(target_os = "linux")]
    {
        linux::open_terminal()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err("opening a terminal is only for macOS and Linux".into())
    }
}

// key_layout is what each of codes (KeyboardEvent.code) types on the
// keyboard layout in use (keys.rs), so the shortcuts the webview matches by a
// key's place show that key. Not async: Tauri runs it on the main thread,
// which macOS's Text Input Sources wants.
#[tauri::command]
fn key_layout(codes: Vec<String>) -> std::collections::HashMap<String, String> {
    keys::labels(&codes)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    linux::prefer_compatible_rendering();
    let builder = tauri::Builder::default();
    // On Linux a berth:// link starts the app again with the link as its
    // argument: one already running takes it instead (and comes to the
    // front), and the deep-link plugin hands it to the webview. Registered
    // first, as the plugin asks.
    #[cfg(target_os = "linux")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        // berth://kit?src=… links someone shares open a kit's review.
        .plugin(tauri_plugin_deep_link::init())
        // Updates come from the latest GitHub release's latest.json and must
        // carry a signature from the key in tauri.conf.json. The webview
        // checks, downloads and installs (lib/updater.ts); see restart_app.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The menu bar carries every shortcut (menu.rs), so macOS cannot
        // take one first; each item tells the webview as berth://menu. The
        // Linux app has none: GTK would put a menu bar inside the window,
        // and its accelerators would take Ctrl+W, Ctrl+D and the rest from
        // terminals before the page sees them. The webview handles the keys
        // there (hooks/use-shortcuts.ts).
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let menu = menu::build(app.handle())?;
                app.set_menu(menu)?;
            }
            #[cfg(target_os = "linux")]
            linux::setup(app.handle());
            Ok(())
        })
        .on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            ui_endpoint,
            open_devtools,
            restart_app,
            open_terminal,
            key_layout,
            cli_link::cli_link_status,
            cli_link::install_cli_link,
            agent::agent_binary,
            agent::start_agent,
            agent::restart_stale_agent,
            browser::browser_open,
            browser::browser_set_bounds,
            browser::browser_show,
            browser::browser_hide,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_pick,
            browser::browser_inspect,
            browser::browser_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // A dev build wears an orange icon in the Dock, so it is never
            // taken for the installed app. Tauri puts the app's own there as
            // it gets ready, just before this.
            #[cfg(all(debug_assertions, target_os = "macos"))]
            if let tauri::RunEvent::Ready = _event {
                dev_dock_icon();
            }
        });
}

#[cfg(all(debug_assertions, target_os = "macos"))]
fn dev_dock_icon() {
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    static ICON: &[u8] = include_bytes!("../icons/dev/icon.png");
    let (Some(app), Some(data), Some(image)) = (AnyClass::get(c"NSApplication"), AnyClass::get(c"NSData"), AnyClass::get(c"NSImage")) else { return };
    unsafe {
        let app: *mut AnyObject = msg_send![app, sharedApplication];
        let data: *mut AnyObject = msg_send![data, dataWithBytes: ICON.as_ptr().cast::<std::ffi::c_void>(), length: ICON.len()];
        let blank: Allocated<AnyObject> = msg_send![image, alloc];
        let Some(icon): Option<Retained<AnyObject>> = msg_send![blank, initWithData: data] else { return };
        let _: () = msg_send![app, setApplicationIconImage: &*icon];
    }
}
