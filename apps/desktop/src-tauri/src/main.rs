// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use tauri_plugin_shell::ShellExt;

const GATEWAY_PORT: u16 = 18790;

fn clerq_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Could not find home directory")?;
    Ok(PathBuf::from(home).join(".clerq"))
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!(
        "Hello, {}! Welcome to Clerq — your local administrative agent.",
        name
    )
}

/// Writes API key to ~/.clerq/.env so the gateway (and sidecar) can load it. Creates ~/.clerq if needed.
#[tauri::command]
fn write_api_key(api_key: String) -> Result<(), String> {
    let dir = clerq_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {}", dir.display(), e))?;
    let env_path = dir.join(".env");
    let content = format!(
        "# Clerq — written by desktop app\nANTHROPIC_API_KEY={}\nCLERQ_DEV=1\n",
        api_key.trim().replace('\n', " ")
    );
    fs::write(&env_path, content)
        .map_err(|e| format!("Could not write {}: {}", env_path.display(), e))?;
    Ok(())
}

/// Reads app config from ~/.clerq/config.json. Returns empty object JSON if file missing.
#[tauri::command]
fn read_config() -> Result<String, String> {
    let path = clerq_dir()?.join("config.json");
    if path.exists() {
        let s = fs::read_to_string(&path).map_err(|e| format!("Could not read config: {}", e))?;
        Ok(s)
    } else {
        Ok("{}".to_string())
    }
}

/// Writes app config to ~/.clerq/config.json. Creates ~/.clerq if needed.
#[tauri::command]
fn write_config(json: String) -> Result<(), String> {
    let dir = clerq_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {}", dir.display(), e))?;
    let path = dir.join("config.json");
    fs::write(&path, json).map_err(|e| format!("Could not write config: {}", e))?;
    Ok(())
}

/// Reads module manifest from a directory. Path can be absolute or relative to current dir.
#[tauri::command]
fn read_module_manifest(module_path: String) -> Result<String, String> {
    let path = std::path::Path::new(&module_path)
        .canonicalize()
        .map_err(|e| format!("Invalid path {}: {}", module_path, e))?;
    let manifest_path = path.join("manifest.json");
    if !manifest_path.exists() {
        return Err(format!("manifest.json not found in {}", module_path));
    }
    let s = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Could not read manifest: {}", e))?;
    Ok(s)
}

/// Returns path to the clerq-calc sidecar (next to the app binary).
/// Tauri may bundle as "clerq-calc" (no suffix) or "clerq-calc-{target}"; try both.
fn clerq_calc_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {}", e))?;
    let dir = exe.parent().ok_or("no parent for exe")?;
    #[cfg(target_os = "windows")]
    let names = ["clerq-calc.exe", "clerq-calc-x86_64-pc-windows-msvc.exe"];
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let names = ["clerq-calc", "clerq-calc-aarch64-apple-darwin"];
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    let names = ["clerq-calc", "clerq-calc-x86_64-apple-darwin"];
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let names = ["clerq-calc"];
    for name in names {
        let path = dir.join(name);
        if path.exists() {
            return Ok(path);
        }
    }
    Err(format!("clerq-calc not found in {:?}", dir))
}

fn gateway_running() -> bool {
    std::net::TcpStream::connect(std::net::SocketAddr::from(([127, 0, 0, 1], GATEWAY_PORT))).is_ok()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // In release builds with sidecars, auto-start the gateway if not already running.
            #[cfg(not(debug_assertions))]
            {
                if !gateway_running() {
                    if let Ok(shell) = app.shell().sidecar("clerq-gateway") {
                        if let Ok(calc_path) = clerq_calc_path() {
                            let exe_dir = std::env::current_exe()
                                .ok()
                                .and_then(|p| p.parent().map(|d| d.to_path_buf()));
                            let mut cmd = shell
                                .env("CLERQ_CALC_PATH", calc_path.to_string_lossy().as_ref())
                                .env("CLERQ_DEV", "1")
                                .env("CLERQ_PORT", GATEWAY_PORT.to_string());
                            if let Some(ref dir) = exe_dir {
                                cmd = cmd.current_dir(dir);
                            }
                            match cmd.spawn() {
                                Ok((mut _rx, _child)) => {
                                    // Give gateway a moment to bind
                                    std::thread::sleep(std::time::Duration::from_millis(1500));
                                }
                                Err(e) => {
                                    eprintln!("[Clerq] Failed to spawn gateway sidecar: {}", e);
                                }
                            }
                        }
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            write_api_key,
            read_config,
            write_config,
            read_module_manifest
        ])
        .run(tauri::generate_context!())
        .expect("error while running Clerq desktop application");
}
