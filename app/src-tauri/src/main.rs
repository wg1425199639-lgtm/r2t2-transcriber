use std::{
    env, fs,
    io::{self, Write},
    net::TcpStream,
    os::unix::{fs::PermissionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, RunEvent};

#[derive(Default)]
struct Scheduler(Mutex<Option<Child>>);

impl Scheduler {
    fn start(&self, resource_dir: Option<&Path>, app_data_dir: Option<&Path>) -> io::Result<()> {
        let address = ([127, 0, 0, 1], 47800).into();
        if TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok() {
            return Ok(());
        }

        let directory = scheduler_directory(resource_dir);
        let mut command = if let Some(binary) = env::var_os("SCHEDULER_BIN") {
            let path = Path::new(&binary);
            let program = if path.is_relative() && path.components().count() > 1 {
                env::current_dir()?.join(path)
            } else {
                path.to_path_buf()
            };
            Command::new(program)
        } else {
            let Some((directory, _)) = &directory else {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "scheduler directory was not found; set SCHEDULER_BIN",
                ));
            };
            let node = find_node(resource_dir)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Node was not found"))?;
            let mut command = Command::new(node);
            if directory.join("dist/main.js").is_file() {
                command.arg("dist/main.js");
            } else {
                command.args(["--import", "tsx", "src/main.ts"]);
            }
            command.args(["--engine", "r2t2"]);
            command
        };
        if let Some((directory, bundled)) = directory {
            command.current_dir(directory);
            if bundled && env::var_os("DATA_DIR").is_none() {
                let data = app_data_dir
                    .ok_or_else(|| io::Error::other("Application data directory was not found"))?
                    .join("data");
                fs::create_dir_all(&data)?;
                command.env("DATA_DIR", data);
            }
        }
        if let Some(resource_dir) = resource_dir {
            for (variable, relative_path) in [
                ("CAPTURE_PATH", "bin/capture-mac"),
                ("ASR_SERVER_PATH", "bin/audiocpp_server"),
                ("VAD_MODEL_PATH", "models/silero_vad.onnx"),
            ] {
                let path = resource_dir.join(relative_path);
                if env::var_os(variable).is_none() && path.is_file() {
                    command.env(variable, path);
                }
            }
        }
        if env::var_os("ASR_MODEL_PATH").is_none() {
            if let Some(model) = find_asr_model(app_data_dir) {
                command.env("ASR_MODEL_PATH", model);
            }
        }

        let child = command
            .env("ORT_DISABLE_TELEMETRY", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .process_group(0)
            .spawn()?;
        *self.0.lock().unwrap_or_else(|err| err.into_inner()) = Some(child);
        Ok(())
    }

    fn stop(&self) {
        let Some(mut child) = self.0.lock().unwrap_or_else(|err| err.into_inner()).take() else {
            return;
        };
        stop_scheduler(&mut child);
    }
}

impl Drop for Scheduler {
    fn drop(&mut self) {
        self.stop();
    }
}

fn launch_paths() -> impl Iterator<Item = PathBuf> {
    env::current_exe()
        .ok()
        .into_iter()
        .chain(env::current_dir().ok())
}

fn scheduler_directory(resource_dir: Option<&Path>) -> Option<(PathBuf, bool)> {
    if let Some(directory) = resource_dir.map(|path| path.join("scheduler")) {
        if directory.join("dist/main.js").is_file() {
            return Some((directory, true));
        }
    }
    launch_paths()
        .chain([PathBuf::from(env!("CARGO_MANIFEST_DIR"))])
        .find_map(|path| {
            path.ancestors()
                .map(|ancestor| ancestor.join("scheduler"))
                .find(|directory| {
                    directory.join("dist/main.js").is_file()
                        || directory.join("src/main.ts").is_file()
                })
        })
        .map(|directory| (directory, false))
}

fn find_asr_model(app_data_dir: Option<&Path>) -> Option<PathBuf> {
    const MODEL: &str = "r2t2-q8_0.gguf";
    const MODEL_SUBDIR: &str = "Confucius4-R2T2-GGUF";

    app_data_dir
        .into_iter()
        .flat_map(|path| {
            let models = path.join("models");
            [models.join(MODEL), models.join(MODEL_SUBDIR).join(MODEL)]
        })
        .chain(env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Models")
                .join(MODEL_SUBDIR)
                .join(MODEL)
        }))
        .chain(launch_paths().filter_map(|path| {
            path.ancestors()
                .map(|ancestor| ancestor.join("models").join(MODEL_SUBDIR).join(MODEL))
                .find(|model| model.is_file())
        }))
        .find(|model| model.is_file())
}

fn find_node(resource_dir: Option<&Path>) -> Option<PathBuf> {
    resource_dir
        .map(|directory| directory.join("bin/node"))
        .into_iter()
        .chain(
            env::split_paths(&env::var_os("PATH").unwrap_or_default())
                .map(|directory| directory.join("node")),
        )
        .chain([
            PathBuf::from("/opt/homebrew/bin/node"),
            PathBuf::from("/usr/local/bin/node"),
        ])
        .filter_map(|path| path.canonicalize().ok())
        .find(|path| {
            path.metadata().is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })
}

fn stop_scheduler(child: &mut Child) {
    let pid = child.id() as i32;
    let deadline = Instant::now() + Duration::from_secs(10);
    // The scheduler handles SIGTERM and shuts down its own children in order.
    if matches!(child.try_wait(), Ok(None)) {
        signal(pid, 15);
        while Instant::now() < deadline {
            if !matches!(child.try_wait(), Ok(None)) {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
    // A dedicated process group also covers descendants left by a failed shutdown.
    signal(-pid, 9);
    if let Err(error) = child.wait() {
        eprintln!("Could not reap scheduler: {error}");
    }
}

fn signal(pid: i32, number: i32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }

    // SAFETY: kill takes a PID or process group and signal number by value.
    if unsafe { kill(pid, number) } == -1 {
        let error = io::Error::last_os_error();
        // POSIX ESRCH on macOS means the process or group already exited.
        if error.raw_os_error() != Some(3) {
            eprintln!("Could not signal scheduler ({pid}): {error}");
        }
    }
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let path = Path::new(&path);
    if !path.is_absolute() || !path.is_file() {
        return Err("Export file does not exist".into());
    }

    #[cfg(target_os = "macos")]
    let result = Command::new("/usr/bin/open").arg("-R").arg(path).status();
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer").arg("/select,").arg(path).status();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = Err::<std::process::ExitStatus, _>(io::Error::new(
        io::ErrorKind::Unsupported,
        "Revealing files is unsupported on this platform",
    ));

    let status = result.map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Could not reveal export file ({status})"))
    }
}

#[tauri::command]
fn write_export_file(
    app: tauri::AppHandle,
    default_name: String,
    content: String,
) -> Result<String, String> {
    let extension = match default_name.as_str() {
        "转写.md" => "md",
        "转写.txt" => "txt",
        _ => return Err("Invalid export filename".into()),
    };
    let directory = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    for index in 0..1000 {
        let filename = if index == 0 {
            default_name.clone()
        } else {
            format!("转写 ({index}).{extension}")
        };
        let path = directory.join(filename);
        let export_path = path.to_str().ok_or("Invalid export path")?.to_owned();
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        };
        if let Err(error) = file.write_all(content.as_bytes()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(error.to_string());
        }
        return Ok(export_path);
    }
    Err("No available export filename".into())
}

#[tauri::command]
fn toggle_overlay_window(
    app: tauri::AppHandle,
    visible: Option<bool>,
    click_through: Option<bool>,
) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("overlay") {
        let show = visible.unwrap_or_else(|| !window.is_visible().unwrap_or(false));
        if let Some(enabled) = click_through {
            window
                .set_ignore_cursor_events(enabled)
                .map_err(|error| error.to_string())?;
            let _ = window.eval(format!(
                "window.dispatchEvent(new CustomEvent('overlay-lock', {{ detail: {enabled} }}));"
            ));
        }
        if show {
            window.show().map_err(|error| error.to_string())?;
        } else {
            window.hide().map_err(|error| error.to_string())?;
        }
        return Ok(show);
    }
    if visible == Some(false) {
        return Ok(false);
    }

    const WIDTH: f64 = 760.0;
    const HEIGHT: f64 = 116.0;
    const BOTTOM_MARGIN: f64 = 64.0;
    let locked = click_through.unwrap_or(true);
    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "overlay",
        tauri::WebviewUrl::App(
            format!(
                "index.html?view=overlay&locked={}",
                if locked { "1" } else { "0" }
            )
            .into(),
        ),
    )
    .inner_size(WIDTH, HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .background_color(tauri::window::Color(0, 0, 0, 0))
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .focusable(false)
    .shadow(false)
    .visible(false);
    let builder = match app.primary_monitor() {
        Ok(Some(monitor)) => {
            let work_area = monitor.work_area();
            let scale = monitor.scale_factor();
            let origin = work_area.position.to_logical::<f64>(scale);
            let size = work_area.size.to_logical::<f64>(scale);
            builder.position(
                origin.x + (size.width - WIDTH) / 2.0,
                origin.y + size.height - HEIGHT - BOTTOM_MARGIN,
            )
        }
        _ => builder.center(),
    };
    let window = builder.build().map_err(|error| error.to_string())?;
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
    window
        .set_ignore_cursor_events(locked)
        .and_then(|()| window.show())
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn set_overlay_click_through(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window
            .set_ignore_cursor_events(enabled)
            .map_err(|error| error.to_string())?;
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('overlay-lock', {{ detail: {enabled} }}));"
        ));
    }
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Scheduler::default())
        .invoke_handler(tauri::generate_handler![
            reveal_in_finder,
            write_export_file,
            toggle_overlay_window,
            set_overlay_click_through
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(overlay) = window.get_webview_window("overlay") {
                    if let Err(error) = overlay.close() {
                        eprintln!("Could not close overlay: {error}");
                    }
                }
            }
        })
        .setup(|app| {
            let resource_dir = app.path().resource_dir().ok();
            let app_data_dir = app.path().app_data_dir().ok();
            app.state::<Scheduler>()
                .start(resource_dir.as_deref(), app_data_dir.as_deref())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not initialize the Tauri application");

    app.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            app.state::<Scheduler>().stop();
        }
    });
}
