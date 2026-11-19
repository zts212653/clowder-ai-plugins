//! Clowder's pinned protocol subset. No daemon, profile import, media client,
//! automatic downloads, call service or listening socket is included.
//!
//! APIs removed from the upstream client must remain unavailable:
//!
//! ```compile_fail
//! async fn forbidden(client: &wechat_protocol::NativeClient) {
//!     let _ = client.download_avatars(&[]).await;
//! }
//! ```
//!
//! ```compile_fail
//! async fn forbidden(client: &wechat_protocol::NativeClient) {
//!     let _ = client.cdn_config().await;
//! }
//! ```
//!
//! ```compile_fail
//! fn forbidden() {
//!     let _ = wechat_protocol::NativeClient::call_rpc;
//! }
//! ```
//!
//! Transport key/session constructors are not an embedding API:
//!
//! ```compile_fail
//! use wechat_protocol::mmtls::ShortSession;
//! ```
//!
//! ```compile_fail
//! fn forbidden(client: &wechat_protocol::NativeClient) {
//!     let _ = client.export_account_state();
//! }
//! ```
//!
//! Login attempts contain one-time secrets and cannot be serialized as IPC:
//!
//! ```compile_fail
//! fn forbidden(attempt: &wechat_protocol::LoginAttempt) {
//!     let _ = serde_json::to_vec(attempt);
//! }
//! ```

mod business;
mod client;
pub mod contact_sync;
mod crypto;
pub mod errors;
mod mmtls;
mod notice;
pub mod protobuf;
pub mod push;
mod transport;
pub mod wire;
pub use client::*;
pub use errors::{is_session_rejected, AccountInterrupted, Service, ServiceRejected};
pub use transport::{egress_snapshot, EgressRecord};

pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
