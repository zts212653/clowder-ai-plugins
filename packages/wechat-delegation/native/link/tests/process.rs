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
