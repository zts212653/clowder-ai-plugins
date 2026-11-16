//! Closed, bounded stdio frames. Underlying parser errors never leave here.
use serde::Deserialize;
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
    params: Value,
}
fn error(id: Option<u64>, code: &'static str) -> Value {
    json!({"id":id,"error":{"code":code}})
}

pub fn respond(frame: &[u8]) -> Value {
    let request = match serde_json::from_slice::<Request>(frame) {
        Ok(value) if value.id > 0 && value.id <= 9_007_199_254_740_991 => value,
        _ => return error(None, "invalid_request"),
    };
    if request.method.len() > 64 || !matches!(request.method.as_str(), "hello" | "status") {
        return error(Some(request.id), "unsupported_method");
    }
    if !request.params.is_null()
        && !request
            .params
            .as_object()
            .is_some_and(|params| params.is_empty())
    {
        return error(Some(request.id), "invalid_params");
    }
    let result = match request.method.as_str() {
        "hello" => json!({"product":"clowder-wechat-link","version":env!("CARGO_PKG_VERSION"),
            "pid":std::process::id(),"protocolVersion":1,
            "upstreamCommit":"ed976d78c1e1cc2a49ad17d1e2c0da023bbb5c8e",
            // Login/send capabilities are deliberately absent until implemented.
            "capabilities":["stdio-v1","text-protocol-subset"],"accountServiceReady":false}),
        "status" => {
            let records = match wechat_protocol::egress_snapshot() {
                Ok(value) => value,
                Err(_) => return error(Some(request.id), "observation_unavailable"),
            };
            json!({"connection":"not_ready","authenticated":false,"egress":records})
        }
        _ => unreachable!(),
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
