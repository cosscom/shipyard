// Browser panes are child webviews laid over the main webview, one per pane,
// so any page works (no iframe restrictions) and a box's dev server behaves as
// it would in a real browser. The React pane owns the rectangle; these
// commands keep the native view on top of it.
//
// Commands that create webviews are async: Window::add_child waits for the
// main thread, which a synchronous command would already be holding.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

// Labels are namespaced so a pane id can never name the app's own webview.
fn label(id: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid browser pane id {id:?}"));
    }
    Ok(format!("browser-{id}"))
}

fn parse(url: &str) -> Result<Url, String> {
    let u = Url::parse(url).map_err(|e| format!("{url} is not a URL: {e}"))?;
    match u.scheme() {
        "http" | "https" => Ok(u),
        s => Err(format!("browser panes open http and https pages, not {s}:")),
    }
}

fn find(app: &AppHandle, id: &str) -> Result<Webview, String> {
    app.get_webview(&label(id)?)
        .ok_or_else(|| format!("no browser pane {id}"))
}

#[derive(Clone, Serialize)]
struct Navigated {
    id: String,
    url: String,
    // "started": a navigation is about to begin, in the page or in a frame
    // inside it (the navigation policy is asked for every frame, and a
    // frame's load never finishes the page); "committed": the page itself
    // began showing a new document; "finished": the page itself finished;
    // "moved": the page changed its own address without loading (an app's
    // client-side routing: history.pushState, replaceState, a #hash).
    state: &'static str,
}

const EVENT: &str = "berth://browser";

// The element picker reports a pick by navigating to berth-pick://pick?d=…,
// which is cancelled here and handed to the app; the page never leaves.
const PICK_EVENT: &str = "berth://browser-pick";

#[derive(Clone, Serialize)]
struct Picked {
    id: String,
    url: String,
}

// The Console drawer's script, the same file the laptop's proxy puts into a
// Browser tab's frame (internal/proxy/devtools.js). It runs at the start of
// every page in a pane and keeps what the page logs; the pane's watcher
// (watch_console) asks it for what is new and sends it to the app as
// CONSOLE_EVENT.
const DEVTOOLS_JS: &str = include_str!("../../../internal/proxy/devtools.js");

const CONSOLE_EVENT: &str = "berth://browser-console";

#[derive(Clone, Serialize)]
struct Console {
    id: String,
    // The script's report, as JSON (lib/devtools.ts reads it).
    data: String,
}

// DRAIN asks the page for its address and its script for what is new: the
// address, a newline (an address never holds one), then the script's report.
// It always returns a string, whatever the page has done to its globals:
// WebKit's result must be something JSON can write.
//
// The address comes from the page rather than from Webview::url: wry's url()
// unwraps WKWebView.URL, which is nil after a load that failed (nothing
// listening on the port), and the panic aborts the app (tauri-apps/wry#1752).
const DRAIN: &str = "(function(){var u='';try{u=''+location.href;}catch(e){}try{var d=window.__berthDevtools;var s=d&&typeof d.drain==='function'?d.drain():'';return u+'\\n'+(typeof s==='string'?s:'');}catch(e){return u+'\\n';}})()";

// Panes with a watcher, by label: one each, even when a pane reopens.
static WATCHED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// watch_console drains a pane's console twice a second, until the pane
// closes. One question at a time: a page busy in a loop answers late, and
// questions must not pile up behind it.
fn watch_console(app: AppHandle, id: String, label: String) {
    {
        let mut w = WATCHED.lock().unwrap_or_else(|e| e.into_inner());
        if !w.get_or_insert_with(HashSet::new).insert(label.clone()) {
            return;
        }
    }
    std::thread::spawn(move || {
        let asked = Arc::new(AtomicU64::new(0));
        let at = Arc::new(Mutex::new(String::new()));
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let Some(wv) = app.get_webview(&label) else { break };
            let since = asked.load(Ordering::SeqCst);
            if since != 0 && now_ms().saturating_sub(since) < 5000 {
                continue;
            }
            asked.store(now_ms(), Ordering::SeqCst);
            let (app2, id2, asked2, at2) = (app.clone(), id.clone(), asked.clone(), at.clone());
            let sent = wv.eval_with_callback(DRAIN, move |json| {
                asked2.store(0, Ordering::SeqCst);
                // The drain's string, as JSON.
                let Ok(answer) = serde_json::from_str::<String>(&json) else { return };
                let (url, data) = split_drain(&answer);
                // An app that routes on the client (history.pushState)
                // changes its address without a navigation or a load, so
                // neither hook hears it: the address bar follows the page's.
                if let Some(url) = url {
                    let mut at = at2.lock().unwrap_or_else(|e| e.into_inner());
                    if *at != url {
                        if !at.is_empty() {
                            let _ = app2.emit(EVENT, Navigated { id: id2.clone(), url: url.to_string(), state: "moved" });
                        }
                        *at = url.to_string();
                    }
                }
                if !data.is_empty() {
                    let _ = app2.emit(CONSOLE_EVENT, Console { id: id2.clone(), data: data.to_string() });
                }
            });
            if sent.is_err() {
                asked.store(0, Ordering::SeqCst);
            }
        }
        if let Some(w) = WATCHED.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            w.remove(&label);
        }
    });
}

// split_drain reads DRAIN's answer: the page's address, when it is a web
// page's (a pane that never loaded one is at about:blank), and the console
// report, "" when nothing is new.
fn split_drain(answer: &str) -> (Option<&str>, &str) {
    let (url, data) = answer.split_once('\n').unwrap_or(("", answer));
    let web = url.starts_with("http://") || url.starts_with("https://");
    (web.then_some(url), data)
}

// inspector_in_own_window makes a pane's Web Inspector open in a window of
// its own. WebKit docks it into the inspected view's superview by default,
// sized as if the view filled it: for a pane laid over the app, that would
// cover the app and resize the pane under the app's feet. Giving it an
// attachment view too small to dock beside (a hidden, empty subview of the
// pane) leaves it no choice; docking is then refused too. Private WebKit
// API (_setInspectorAttachmentView:), checked for before use.
#[cfg(target_os = "macos")]
fn inspector_in_own_window(wv: &Webview) {
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{msg_send, sel};
    let _ = wv.with_webview(|pv| unsafe {
        let wk = pv.inner() as *mut AnyObject;
        let Some(wk) = wk.as_ref() else { return };
        let responds: bool = msg_send![wk, respondsToSelector: sel!(_setInspectorAttachmentView:)];
        let Some(class) = AnyClass::get(c"NSView") else { return };
        if !responds {
            return;
        }
        let blank: Allocated<AnyObject> = msg_send![class, alloc];
        let Some(view): Option<Retained<AnyObject>> = msg_send![blank, init] else { return };
        let _: () = msg_send![&*view, setHidden: true];
        let _: () = msg_send![wk, addSubview: &*view];
        let _: () = msg_send![wk, _setInspectorAttachmentView: &*view];
    });
}

// On Linux, Tauri packs every webview of a window into the window's GtkBox,
// one under the other, and cannot place a child webview over the app's
// (wry moves a webview only inside a gtk::Fixed). So the Linux app lays them
// out itself: the app's webview moves into a gtk::Layout that fills the
// window, and each pane's webview moves from the box into that layout, on
// top, where place puts it. A Layout, unlike a Fixed, does not ask for its
// children's size, so the window still shrinks. GTK runs on the main thread
// only, which is where with_webview's closures run.
#[cfg(target_os = "linux")]
mod stage {
    use gtk::prelude::*;
    use std::cell::RefCell;

    thread_local! {
        static LAYOUT: RefCell<Option<gtk::Layout>> = const { RefCell::new(None) };
    }

    // install moves the app's webview into the layout, once.
    pub fn install(main: &webkit2gtk::WebView) {
        LAYOUT.with(|l| {
            if l.borrow().is_some() {
                return;
            }
            let Some(parent) = main.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else {
                eprintln!("berth: the app's webview is not in a GtkBox; browser panes stay below it");
                return;
            };
            let layout = gtk::Layout::new(None::<&gtk::Adjustment>, None::<&gtk::Adjustment>);
            parent.remove(main);
            layout.put(main, 0, 0);
            parent.pack_start(&layout, true, true, 0);
            // The app's webview fills the layout: allocated here, after the
            // layout has allocated its children, rather than by a size
            // request, which would ask for another layout pass from inside
            // this one (and the window could not shrink below it).
            let app = main.clone();
            layout.connect_size_allocate(move |layout, a| {
                let (w, h) = (a.width().max(1), a.height().max(1));
                if layout.size() != (w as u32, h as u32) {
                    layout.set_size(w as u32, h as u32);
                }
                app.size_allocate(&gtk::Allocation::new(0, 0, w, h));
            });
            layout.show_all();
            *l.borrow_mut() = Some(layout);
        });
    }

    // place puts a pane's webview at x, y (logical pixels, as the page
    // measures them) and sizes it, moving it into the layout the first time.
    pub fn place(pane: &webkit2gtk::WebView, x: f64, y: f64, w: f64, h: f64) {
        LAYOUT.with(|l| {
            let Some(layout) = l.borrow().clone() else { return };
            let (x, y) = (x.round() as i32, y.round() as i32);
            let (w, h) = (w.round().max(1.0) as i32, h.round().max(1.0) as i32);
            pane.set_size_request(w, h);
            let parent = pane.parent();
            if parent.as_ref() == Some(layout.upcast_ref::<gtk::Widget>()) {
                layout.move_(pane, x, y);
                return;
            }
            if let Some(container) = parent.and_then(|p| p.downcast::<gtk::Container>().ok()) {
                container.remove(pane);
            }
            layout.put(pane, x, y);
            pane.show();
        });
    }
}

// place_linux lays a pane out on Linux (stage, above).
#[cfg(target_os = "linux")]
fn place_linux(app: &AppHandle, wv: &Webview, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    if let Some(main) = app.get_webview("main") {
        main.with_webview(|pv| stage::install(&pv.inner())).map_err(|e| e.to_string())?;
    }
    wv.with_webview(move |pv| stage::place(&pv.inner(), x, y, w, h)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_open(app: AppHandle, id: String, url: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let label = label(&id)?;
    let url = parse(&url)?;
    if let Some(existing) = app.get_webview(&label) {
        existing.navigate(url).map_err(|e| e.to_string())?;
        return place(&app, &existing, x, y, w, h);
    }
    let window = app.get_window("main").ok_or("the main window is gone")?;
    let nav_app = app.clone();
    let nav_id = id.clone();
    let pick_app = app.clone();
    let pick_id = id.clone();
    let load_id = id.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .initialization_script(DEVTOOLS_JS)
        .devtools(true)
        .on_navigation(move |u| {
            if u.scheme() == "berth-pick" {
                let _ = pick_app.emit(PICK_EVENT, Picked { id: pick_id.clone(), url: u.to_string() });
                return false;
            }
            let _ = nav_app.emit(EVENT, Navigated { id: nav_id.clone(), url: u.to_string(), state: "started" });
            true
        })
        .on_page_load(move |wv, payload| {
            let state = match payload.event() {
                // wry reports the main frame's commit as Started.
                PageLoadEvent::Started => "committed",
                PageLoadEvent::Finished => "finished",
            };
            let _ = wv.app_handle().emit(EVENT, Navigated { id: load_id.clone(), url: payload.url().to_string(), state });
        });
    let _wv = window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w.max(1.0), h.max(1.0)))
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    inspector_in_own_window(&_wv);
    #[cfg(target_os = "linux")]
    place_linux(&app, &_wv, x, y, w, h)?;
    watch_console(app.clone(), id, label);
    Ok(())
}

fn place(_app: &AppHandle, wv: &Webview, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return place_linux(_app, wv, x, y, w, h);
    #[cfg(not(target_os = "linux"))]
    {
        wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(w.max(1.0), h.max(1.0))).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn browser_set_bounds(app: AppHandle, id: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    place(&app, &find(&app, &id)?, x, y, w, h)
}

#[tauri::command]
pub async fn browser_show(app: AppHandle, id: String) -> Result<(), String> {
    find(&app, &id)?.show().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_hide(app: AppHandle, id: String) -> Result<(), String> {
    find(&app, &id)?.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    find(&app, &id)?.navigate(parse(&url)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_back(app: AppHandle, id: String) -> Result<(), String> {
    find(&app, &id)?.eval("history.back()").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_forward(app: AppHandle, id: String) -> Result<(), String> {
    find(&app, &id)?.eval("history.forward()").map_err(|e| e.to_string())
}

// browser_pick runs the element picker in a pane's page. The script is the
// app's own (src/lib/picker.ts); a pick comes back as PICK_EVENT.
#[tauri::command]
pub async fn browser_pick(app: AppHandle, id: String, script: String) -> Result<(), String> {
    if script.len() > 64 * 1024 {
        return Err("picker script too large".into());
    }
    find(&app, &id)?.eval(&script).map_err(|e| e.to_string())
}

// browser_inspect opens WebKit's Web Inspector for a pane's page, in its own
// window (inspector_in_own_window). The page's own right-click menu has
// Inspect Element too.
#[tauri::command]
pub async fn browser_inspect(app: AppHandle, id: String) -> Result<(), String> {
    find(&app, &id)?.open_devtools();
    Ok(())
}

#[tauri::command]
pub async fn browser_reload(app: AppHandle, id: String) -> Result<(), String> {
    find(&app, &id)?.reload().map_err(|e| e.to_string())
}

// Closing a pane that is already gone is not an error: unmounting races
// window teardown.
#[tauri::command]
pub async fn browser_close(app: AppHandle, id: String) -> Result<(), String> {
    match app.get_webview(&label(&id)?) {
        Some(wv) => wv.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::split_drain;

    #[test]
    fn drain_answers() {
        assert_eq!(split_drain("http://localhost:3000/a?b#c\n"), (Some("http://localhost:3000/a?b#c"), ""));
        assert_eq!(split_drain("https://x.test/\n{\"logs\":[]}\n"), (Some("https://x.test/"), "{\"logs\":[]}\n"));
        // A failed first load leaves the pane at about:blank: no address.
        assert_eq!(split_drain("about:blank\n"), (None, ""));
        assert_eq!(split_drain("\n"), (None, ""));
        assert_eq!(split_drain(""), (None, ""));
    }
}
