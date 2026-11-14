// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::thread::JoinHandle;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

const GATEWAY_PORT: u16 = 18790;

/// How many lines of the gateway's output may wait to be written to this app's stderr.
const GATEWAY_LOG_QUEUE: usize = 256;

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

/// The line to log for something the gateway sidecar did, if there is one.
fn gateway_line(event: CommandEvent) -> Option<String> {
    match event {
        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
            Some(String::from_utf8_lossy(&line).trim_end().to_string())
        }
        CommandEvent::Error(e) => Some(e),
        CommandEvent::Terminated(end) => Some(format!("stopped (exit code {:?})", end.code)),
        _ => None,
    }
}

/// Writes each line it is sent to `out`, prefixed `[gateway]`, from a thread of its own.
///
/// The queue holds `capacity` lines and is fed with `try_send`, so when `out` stops
/// taking them (stderr is a pipe nobody reads) the lines are dropped instead of the
/// sender waiting: a sender that waited would stop the shell plugin reading the
/// gateway's output, and the gateway would block on a full pipe of its own. A write
/// that fails is not worth a panic either. Dropping the sender ends the thread.
fn log_writer<W: Write + Send + 'static>(
    mut out: W,
    capacity: usize,
) -> (SyncSender<String>, JoinHandle<()>) {
    let (tx, rx) = sync_channel::<String>(capacity);
    let thread = std::thread::spawn(move || {
        for line in rx {
            let _ = writeln!(out, "[gateway] {}", line);
        }
    });
    (tx, thread)
}

/// Starts the bundled gateway sidecar, pointed at the bundled calculation engine.
fn spawn_gateway(app: &tauri::App) {
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
                Ok((mut rx, _child)) => {
                    // What the gateway prints, and why it stopped, goes to this app's
                    // own stderr. Left unread it is dropped, and a gateway that refuses
                    // to start (a database from a newer OpenClerq, say) would say nothing.
                    // The writing is another thread's job, and never waited for.
                    let (log, _writer) = log_writer(std::io::stderr(), GATEWAY_LOG_QUEUE);
                    tauri::async_runtime::spawn(async move {
                        while let Some(event) = rx.recv().await {
                            if let Some(line) = gateway_line(event) {
                                match log.try_send(line) {
                                    Ok(()) | Err(TrySendError::Full(_)) => {}
                                    Err(TrySendError::Disconnected(_)) => break,
                                }
                            }
                        }
                    });
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // In release builds with sidecars, auto-start the gateway if not already running.
            // cfg! rather than #[cfg], so debug and release compile and lint the same code.
            if !cfg!(debug_assertions) && !gateway_running() {
                spawn_gateway(app);
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
    use super::{gateway_line, log_writer, upsert_env_line};
    use std::io::Write;
    use std::sync::mpsc::TrySendError;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::{Duration, Instant};
    use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};

    /// A writer whose bytes can be read back.
    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// A writer that waits, as a full pipe does, until it is let go.
    struct Stuck(Arc<(Mutex<bool>, Condvar)>);

    impl Write for Stuck {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let (open, wake) = &*self.0;
            let mut open = open.lock().unwrap();
            while !*open {
                open = wake.wait(open).unwrap();
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn logs_what_the_gateway_prints_and_how_it_stopped() {
        let said = |bytes: &str| gateway_line(CommandEvent::Stderr(bytes.as_bytes().to_vec()));
        assert_eq!(
            said("[Clerq] Not started: This database was written by a newer OpenClerq\n"),
            Some("[Clerq] Not started: This database was written by a newer OpenClerq".to_string())
        );
        assert_eq!(
            gateway_line(CommandEvent::Stdout(b"listening  \r\n".to_vec())),
            Some("listening".to_string())
        );
        assert_eq!(
            gateway_line(CommandEvent::Terminated(TerminatedPayload {
                code: Some(1),
                signal: None
            })),
            Some("stopped (exit code Some(1))".to_string())
        );
        assert_eq!(
            gateway_line(CommandEvent::Error("spawn failed".to_string())),
            Some("spawn failed".to_string())
        );
    }

    #[test]
    fn writes_each_line_in_order_with_its_prefix() {
        let sink = Sink::default();
        let (tx, thread) = log_writer(sink.clone(), 8);
        for line in ["one", "two", "three"] {
            tx.try_send(line.to_string()).unwrap();
        }
        drop(tx);
        thread.join().unwrap();
        let text = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        assert_eq!(text, "[gateway] one\n[gateway] two\n[gateway] three\n");
    }

    #[test]
    fn never_waits_for_a_stderr_nobody_reads() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let (tx, thread) = log_writer(Stuck(gate.clone()), 4);
        let started = Instant::now();
        let mut kept = 0;
        let mut dropped = 0;
        for i in 0..10_000 {
            match tx.try_send(format!("line {i}")) {
                Ok(()) => kept += 1,
                Err(TrySendError::Full(_)) => dropped += 1,
                Err(TrySendError::Disconnected(_)) => panic!("the writer went away"),
            }
        }
        // Ten thousand lines into a stuck writer took no time at all, and all but a few were dropped.
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(kept <= 4 + 1, "kept {kept}");
        assert!(dropped >= 10_000 - 5, "dropped {dropped}");
        // Let it go: what was kept is written, and the thread ends.
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        drop(tx);
        thread.join().unwrap();
    }

    #[test]
    fn survives_a_stderr_that_has_closed() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "closed",
                ))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (tx, thread) = log_writer(Broken, 4);
        tx.send("lost".to_string()).unwrap();
        drop(tx);
        thread.join().unwrap();
    }

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
