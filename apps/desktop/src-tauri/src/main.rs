// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::thread::JoinHandle;
use tauri::Manager;
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

/// The only address a form page may post to: GitHub's own website. The page posts a GitHub
/// App's manifest, which GitHub has to ask the person to confirm in their own browser.
const FORM_TARGET: &str = "https://github.com/";

/// How long a form page is kept: the browser has read it within seconds.
const FORM_KEPT: std::time::Duration = std::time::Duration::from_secs(120);

fn html_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// Whether `login` could be a GitHub user or organisation name: 1 to 39 letters, digits and
/// hyphens, starting with a letter or digit.
fn is_account_name(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 39
        && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !login.starts_with('-')
}

/// Whether `rest` (what follows `https://github.com/`) is the page that takes a new app's
/// manifest: `settings/apps/new` or `organizations/<org>/settings/apps/new`, with the one-time
/// `?state=` the gateway made (64 lowercase hex digits) and nothing else.
fn is_manifest_page(rest: &str) -> bool {
    let Some((path, query)) = rest.split_once('?') else {
        return false;
    };
    let path_ok = match path.split('/').collect::<Vec<_>>().as_slice() {
        ["settings", "apps", "new"] => true,
        ["organizations", org, "settings", "apps", "new"] => is_account_name(org),
        _ => false,
    };
    let state_ok = query
        .strip_prefix("state=")
        .is_some_and(|s| s.len() == 64 && s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
    path_ok && state_ok
}

/// The page that posts a new GitHub App's manifest by itself, or why it will not be made. It
/// is made for one purpose and nothing else: `url` must be GitHub's manifest page (see
/// `is_manifest_page`) and the one field `manifest`, not long.
fn form_page(url: &str, fields: &BTreeMap<String, String>) -> Result<String, String> {
    let rest = url
        .strip_prefix(FORM_TARGET)
        .ok_or("Only GitHub's page for a new app can be opened.")?;
    if !is_manifest_page(rest) {
        return Err("That address is not GitHub's page for a new app.".to_string());
    }
    let manifest = match (fields.len(), fields.get("manifest")) {
        (1, Some(value)) => value,
        _ => return Err("The form has one field, \"manifest\".".to_string()),
    };
    if manifest.len() > 64 * 1024 {
        return Err("The manifest is far longer than it should be.".to_string());
    }
    let inputs = format!(
        "<input type=\"hidden\" name=\"manifest\" value=\"{}\">\n",
        html_escape(manifest)
    );
    Ok(format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Continue to GitHub</title>\n\
<style>body{{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}}</style>\n\
</head><body>\n<h1>Continue to GitHub</h1>\n\
<p>Sending the app's description to GitHub, which asks you to confirm it. If nothing happens, press the button.</p>\n\
<form id=\"f\" method=\"post\" action=\"{}\">\n{}<button type=\"submit\">Continue to GitHub</button>\n</form>\n\
<script>document.getElementById('f').submit();</script>\n</body></html>\n",
        html_escape(url),
        inputs
    ))
}

/// The system's own command for opening `path` in the default application (a browser, for a page).
fn opener(path: &Path) -> std::process::Command {
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        command.arg(path);
        command
    }
    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler").arg(path);
        command
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(path);
        command
    }
}

/// Creates a file that must not exist yet (so a planted link is never followed), readable only
/// by this account.
fn write_new_private(path: &Path, content: &str) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("Could not write {}: {}", path.display(), e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("Could not write {}: {}", path.display(), e))
}

/// Posts a form to GitHub in the person's default browser. The app's own window is not the browser
/// GitHub should ask to confirm an app, so a page that submits the form by itself is written to
/// `~/.clerq/forms` (this account only), opened with the system's opener and deleted after two
/// minutes; any left behind by an earlier run are deleted too.
#[tauri::command]
fn open_form(url: String, fields: BTreeMap<String, String>) -> Result<(), String> {
    let page = form_page(&url, &fields)?;
    let dir = clerq_dir()?.join("forms");
    ensure_private_dir(&dir)?;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > FORM_KEPT * 5);
            if old {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let file = dir.join(format!("form-{}-{}.html", nanos, std::process::id()));
    write_new_private(&file, &page)?;
    let mut child = match opener(&file).spawn() {
        Ok(child) => child,
        Err(e) => {
            let _ = fs::remove_file(&file);
            return Err(format!("Could not open a browser: {}", e));
        }
    };
    std::thread::spawn(move || {
        let _ = child.wait();
        std::thread::sleep(FORM_KEPT);
        let _ = fs::remove_file(&file);
    });
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

/// The folder of plugins this app carries inside `resources` (`bundled-plugins/`, see
/// `bundle.resources` in tauri.conf.json), when it is there. The gateway reads it as
/// `CLERQ_BUNDLED_PLUGINS_DIR`: each folder in it is a plugin, approved if it is exactly
/// what the gateway lists as shipped.
fn bundled_plugins_in(resources: &Path) -> Option<PathBuf> {
    let dir = resources.join("bundled-plugins");
    dir.is_dir().then_some(dir)
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
            if let Some(dir) = app
                .path()
                .resource_dir()
                .ok()
                .and_then(|resources| bundled_plugins_in(&resources))
            {
                cmd = cmd.env("CLERQ_BUNDLED_PLUGINS_DIR", dir.to_string_lossy().as_ref());
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
            gateway_token,
            open_form
        ])
        .run(tauri::generate_context!())
        .expect("error while running Clerq desktop application");
}

#[cfg(test)]
mod tests {
    use super::{bundled_plugins_in, form_page, gateway_line, log_writer, upsert_env_line};
    use std::collections::BTreeMap;
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

    const STATE: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn manifest_fields(value: &str) -> BTreeMap<String, String> {
        BTreeMap::from([("manifest".to_string(), value.to_string())])
    }

    fn page_url(path: &str) -> String {
        format!("https://github.com/{}?state={}", path, STATE)
    }

    #[test]
    fn the_form_page_posts_one_escaped_field_to_github() {
        let url = page_url("settings/apps/new");
        let page = form_page(&url, &manifest_fields("{\"name\":\"A \\\"<b>\\\" & co\"}")).unwrap();
        assert!(page.contains(&format!("method=\"post\" action=\"{}\"", url)));
        assert!(page.contains("name=\"manifest\""));
        assert!(page.contains("&lt;b&gt;"));
        assert!(page.contains("&amp; co"));
        assert!(!page.contains("<b>"));
        assert!(page.contains("document.getElementById('f').submit()"));
        assert_eq!(page.matches("<input").count(), 1);
    }

    #[test]
    fn the_form_page_takes_the_page_for_a_new_app_for_a_person_or_an_organisation() {
        let fields = manifest_fields("{}");
        assert!(form_page(&page_url("settings/apps/new"), &fields).is_ok());
        assert!(form_page(
            &page_url("organizations/acme-org/settings/apps/new"),
            &fields
        )
        .is_ok());
        assert!(form_page(&page_url("organizations/A1/settings/apps/new"), &fields).is_ok());
    }

    #[test]
    fn the_form_page_will_not_post_to_any_other_page_of_github_or_anywhere_else() {
        let fields = manifest_fields("{}");
        for url in [
            // Not GitHub, or not https.
            "http://github.com/settings/apps/new?state=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            format!("https://github.com.evil.example/settings/apps/new?state={}", STATE),
            format!("https://evil.example/https://github.com/settings/apps/new?state={}", STATE),
            format!("https://user@github.com/settings/apps/new?state={}", STATE),
            "javascript:alert(1)".to_string(),
            "file:///etc/passwd".to_string(),
            String::new(),
            // GitHub, but not the page for a new app.
            "https://github.com/".to_string(),
            page_url("settings/tokens/new"),
            page_url("settings/apps/new/extra"),
            page_url("settings/apps"),
            page_url("login/oauth/authorize"),
            page_url("organizations/settings/apps/new"),
            page_url("organizations/a/b/settings/apps/new"),
            page_url("../settings/apps/new"),
            page_url("settings/apps/new/"),
            // A bad organisation name.
            page_url("organizations/-acme/settings/apps/new"),
            page_url("organizations/ac me/settings/apps/new"),
            page_url("organizations/ac%2Fme/settings/apps/new"),
            page_url(&format!("organizations/{}/settings/apps/new", "a".repeat(40))),
            // A missing, short, long or odd state, or more query.
            "https://github.com/settings/apps/new".to_string(),
            "https://github.com/settings/apps/new?state=abc".to_string(),
            format!("https://github.com/settings/apps/new?state={}0", STATE),
            format!("https://github.com/settings/apps/new?state={}", STATE.to_uppercase()),
            format!("https://github.com/settings/apps/new?state={}&x=1", STATE),
            format!("https://github.com/settings/apps/new?x=1&state={}", STATE),
            format!("https://github.com/settings/apps/new?state={}#x", STATE),
            format!("https://github.com/settings/apps/new?state={}\" onload=\"y", STATE),
            format!("https://github.com/settings/apps/new?state={} ", STATE),
        ] {
            assert!(form_page(&url, &fields).is_err(), "{} was accepted", url);
        }
    }

    #[test]
    fn the_form_page_has_exactly_one_field_named_manifest_and_not_a_long_one() {
        let url = page_url("settings/apps/new");
        assert!(form_page(&url, &BTreeMap::new()).is_err());
        let other = BTreeMap::from([("code".to_string(), "x".to_string())]);
        assert!(form_page(&url, &other).is_err());
        let mut two = manifest_fields("{}");
        two.insert("extra".to_string(), "x".to_string());
        assert!(form_page(&url, &two).is_err());
        assert!(form_page(&url, &manifest_fields(&"x".repeat(64 * 1024 + 1))).is_err());
        assert!(form_page(&url, &manifest_fields(&"x".repeat(64 * 1024))).is_ok());
    }

    #[test]
    fn finds_the_plugins_the_app_carries_only_when_the_folder_is_there() {
        let root =
            std::env::temp_dir().join(format!("clerq-bundled-plugins-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(bundled_plugins_in(&root), None);
        // A file of that name is not a folder of plugins.
        std::fs::write(root.join("bundled-plugins"), "x").unwrap();
        assert_eq!(bundled_plugins_in(&root), None);
        std::fs::remove_file(root.join("bundled-plugins")).unwrap();
        std::fs::create_dir_all(root.join("bundled-plugins").join("chat")).unwrap();
        assert_eq!(
            bundled_plugins_in(&root),
            Some(root.join("bundled-plugins"))
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
