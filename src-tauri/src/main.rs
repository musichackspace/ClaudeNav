// ClaudeNav desktop wrapper.
//
// A thin Tauri shell around the existing dependency-free Node server. It does
// NOT reimplement any backend logic: on launch it ensures `server.js` is
// running on 127.0.0.1:<port>, then opens a native window pointed at it.
//
// Behaviour:
//   * If something is already serving the port (e.g. the LaunchAgent, or
//     another copy of the app), we ATTACH to it and leave it running on exit.
//   * Otherwise we SPAWN `node server.js` ourselves and stop it on quit.
//
// Cross-platform by design: no macOS-only assumptions live here. Node is
// located portably (PATH first, then per-OS fallback dirs), paths are built
// with std::path, and the child is managed via std::process on every platform.
// (The server's own terminal-opening features remain macOS-only, but that is a
// server concern, not the wrapper's — other platforms still get the dashboard
// and headless chat.)

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 4317;

// The child we spawned, if any. `None` when we attached to a server that was
// already running — in that case we must not kill it on exit.
struct ServerProcess(Mutex<Option<Child>>);

fn port_is_open() -> bool {
    let addr: SocketAddr = format!("{HOST}:{PORT}")
        .parse()
        .expect("valid loopback address");
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn wait_for_server(timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if port_is_open() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

// Locate a usable `node`. PATH first (covers most setups, and Windows'
// `node.exe`), then common install dirs that GUI-launched apps miss because
// the OS hands them a minimal PATH. Mirrors the server's resolveClaudeBin().
fn resolve_node() -> String {
    if let Ok(custom) = std::env::var("CLAUDENAV_NODE") {
        if !custom.is_empty() {
            return custom;
        }
    }

    let mut candidates: Vec<String> = vec!["node".into()];
    #[cfg(not(target_os = "windows"))]
    {
        for dir in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/home/linuxbrew/.linuxbrew/bin",
        ] {
            candidates.push(format!("{dir}/node"));
        }
        if let Ok(home) = std::env::var("HOME") {
            candidates.push(format!("{home}/.local/bin/node"));
        }
    }

    for cand in &candidates {
        let ok = Command::new(cand)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return cand.clone();
        }
    }

    // Last resort: let the spawn fail loudly so the error is visible.
    "node".into()
}

// Find server.js: a bundled resource in production, the repo root in dev.
fn resolve_server_js(app: &tauri::App) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("server.js");
        if p.exists() {
            return Some(p);
        }
    }
    // Dev: the repo root is one level up from src-tauri/.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("server.js");
    if dev.exists() {
        return Some(dev);
    }
    None
}

// Watch the server and recover the window when it relaunches. The server can
// go away from under us — most notably the in-app "Update & relaunch" button
// (git pull + restart). When that happens the WebView is stuck on Chromium's
// connection-refused page, which runs no JS, so a page-level script can't heal
// it. We poll from the native side and, on a down->up transition, re-navigate
// the window to the URL (this replaces the error page, unlike a no-op reload).
fn spawn_reconnect_watcher(app: tauri::AppHandle, url: String) {
    std::thread::spawn(move || {
        // The window is only created after the first successful health check,
        // so we start in the "up" state and act on the next down->up edge.
        let mut was_up = true;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let up = port_is_open();
            if up && !was_up {
                if let Some(win) = app.get_webview_window("main") {
                    if let Ok(parsed) = url.parse() {
                        let _ = win.navigate(parsed);
                    }
                }
            }
            was_up = up;
        }
    });
}

fn main() {
    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            if !port_is_open() {
                let node = resolve_node();
                let server_js =
                    resolve_server_js(app).expect("could not locate server.js");
                let cwd = server_js
                    .parent()
                    .expect("server.js has a parent dir")
                    .to_path_buf();

                let child = Command::new(&node)
                    .arg(&server_js)
                    .current_dir(&cwd)
                    .env("PORT", PORT.to_string())
                    .spawn()
                    .expect("failed to spawn `node server.js`");

                *app.state::<ServerProcess>().0.lock().unwrap() = Some(child);
            }

            if !wait_for_server(Duration::from_secs(15)) {
                eprintln!("[claudenav-desktop] server did not come up on {HOST}:{PORT}");
            }

            let url = format!("http://{HOST}:{PORT}");
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(url.parse().expect("valid url")),
            )
            .title("ClaudeNav")
            .inner_size(1200.0, 820.0)
            .min_inner_size(720.0, 480.0)
            .build()?;

            spawn_reconnect_watcher(app.handle().clone(), url);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building ClaudeNav desktop app")
        .run(|app, event| {
            // Only tear down the server if we were the ones who started it.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(mut child) =
                    app.state::<ServerProcess>().0.lock().unwrap().take()
                {
                    let _ = child.kill();
                }
            }
        });
}
