//! Live desktop metadata is separate from account/session authority.
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    product: &'static str,
    version: &'static str,
    pid: u32,
    probe: &'static str,
    state: &'static str,
    app_version: Option<String>,
}
fn state(code: i32) -> &'static str {
    match code {
        0 => "unsupported",
        1 => "not_found",
        2 => "not_running",
        3 => "multiple_instances",
        4 => "unverified_app",
        5 => "permission_required",
        6 => "logged_in_ui",
        _ => "unknown",
    }
}
pub fn probe(prompt: bool) -> Report {
    #[cfg(target_os = "macos")]
    let (code, app_version) = {
        unsafe extern "C" {
            fn cw_desktop_probe(
                prompt: bool,
                version: *mut std::ffi::c_char,
                capacity: usize,
            ) -> i32;
        }
        let mut buffer = [0 as std::ffi::c_char; 32];
        let code = unsafe { cw_desktop_probe(prompt, buffer.as_mut_ptr(), buffer.len()) };
        let version = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
            .to_str()
            .ok()
            .filter(|v| {
                !v.is_empty() && v.len() < 32 && v.bytes().all(|b| b.is_ascii_digit() || b == b'.')
            })
            .map(str::to_owned);
        (code, version)
    };
    #[cfg(not(target_os = "macos"))]
    let (code, app_version) = {
        let _ = prompt;
        (0, None)
    };
    Report {
        product: "clowder-wechat-desktop",
        version: env!("CARGO_PKG_VERSION"),
        pid: std::process::id(),
        probe: "desktop-wechat",
        state: state(code),
        app_version,
    }
}
