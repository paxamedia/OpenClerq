// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
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

/// Creates ~/.clerq readable only by this account, tightening it if an earlier
/// build left it wider. It holds API keys and conversations.
fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {}", dir.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Could not restrict {}: {}", dir.display(), e))?;
    }
    Ok(())
}

/// Writes a file readable only by this account. The mode is set on the open
/// file too, so a file that already existed with a wider mode is tightened.
fn write_private(path: &Path, content: &str) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("Could not write {}: {}", path.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Could not restrict {}: {}", path.display(), e))?;
    }
    file.write_all(content.as_bytes())
        .map_err(|e| format!("Could not write {}: {}", path.display(), e))
}

/// Sets `key` in .env text, keeping every other line as it was.
fn upsert_env_line(existing: &str, key: &str, value: &str) -> String {
    let prefix = format!("{}=", key);
    let mut replaced = false;
    let mut lines: Vec<String> = existing
        .lines()
        .map(|line| {
            if line.trim_start().starts_with(&prefix) {
                replaced = true;
                format!("{}{}", prefix, value)
            } else {
                line.to_string()
            }
        })
        .collect();
    if !replaced {
        if lines.is_empty() {
            lines.push("# Clerq — written by the desktop app".to_string());
        }
        lines.push(format!("{}{}", prefix, value));
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// Stores the API key in ~/.clerq/.env for the gateway to load. Only that one
/// line changes: other keys and settings in the file are kept.
#[tauri::command]
fn write_api_key(api_key: String) -> Result<(), String> {
    let dir = clerq_dir()?;
    ensure_private_dir(&dir)?;
    let env_path = dir.join(".env");
    let existing = fs::read_to_string(&env_path).unwrap_or_default();
    let value = api_key.trim().replace(['\n', '\r'], "");
    write_private(
        &env_path,
        &upsert_env_line(&existing, "ANTHROPIC_API_KEY", &value),
    )
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
    ensure_private_dir(&dir)?;
    write_private(&dir.join("config.json"), &json)
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

/// Read the gateway bearer token from ~/.clerq/gateway-token.
///
/// The gateway itself creates this file (mode 0600) on first start, so the
/// desktop only ever reads it. Returns an error while the gateway is still
/// starting up; the frontend retries.
#[tauri::command]
fn gateway_token() -> Result<String, String> {
    let path = clerq_dir()?.join("gateway-token");
    match fs::read_to_string(&path) {
        Ok(contents) => {
            let token = contents.trim().to_string();
            if token.is_empty() {
                Err("Gateway token file is empty.".to_string())
            } else {
                Ok(token)
            }
        }
        Err(_) => Err("Gateway token not available yet. Is the gateway running?".to_string()),
    }
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
                                .env("CLERQ_PORT", GATEWAY_PORT.to_string())
                                .env("CLERQ_HOST", "127.0.0.1");
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
            read_module_manifest,
            gateway_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running Clerq desktop application");
}

#[cfg(test)]
mod tests {
    use super::upsert_env_line;

    #[test]
    fn replaces_the_key_and_keeps_every_other_line() {
        let before =
            "# mine\nDEEPSEEK_API_KEY=ds\nANTHROPIC_API_KEY=old\nCLERQ_LLM_PROVIDER=deepseek\n";
        let after = upsert_env_line(before, "ANTHROPIC_API_KEY", "new");
        assert_eq!(
            after,
            "# mine\nDEEPSEEK_API_KEY=ds\nANTHROPIC_API_KEY=new\nCLERQ_LLM_PROVIDER=deepseek\n"
        );
    }

    #[test]
    fn appends_the_key_when_absent() {
        let after = upsert_env_line("OPENAI_API_KEY=o\n", "ANTHROPIC_API_KEY", "k");
        assert_eq!(after, "OPENAI_API_KEY=o\nANTHROPIC_API_KEY=k\n");
    }

    #[test]
    fn starts_a_new_file_with_a_header() {
        let after = upsert_env_line("", "ANTHROPIC_API_KEY", "k");
        assert_eq!(
            after,
            "# Clerq — written by the desktop app\nANTHROPIC_API_KEY=k\n"
        );
    }

    #[test]
    fn does_not_mistake_a_longer_key_for_this_one() {
        let after = upsert_env_line("ANTHROPIC_API_KEY_BACKUP=b\n", "ANTHROPIC_API_KEY", "k");
        assert_eq!(after, "ANTHROPIC_API_KEY_BACKUP=b\nANTHROPIC_API_KEY=k\n");
    }
}
