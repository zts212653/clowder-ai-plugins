use clowder_wechat_link::{account_service::AccountService, stdio};
use std::{ffi::OsString, io, path::PathBuf, sync::Arc};

fn configure(args: Vec<OsString>) -> io::Result<Option<Arc<AccountService>>> {
    if args.is_empty() {
        return Ok(None);
    }
    let (path, initialize) = match args.as_slice() {
        [flag, path] if flag == "--data-dir" => (PathBuf::from(path), false),
        [flag, path, init] if flag == "--data-dir" && init == "--initialize" => {
            (PathBuf::from(path), true)
        }
        _ => return Err(io::Error::other("invalid startup options")),
    };
    if !path.is_absolute() {
        return Err(io::Error::other("invalid private state directory"));
    }
    #[cfg(target_os = "macos")]
    {
        use clowder_wechat_link::{
            keychain::Keychain,
            store::Store,
            vault::{KeyStore, Vault},
        };
        // The default Keychain is opened only after Vault has validated its
        // private directory and identity. No test/default-mode query touches it.
        struct UserKeys;
        impl KeyStore for UserKeys {
            fn load(
                &self,
                id: &[u8; 16],
            ) -> clowder_wechat_link::vault::Result<zeroize::Zeroizing<[u8; 32]>> {
                Keychain::default_for_user()?.load(id)
            }
            fn create(
                &self,
                id: &[u8; 16],
                key: &[u8; 32],
            ) -> clowder_wechat_link::vault::Result<()> {
                Keychain::default_for_user()?.create(id, key)
            }
        }
        let vault = if initialize {
            Vault::create(&path, &UserKeys, b"")
        } else {
            Vault::open(&path, &UserKeys)
        }
        .map_err(|_| io::Error::other("private state unavailable"))?;
        let store = if initialize {
            Store::initialize(vault)
        } else {
            Store::open(vault)
        }
        .map_err(|_| io::Error::other("private state unavailable"))?;
        let service = AccountService::new(Arc::new(store))
            .map_err(|_| io::Error::other("account service unavailable"))?;
        Ok(Some(Arc::new(service)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, initialize);
        Err(io::Error::other("account service unsupported"))
    }
}

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
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    #[cfg(target_os = "macos")]
    if let [flag, path, repair] = args.as_slice() {
        if flag == "--data-dir"
            && (repair == "--reauthorize" || repair == "--recover-initialization")
        {
            // A system dialog must not leave an orphaned credential reader.
            // Host also owns/kills this process, but the process enforces its
            // own bound if the parent crashes before its timeout can run.
            let parent = unsafe { libc::getppid() };
            std::thread::spawn(move || {
                let started = std::time::Instant::now();
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    if unsafe { libc::getppid() } != parent || started.elapsed().as_secs() >= 120 {
                        unsafe { libc::_exit(2) };
                    }
                }
            });
            let initialization = repair == "--recover-initialization";
            let state = if initialization {
                clowder_wechat_link::keychain_repair::recover_initialization(&PathBuf::from(path))
            } else {
                clowder_wechat_link::keychain_repair::reauthorize(&PathBuf::from(path))
            };
            println!(
                "{}",
                serde_json::json!({"product":"clowder-wechat-link", "version":env!("CARGO_PKG_VERSION"), "pid":std::process::id(), "repair":if initialization {"initialization-recovery"} else {"keychain-reauthorization"}, "state":state})
            );
            return Ok(());
        }
    }
    let mut reader = stdin.lock();
    let service = configure(args)?;
    stdio::serve(&mut reader, stdout, service)
}
fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    if run().is_err() {
        eprintln!("connection_service_unavailable");
        std::process::exit(1);
    }
}
