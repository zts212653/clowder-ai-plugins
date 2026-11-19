use std::{
    io::Write,
    process::{Command, Stdio},
};

#[test]
fn real_process_uses_only_bounded_stdio_and_does_not_claim_login_readiness() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_clowder-wechat-link"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"{\"id\":1,\"method\":\"hello\",\"params\":{}}\n{\"id\":2,\"method\":\"profile.export\",\"params\":{\"secret\":\"SENTINEL_PROCESS_SECRET\"}}\n{\"id\":3,\"method\":\"status\"}\n").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(!text.contains("SENTINEL"));
    let replies: Vec<serde_json::Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 3);
    assert_eq!(replies[0]["result"]["accountServiceReady"], false);
    assert_eq!(replies[1]["error"]["code"], "unsupported_method");
    assert_eq!(replies[2]["result"]["authenticated"], false);
    assert!(replies[2]["result"]["egress"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn malformed_startup_and_symlinked_state_never_reach_the_default_keychain() {
    use std::{
        fs,
        os::unix::fs::{symlink, PermissionsExt},
    };
    let mut suffix = [0; 16];
    openssl::rand::rand_bytes(&mut suffix).unwrap();
    let root = std::env::temp_dir().join(format!("clowder-cli-synthetic-{:x?}", suffix));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let target = root.join("original");
    fs::create_dir(&target).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
    let link = root.join("symlink");
    symlink(&target, &link).unwrap();
    for args in [
        vec!["--profile-import".into(), "SENTINEL_PROFILE_SECRET".into()],
        vec!["--data-dir".into(), "relative-path".into()],
        vec![
            "--data-dir".into(),
            link.into_os_string(),
            "--initialize".into(),
        ],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_clowder-wechat-link"))
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(output.stderr, b"connection_service_unavailable\n");
    }
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn one_shot_reauthorization_rejects_missing_state_before_opening_the_default_keychain() {
    let mut nonce = [0; 16];
    openssl::rand::rand_bytes(&mut nonce).unwrap();
    let root = std::env::temp_dir().join(format!("clowder-missing-repair-{nonce:x?}"));
    let output = Command::new(env!("CARGO_BIN_EXE_clowder-wechat-link"))
        .arg("--data-dir")
        .arg(&root)
        .arg("--reauthorize")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["repair"], "keychain-reauthorization");
    assert_eq!(report["state"], "invalid_state");
    assert_eq!(report.as_object().unwrap().len(), 5);
    assert!(!root.exists());
}
