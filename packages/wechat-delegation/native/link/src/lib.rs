//! Internal account-service components. None of these types are IPC DTOs.
#[cfg(target_os = "macos")]
pub mod keychain;
pub mod store;
pub mod vault;
