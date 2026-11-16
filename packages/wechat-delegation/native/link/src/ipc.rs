//! Closed, bounded stdio frames. Underlying parser errors never leave here.
use crate::account_service::{AccountService, ServiceError};
use crate::store::ConversationLease;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::value::RawValue;
use serde_json::{json, Value};
use std::io::{self, BufRead};
use zeroize::Zeroizing;

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub enum FrameError {
    Io,
    TooLarge,
    Incomplete,
}

pub fn read_frame(reader: &mut impl BufRead) -> Result<Option<Zeroizing<Vec<u8>>>, FrameError> {
    let mut frame = Zeroizing::new(Vec::new());
    loop {
        let available = reader.fill_buf().map_err(|_| FrameError::Io)?;
        if available.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(FrameError::Incomplete)
            };
        }
        let newline = available.iter().position(|&byte| byte == b'\n');
        let count = newline.unwrap_or(available.len());
        if count > MAX_FRAME_BYTES - frame.len() {
            return Err(FrameError::TooLarge);
        }
        frame.extend_from_slice(&available[..count]);
        reader.consume(count + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(Some(frame));
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u64,
    method: String,
    #[serde(default)]
    params: Option<Box<RawValue>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyParams {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OperationParams {
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuthorizationParams {
    account_generation: u64,
    account_identity: String,
    destination: String,
    expires_at_ms: Option<u64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PauseParams {
    account_generation: u64,
    destination: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SendParams {
    lease: ConversationLease,
    operation_id: String,
    text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SyncParams {
    account_generation: u64,
    account_identity: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EventParams {
    account_generation: u64,
    after: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MessageParams {
    account_generation: u64,
    message_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DirectoryStartParams {
    operation_id: String,
    account_generation: u64,
    account_identity: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DirectoryPageParams {
    operation_id: String,
    offset: usize,
}
enum ParsedParams {
    Empty,
    Operation(String),
    Authorize(AuthorizationParams),
    Pause(PauseParams),
    Send(SendParams),
    Sync(SyncParams),
    Events(EventParams),
    Message(MessageParams),
    DirectoryStart(DirectoryStartParams),
    DirectoryPage(DirectoryPageParams),
}
fn params<T: DeserializeOwned>(request: &Request) -> Result<T, ()> {
    serde_json::from_str(request.params.as_ref().map_or("{}", |p| p.get())).map_err(|_| ())
}
fn valid_operation_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
fn parse(frame: &[u8]) -> Result<Request, ()> {
    match serde_json::from_slice::<Request>(frame) {
        Ok(value) if value.id > 0 && value.id <= 9_007_199_254_740_991 => Ok(value),
        _ => Err(()),
    }
}
fn error(id: Option<u64>, code: &'static str) -> Value {
    json!({"id":id,"error":{"code":code}})
}

pub fn respond(frame: &[u8]) -> Value {
    respond_with(frame, None)
}
pub fn is_blocking(frame: &[u8]) -> bool {
    parse(frame).is_ok_and(|r| {
        matches!(
            r.method.as_str(),
            "login.start"
                | "login.poll"
                | "conversation.authorize"
                | "text.send"
                | "sync.pull"
                | "directory.advance"
                | "session.resume"
        )
    })
}
pub fn busy_response(frame: &[u8]) -> Value {
    error(parse(frame).ok().map(|r| r.id), "operation_busy")
}
pub fn respond_with(frame: &[u8], service: Option<&AccountService>) -> Value {
    let request = match parse(frame) {
        Ok(value) => value,
        _ => return error(None, "invalid_request"),
    };
    if request.method.len() > 64
        || !matches!(
            request.method.as_str(),
            "hello"
                | "status"
                | "login.start"
                | "login.poll"
                | "login.operation"
                | "login.cancel"
                | "account.disconnect"
                | "conversation.authorize"
                | "conversation.pause"
                | "text.send"
                | "send.receipt"
                | "send.cancel"
                | "sync.pull"
                | "events.page"
                | "message.get"
                | "directory.start"
                | "directory.advance"
                | "directory.operation"
                | "directory.page"
                | "session.resume"
                | "session.operation"
                | "session.cancel"
        )
    {
        return error(Some(request.id), "unsupported_method");
    }
    let parsed = if request.method.starts_with("login.")
        || matches!(
            request.method.as_str(),
            "send.receipt"
                | "send.cancel"
                | "directory.advance"
                | "directory.operation"
                | "session.operation"
                | "session.cancel"
        ) {
        match params::<OperationParams>(&request) {
            Ok(value) if valid_operation_id(&value.operation_id) => {
                ParsedParams::Operation(value.operation_id)
            }
            _ => return error(Some(request.id), "invalid_params"),
        }
    } else if request.method == "conversation.authorize" {
        match params::<AuthorizationParams>(&request) {
            Ok(value)
                if value
                    .expires_at_ms
                    .is_none_or(|v| v > 0 && v <= 9_007_199_254_740_991) =>
            {
                ParsedParams::Authorize(value)
            }
            _ => return error(Some(request.id), "invalid_params"),
        }
    } else if request.method == "conversation.pause" {
        match params::<PauseParams>(&request) {
            Ok(value) => ParsedParams::Pause(value),
            _ => return error(Some(request.id), "invalid_params"),
        }
    } else if request.method == "text.send" {
        match params::<SendParams>(&request) {
            Ok(value)
                if valid_operation_id(&value.operation_id)
                    && !value.text.trim().is_empty()
                    && value.text.len() <= 65536
                    && !value.text.contains('\0') =>
            {
                ParsedParams::Send(value)
            }
            _ => return error(Some(request.id), "invalid_params"),
        }
    } else if matches!(
        request.method.as_str(),
        "directory.start" | "session.resume"
    ) {
        match params::<DirectoryStartParams>(&request) {
            Ok(p) if valid_operation_id(&p.operation_id) && p.account_identity.len() <= 256 => {
                ParsedParams::DirectoryStart(p)
            }
            _ => return error(Some(request.id), "invalid_params"),
        }
    } else if request.method == "directory.page" {
        match params::<DirectoryPageParams>(&request) {
            Ok(p) if valid_operation_id(&p.operation_id) && p.offset <= 10000 => {
                ParsedParams::DirectoryPage(p)
            }
            _ => return error(Some(request.id), "invalid_params"),
        }
    } else if request.method == "sync.pull" {
        match params::<SyncParams>(&request) {
            Ok(value) if value.account_identity.len() <= 256 => ParsedParams::Sync(value),
            _ => return error(Some(request.id), "invalid_params"),
        }
    } else if request.method == "events.page" {
        match params::<EventParams>(&request) {
            Ok(value)
                if value.after.len() <= 16
                    && value.after.parse::<u64>().is_ok_and(|n| {
                        n <= 9_007_199_254_740_991 && n.to_string() == value.after
                    }) =>
            {
                ParsedParams::Events(value)
            }
            _ => return error(Some(request.id), "invalid_params"),
        }
    } else if request.method == "message.get" {
        match params::<MessageParams>(&request) {
            Ok(value) if !value.message_id.is_empty() && value.message_id.len() <= 128 => {
                ParsedParams::Message(value)
            }
            _ => return error(Some(request.id), "invalid_params"),
        }
    } else {
        if params::<EmptyParams>(&request).is_err() {
            return error(Some(request.id), "invalid_params");
        }
        ParsedParams::Empty
    };
    let project = |value: Result<Value, ServiceError>| -> Value {
        match value {
            Ok(result) => json!({"id":request.id,"result":result}),
            Err(problem) => error(
                Some(request.id),
                match problem {
                    ServiceError::Busy => "operation_busy",
                    ServiceError::PrivateState => "private_state_unavailable",
                    ServiceError::InvalidOperation => "invalid_operation",
                    ServiceError::Unavailable | ServiceError::SessionRejected => {
                        "account_service_unavailable"
                    }
                    ServiceError::PermissionDenied => "permission_denied",
                },
            ),
        }
    };
    let result = match request.method.as_str() {
        "hello" => {
            let mut capabilities = vec!["stdio-v1", "text-protocol-subset"];
            if service.is_some() {
                capabilities.push("account-login-v1");
                capabilities.push("durable-text-send-v1");
                capabilities.push("durable-text-sync-v1");
                capabilities.push("current-directory-v1");
                capabilities.push("explicit-session-resume-v1");
            }
            json!({"product":"clowder-wechat-link","version":env!("CARGO_PKG_VERSION"),
            "pid":std::process::id(),"protocolVersion":1,
            "upstreamCommit":"ed976d78c1e1cc2a49ad17d1e2c0da023bbb5c8e",
            // API availability is distinct from complete Host/product acceptance.
            "nativeApiAvailable":service.is_some(),
            "capabilities":capabilities,"accountServiceReady":false})
        }
        "status" => {
            let records = match wechat_protocol::egress_snapshot() {
                Ok(value) => value,
                Err(_) => return error(Some(request.id), "observation_unavailable"),
            };
            if let Some(service) = service {
                let mut value = match service.status() {
                    Ok(value) => match serde_json::to_value(value) {
                        Ok(value) => value,
                        Err(_) => return error(Some(request.id), "internal_error"),
                    },
                    Err(error) => return project(Err(error)),
                };
                if let Some(object) = value.as_object_mut() {
                    object.insert("egress".into(), json!(records));
                }
                value
            } else {
                json!({"connection":"not_ready","authenticated":false,"egress":records})
            }
        }
        _ => {
            let Some(service) = service else {
                return error(Some(request.id), "not_ready");
            };
            let value = match (&*request.method, parsed) {
                ("login.start", ParsedParams::Operation(id)) => service
                    .start_login(&id)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("login.poll", ParsedParams::Operation(id)) => service
                    .poll_login(&id)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("login.operation", ParsedParams::Operation(id)) => service
                    .login_operation(&id)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("login.cancel", ParsedParams::Operation(id)) => service
                    .cancel_login(&id)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("account.disconnect", ParsedParams::Empty) => service
                    .disconnect()
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("conversation.authorize", ParsedParams::Authorize(p)) => service
                    .authorize_conversation(
                        p.account_generation,
                        &p.account_identity,
                        &p.destination,
                        p.expires_at_ms,
                    )
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("conversation.pause", ParsedParams::Pause(p)) => service
                    .pause_conversation(p.account_generation, p.destination.as_deref())
                    .map(|_| json!({"paused":true})),
                ("text.send", ParsedParams::Send(p)) => service
                    .send_text(&p.lease, &p.operation_id, &p.text)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("send.receipt", ParsedParams::Operation(id)) => service
                    .send_receipt(&id)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("send.cancel", ParsedParams::Operation(id)) => service
                    .cancel_send(&id)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("sync.pull", ParsedParams::Sync(p)) => service
                    .pull_sync(p.account_generation, &p.account_identity)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("events.page", ParsedParams::Events(p)) => service
                    .events(p.account_generation, &p.after)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("message.get", ParsedParams::Message(p)) => service
                    .message(p.account_generation, &p.message_id)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("directory.start", ParsedParams::DirectoryStart(p)) => service
                    .start_directory(&p.operation_id, p.account_generation, &p.account_identity)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("directory.advance", ParsedParams::Operation(id)) => service
                    .advance_directory(&id)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("directory.operation", ParsedParams::Operation(id)) => service
                    .directory_operation(&id)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("directory.page", ParsedParams::DirectoryPage(p)) => service
                    .directory_page(&p.operation_id, p.offset)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("session.resume", ParsedParams::DirectoryStart(p)) => service
                    .resume_session(&p.operation_id, p.account_generation, &p.account_identity)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("session.operation", ParsedParams::Operation(id)) => service
                    .resume_operation(&id)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                ("session.cancel", ParsedParams::Operation(id)) => service
                    .cancel_resume(&id)
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ServiceError::Unavailable)),
                _ => return error(Some(request.id), "unsupported_method"),
            };
            return project(value);
        }
    };
    json!({"id":request.id,"result":result})
}

pub fn framing_error() -> Value {
    error(None, "invalid_frame")
}
pub fn write_response(writer: &mut impl io::Write, response: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, response)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_fields_duplicate_keys_and_secret_params_never_echo() {
        for input in [
            br#"{"id":1,"method":"profile.export","params":{"key":"SENTINEL_SESSION_SECRET"}}"#
                .as_slice(),
            br#"{"id":1,"method":"hello","password":"SENTINEL_SESSION_SECRET"}"#.as_slice(),
            br#"{"id":1,"method":"status","params":{"secret":"SENTINEL_SESSION_SECRET"}}"#
                .as_slice(),
            br#"{"id":1,"id":2,"method":"hello"}"#.as_slice(),
        ] {
            let reply = respond(input);
            assert!(reply.get("error").is_some());
            assert!(!reply.to_string().contains("SENTINEL"));
        }
    }
    #[test]
    fn a_bounded_frame_reader_preserves_boundaries_and_rejects_truncation() {
        let mut input = io::Cursor::new(b"one\ntwo\n");
        assert_eq!(
            read_frame(&mut input)
                .ok()
                .flatten()
                .as_deref()
                .map(|v| v.as_slice()),
            Some(b"one".as_slice())
        );
        assert_eq!(
            read_frame(&mut input)
                .ok()
                .flatten()
                .as_deref()
                .map(|v| v.as_slice()),
            Some(b"two".as_slice())
        );
        assert!(matches!(read_frame(&mut input), Ok(None)));
        assert!(matches!(
            read_frame(&mut io::Cursor::new(b"partial")),
            Err(FrameError::Incomplete)
        ));
        assert!(matches!(
            read_frame(&mut io::Cursor::new(vec![b'x'; MAX_FRAME_BYTES + 1])),
            Err(FrameError::TooLarge)
        ));
    }
}
