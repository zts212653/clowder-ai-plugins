mod ipc;
use std::io;

fn run() -> io::Result<()> {
    // Before any worker is created, remove inherited process configuration.
    for (name, _) in std::env::vars_os() {
        std::env::remove_var(name);
    }
    #[cfg(unix)]
    unsafe {
        let limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::setrlimit(libc::RLIMIT_CORE, &limit) != 0 {
            return Err(io::Error::other("hardening unavailable"));
        }
    }
    #[cfg(target_os = "macos")]
    unsafe {
        if libc::ptrace(31, 0, std::ptr::null_mut(), 0) != 0 {
            return Err(io::Error::other("hardening unavailable"));
        }
    }
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    loop {
        match ipc::read_frame(&mut reader) {
            Ok(Some(frame)) => ipc::write_response(&mut writer, &ipc::respond(&frame))?,
            Ok(None) => return Ok(()),
            Err(_) => {
                ipc::write_response(&mut writer, &ipc::framing_error())?;
                return Err(io::Error::other("invalid frame"));
            }
        }
    }
}
fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    if run().is_err() {
        eprintln!("connection_service_unavailable");
        std::process::exit(1);
    }
}
