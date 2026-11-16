//! Application ACL-bound file-Keychain backend for the macOS CLI.
//! Normal operations never enable UI. The one-shot repair caller can authorize
//! an existing item through the system dialog; no password or raw key IPC.
use crate::vault::{KeyStore, Result, VaultError};
use std::ffi::c_void;
use zeroize::Zeroizing;
type Ref = *const c_void;
extern "C" {
    fn SecKeychainSetUserInteractionAllowed(allowed: u8) -> i32;
    fn SecKeychainCopyDefault(keychain: *mut Ref) -> i32;
    fn CFRelease(value: Ref);
    fn cw_key_create(keychain: Ref, id: *const u8, key: *const u8) -> i32;
    fn cw_key_load(keychain: Ref, id: *const u8, key: *mut u8) -> i32;
    fn cw_key_reauthorize(keychain: Ref, id: *const u8, key: *mut u8) -> i32;
}
pub struct Keychain {
    handle: Ref,
}
impl Keychain {
    /// Called only when the account service is explicitly initialized/opened.
    /// Tests never call this: they supply a new isolated synthetic keychain.
    pub fn default_for_user() -> Result<Self> {
        if unsafe { libc::geteuid() == 0 || libc::geteuid() != libc::getuid() } {
            return Err(VaultError::KeyUnavailable);
        }
        if unsafe { SecKeychainSetUserInteractionAllowed(0) } != 0 {
            return Err(VaultError::KeyUnavailable);
        }
        let mut handle = std::ptr::null();
        if unsafe { SecKeychainCopyDefault(&mut handle) } != 0 || handle.is_null() {
            return Err(VaultError::KeyUnavailable);
        }
        Ok(Self { handle })
    }
    /// Only for a dedicated one-shot process entered by an explicit owner
    /// action. Never call this in the multithreaded account service.
    pub fn reauthorize_existing(&self, id: &[u8; 16]) -> Result<Zeroizing<[u8; 32]>> {
        let mut key = Zeroizing::new([0; 32]);
        match unsafe { cw_key_reauthorize(self.handle, id.as_ptr(), key.as_mut_ptr()) } {
            0 => {}
            -25300 => return Err(VaultError::KeyMissing),
            -25293 => return Err(VaultError::KeyAccessDenied),
            -128 => return Err(VaultError::AuthorizationCancelled),
            -25308 | -25315 | -25320 => return Err(VaultError::InteractionUnavailable),
            _ => return Err(VaultError::KeyUnavailable),
        }
        // Reject if even a second noninteractive read fails. Fresh process
        // preparation is still required to test cross-process retained trust;
        // success here alone does not prove an "Always Allow" was persisted.
        let accepted = self
            .load(id)
            .map_err(|_| VaultError::AuthorizationNotPersistent)?;
        if !openssl::memcmp::eq(key.as_ref(), accepted.as_ref()) {
            return Err(VaultError::KeyUnavailable);
        }
        Ok(key)
    }
}
impl Drop for Keychain {
    fn drop(&mut self) {
        unsafe {
            CFRelease(self.handle);
        }
    }
}
impl KeyStore for Keychain {
    fn create(&self, id: &[u8; 16], key: &[u8; 32]) -> Result<()> {
        if unsafe { cw_key_create(self.handle, id.as_ptr(), key.as_ptr()) } != 0 {
            return Err(VaultError::KeyUnavailable);
        }
        Ok(())
    }
    fn load(&self, id: &[u8; 16]) -> Result<Zeroizing<[u8; 32]>> {
        let mut key = Zeroizing::new([0; 32]);
        if unsafe { cw_key_load(self.handle, id.as_ptr(), key.as_mut_ptr()) } != 0 {
            return Err(VaultError::KeyUnavailable);
        }
        Ok(key)
    }
}

#[cfg(test)]
#[path = "keychain_tests.rs"]
mod tests;
