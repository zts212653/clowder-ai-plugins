//! Dedicated, one-shot system authorization. No account service or workers.
use crate::{
    keychain::Keychain,
    vault::{KeyStore, Vault, VaultError},
};
use std::path::Path;
use zeroize::Zeroizing;

struct SystemAuthorization;
impl KeyStore for SystemAuthorization {
    fn load(&self, id: &[u8; 16]) -> crate::vault::Result<Zeroizing<[u8; 32]>> {
        Keychain::default_for_user()?.reauthorize_existing(id)
    }
    fn create(&self, _: &[u8; 16], _: &[u8; 32]) -> crate::vault::Result<()> {
        Err(VaultError::KeyUnavailable)
    }
}
pub fn reauthorize(path: &Path) -> &'static str {
    verify_with(path, &SystemAuthorization)
}
struct InitializationAuthorization;
impl KeyStore for InitializationAuthorization {
    fn load(&self, id: &[u8; 16]) -> crate::vault::Result<Zeroizing<[u8; 32]>> {
        SystemAuthorization.load(id)
    }
    fn create(&self, id: &[u8; 16], key: &[u8; 32]) -> crate::vault::Result<()> {
        Keychain::default_for_user()?.create(id, key)
    }
}
pub fn recover_initialization(path: &Path) -> &'static str {
    if !path.is_absolute() {
        return "invalid_state";
    }
    let result =
        Vault::recover_initialization(path, &InitializationAuthorization).and_then(|vault| {
            crate::store::Store::initialize(vault)
                .map(drop)
                .map_err(|error| match error {
                    crate::store::StoreError::Storage(error) => error,
                    _ => VaultError::InvalidStorage,
                })
        });
    outcome(result, "initialized")
}
fn verify_with(path: &Path, keys: &impl KeyStore) -> &'static str {
    if !path.is_absolute() {
        return "invalid_state";
    }
    // Existing lock, identity, permissions and ciphertext only. Never initialize
    // Store or run its restart recovery, mutate state, or create a key here.
    outcome(Vault::open(path, keys).map(drop), "verified")
}
fn outcome(result: crate::vault::Result<()>, success: &'static str) -> &'static str {
    match result {
        Ok(()) => success,
        Err(VaultError::AlreadyInitialized) => "already_initialized",
        Err(VaultError::KeyMissing) => "key_missing",
        Err(VaultError::KeyAccessDenied) => "access_denied",
        Err(VaultError::AuthorizationCancelled) => "cancelled",
        Err(VaultError::InteractionUnavailable) => "interaction_unavailable",
        Err(VaultError::AuthorizationNotPersistent) => "authorization_not_persistent",
        Err(VaultError::Busy) => "busy",
        Err(VaultError::KeyUnavailable) => "key_unavailable",
        _ => "invalid_state",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        fs,
        os::unix::fs::PermissionsExt,
    };
    struct Keys {
        key: RefCell<Option<Zeroizing<[u8; 32]>>>,
        creates: Cell<u32>,
        loads: Cell<u32>,
    }
    impl KeyStore for Keys {
        fn create(&self, _: &[u8; 16], key: &[u8; 32]) -> crate::vault::Result<()> {
            self.creates.set(self.creates.get() + 1);
            *self.key.borrow_mut() = Some(Zeroizing::new(*key));
            Ok(())
        }
        fn load(&self, _: &[u8; 16]) -> crate::vault::Result<Zeroizing<[u8; 32]>> {
            self.loads.set(self.loads.get() + 1);
            self.key.borrow().clone().ok_or(VaultError::KeyUnavailable)
        }
    }
    #[test]
    fn one_shot_verification_preserves_ciphertext_and_never_creates_a_key_or_missing_file() {
        let mut nonce = [0; 16];
        openssl::rand::rand_bytes(&mut nonce).unwrap();
        let root = std::env::temp_dir().join(format!("clowder-repair-synthetic-{nonce:x?}"));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                fs::remove_dir_all(&self.0).unwrap();
            }
        }
        let _cleanup = Cleanup(root.clone());
        let keys = Keys {
            key: RefCell::new(None),
            creates: Cell::new(0),
            loads: Cell::new(0),
        };
        assert_eq!(verify_with(&root, &keys), "invalid_state");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        assert_eq!(keys.loads.get(), 0);
        drop(Vault::create(&root, &keys, b"SYNTHETIC_ONLY_PENDING_RECORD").unwrap());
        let before: std::collections::BTreeMap<_, _> = fs::read_dir(&root)
            .unwrap()
            .map(|item| {
                let path = item.unwrap().path();
                (
                    path.file_name().unwrap().to_owned(),
                    fs::read(path).unwrap(),
                )
            })
            .collect();
        let creates = keys.creates.get();
        assert_eq!(verify_with(&root, &keys), "verified");
        assert_eq!(keys.creates.get(), creates);
        for (name, bytes) in &before {
            assert_eq!(fs::read(root.join(name)).unwrap(), *bytes);
        }
        assert_eq!(fs::read_dir(&root).unwrap().count(), before.len());
        fs::remove_file(root.join("state.vault")).unwrap();
        let loads = keys.loads.get();
        assert_eq!(verify_with(&root, &keys), "invalid_state");
        assert_eq!(
            keys.loads.get(),
            loads,
            "missing data cannot request an authorization dialog"
        );
        assert!(!root.join("state.vault").exists());
    }
}
