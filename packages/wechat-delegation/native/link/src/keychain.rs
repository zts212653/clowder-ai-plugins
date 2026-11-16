//! Application ACL-bound file-Keychain backend for the macOS CLI.
//! No UI, search-list mutation, arbitrary service name, or raw-key IPC method.
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
