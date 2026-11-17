use std::process::{Command, Stdio};

#[test]
fn desktop_status_is_a_closed_read_only_mode_without_account_service_initialization() {
    let output = Command::new(env!("CARGO_BIN_EXE_clowder-wechat-desktop"))
        .arg("--desktop-status")
        .env_clear()
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "read-only desktop mode must be available"
    );
    assert!(output.stderr.is_empty());
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["product"], "clowder-wechat-desktop");
    assert_eq!(result["probe"], "desktop-wechat");
    assert_eq!(result["version"], "0.1.0");
    assert!(result["pid"].as_u64().unwrap() > 0);
    assert!(result["state"].is_string());
    assert_eq!(result.as_object().unwrap().len(), 6);
    for forbidden in [
        "cookie",
        "token",
        "accountIdentity",
        "session_key",
        "username",
        "windowTitle",
    ] {
        assert!(result.get(forbidden).is_none());
    }
    let invalid = Command::new(env!("CARGO_BIN_EXE_clowder-wechat-desktop"))
        .args(["--desktop-status", "SENTINEL_UNSUPPORTED"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!invalid.status.success());
    assert!(invalid.stdout.is_empty());
}
