mod desktop;
fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    for (name, _) in std::env::vars_os() {
        std::env::remove_var(name);
    }
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let [flag] = args.as_slice() else {
        std::process::exit(1);
    };
    if flag != "--desktop-status" && flag != "--request-desktop-access" {
        std::process::exit(1);
    }
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn getppid() -> i32;
            fn _exit(code: i32) -> !;
        }
        let parent = unsafe { getppid() };
        std::thread::spawn(move || {
            let started = std::time::Instant::now();
            loop {
                std::thread::sleep(std::time::Duration::from_millis(100));
                if unsafe { getppid() } != parent || started.elapsed().as_secs() >= 15 {
                    unsafe { _exit(2) }
                }
            }
        });
    }
    // The helper has no credential/store/network crate or generic operation.
    // Prompting is asynchronous and available only through the explicit flag.
    let report = desktop::probe(flag == "--request-desktop-access");
    match serde_json::to_string(&report) {
        Ok(json) => println!("{json}"),
        Err(_) => std::process::exit(1),
    }
}
