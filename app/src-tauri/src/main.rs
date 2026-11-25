use std::{
    env, io,
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
    fn start(&self) -> io::Result<()> {
        let address = ([127, 0, 0, 1], 47800).into();
        if TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok() {
            return Ok(());
        }

        let directory = scheduler_directory();
        let mut command = if let Some(binary) = env::var_os("SCHEDULER_BIN") {
            let path = Path::new(&binary);
            let program = if path.is_relative() && path.components().count() > 1 {
                env::current_dir()?.join(path)
            } else {
                path.to_path_buf()
            };
            Command::new(program)
        } else {
            let node = find_node()
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Node was not found"))?;
            let mut command = Command::new(node);
            command.args(["--import", "tsx", "src/main.ts", "--engine", "r2t2"]);
            if directory.is_none() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "scheduler directory was not found; set SCHEDULER_BIN",
                ));
            }
            command
        };
        if let Some(directory) = directory {
            command.current_dir(directory);
        }

        let child = command
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

fn scheduler_directory() -> Option<PathBuf> {
    env::current_exe()
        .ok()
        .into_iter()
        .chain(env::current_dir().ok())
        .chain([PathBuf::from(env!("CARGO_MANIFEST_DIR"))])
        .find_map(|path| {
            path.ancestors()
                .map(|ancestor| ancestor.join("scheduler"))
                .find(|directory| directory.join("src/main.ts").is_file())
        })
}

fn find_node() -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH").unwrap_or_default())
        .map(|directory| directory.join("node"))
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

fn main() {
    let app = tauri::Builder::default()
        .manage(Scheduler::default())
        .setup(|app| {
            app.state::<Scheduler>().start()?;
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
