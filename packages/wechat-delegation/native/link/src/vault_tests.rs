use super::*;
use std::{
    cell::RefCell,
    collections::HashMap,
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::PathBuf,
};

pub(super) struct Scratch(pub PathBuf);
impl Scratch {
    pub(super) fn new() -> Self {
        let mut suffix = [0; 16];
        openssl::rand::rand_bytes(&mut suffix).unwrap();
        let name: String = suffix.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = std::env::temp_dir().join(format!("clowder-synthetic-vault-{name}"));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[derive(Default)]
struct SyntheticKeys(RefCell<HashMap<[u8; 16], Zeroizing<[u8; 32]>>>);
impl KeyStore for SyntheticKeys {
    fn load(&self, id: &[u8; 16]) -> Result<Zeroizing<[u8; 32]>> {
        self.0
            .borrow()
            .get(id)
            .cloned()
            .ok_or(VaultError::KeyUnavailable)
    }
    fn create(&self, id: &[u8; 16], key: &[u8; 32]) -> Result<()> {
        let mut keys = self.0.borrow_mut();
        if keys.contains_key(id) {
            return Err(VaultError::KeyUnavailable);
        }
        keys.insert(*id, Zeroizing::new(*key));
        Ok(())
    }
}
const FIRST: &[u8] = b"SYNTHETIC_SESSION_SECRET_original";
const SECOND: &[u8] = b"SYNTHETIC_SESSION_SECRET_renewed";

#[test]
fn encrypted_state_survives_reopen_and_failed_key_access_preserves_original() {
    let root = Scratch::new();
    let keys = SyntheticKeys::default();
    let vault = Vault::create(&root.0, &keys, FIRST).expect("fresh vault must initialize");
    assert_eq!(vault.read().unwrap().as_slice(), FIRST);
    vault.commit(SECOND).unwrap();
    drop(vault);
    let stored = fs::read(root.0.join("state.vault")).unwrap();
    assert!(!stored.windows(9).any(|w| w == b"SYNTHETIC"));
    assert_eq!(
        fs::metadata(root.0.join("state.vault"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let reopened = Vault::open(&root.0, &keys).unwrap();
    assert_eq!(reopened.read().unwrap().as_slice(), SECOND);
    drop(reopened);
    let missing = SyntheticKeys::default();
    assert!(matches!(
        Vault::open(&root.0, &missing),
        Err(VaultError::KeyUnavailable)
    ));
    assert!(missing.0.borrow().is_empty());
    assert_eq!(fs::read(root.0.join("state.vault")).unwrap(), stored);
    assert!(matches!(
        Vault::create(&root.0, &keys, FIRST),
        Err(VaultError::AlreadyInitialized)
    ));
    assert_eq!(fs::read(root.0.join("state.vault")).unwrap(), stored);
}

#[test]
fn exclusive_owner_symlink_and_ciphertext_corruption_fail_closed() {
    let root = Scratch::new();
    let keys = SyntheticKeys::default();
    let vault = Vault::create(&root.0, &keys, FIRST).unwrap();
    assert!(matches!(Vault::open(&root.0, &keys), Err(VaultError::Busy)));
    drop(vault);
    let path = root.0.join("state.vault");
    let original = fs::read(&path).unwrap();
    let mut corrupt = original.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    fs::write(&path, &corrupt).unwrap();
    assert!(matches!(
        Vault::open(&root.0, &keys),
        Err(VaultError::InvalidCiphertext)
    ));
    assert_eq!(fs::read(&path).unwrap(), corrupt);
    fs::write(&path, &original).unwrap();
    let outside = Scratch::new();
    let target = outside.0.join("outside");
    fs::write(&target, &original).unwrap();
    fs::remove_file(&path).unwrap();
    symlink(&target, &path).unwrap();
    assert!(matches!(
        Vault::open(&root.0, &keys),
        Err(VaultError::InvalidStorage)
    ));
    assert_eq!(fs::read(&target).unwrap(), original);
    let link = outside.0.join("root-link");
    symlink(&root.0, &link).unwrap();
    assert!(matches!(
        Vault::open(&link, &keys),
        Err(VaultError::InvalidStorage)
    ));
}

#[test]
fn missing_ciphertext_cannot_silently_reinitialize_and_swapped_identity_cannot_decrypt() {
    let root = Scratch::new();
    let keys = SyntheticKeys::default();
    drop(Vault::create(&root.0, &keys, FIRST).unwrap());
    let file = root.0.join("state.vault");
    let original = fs::read(&file).unwrap();
    fs::remove_file(&file).unwrap();
    assert!(Vault::open(&root.0, &keys).is_err());
    assert!(matches!(
        Vault::create(&root.0, &keys, SECOND),
        Err(VaultError::AlreadyInitialized)
    ));
    assert!(!file.exists());
    fs::write(&file, &original).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    let other = Scratch::new();
    drop(Vault::create(&other.0, &keys, SECOND).unwrap());
    let identity = fs::read(other.0.join("vault.id")).unwrap();
    fs::write(root.0.join("vault.id"), &identity).unwrap();
    assert!(matches!(
        Vault::open(&root.0, &keys),
        Err(VaultError::InvalidCiphertext)
    ));
    assert_eq!(fs::read(&file).unwrap(), original);
}

#[test]
fn failed_commit_preserves_old_state_and_uncertain_commit_stops_the_owner() {
    let root = Scratch::new();
    let keys = SyntheticKeys::default();
    let vault = Vault::create(&root.0, &keys, FIRST).unwrap();
    let original = fs::read(root.0.join("state.vault")).unwrap();
    vault.directory.fail_commit_at.store(1, Ordering::Release);
    assert_eq!(vault.commit(SECOND), Err(VaultError::Unavailable));
    assert_eq!(fs::read(root.0.join("state.vault")).unwrap(), original);
    assert_eq!(vault.read().unwrap().as_slice(), FIRST);
    vault.directory.fail_commit_at.store(2, Ordering::Release);
    assert_eq!(vault.commit(SECOND), Err(VaultError::CommitUncertain));
    assert_eq!(vault.commit(FIRST), Err(VaultError::CommitUncertain));
    assert!(matches!(vault.read(), Err(VaultError::CommitUncertain)));
    drop(vault);
    let restored = Vault::open(&root.0, &keys).unwrap();
    assert_eq!(restored.read().unwrap().as_slice(), SECOND);
    assert!(!fs::read_dir(&root.0).unwrap().any(|f| f
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".commit-")));
}

#[test]
fn keychain_denial_during_initialization_leaves_a_recovery_marker_and_no_plaintext() {
    struct Denied;
    impl KeyStore for Denied {
        fn load(&self, _: &[u8; 16]) -> Result<Zeroizing<[u8; 32]>> {
            Err(VaultError::KeyUnavailable)
        }
        fn create(&self, _: &[u8; 16], _: &[u8; 32]) -> Result<()> {
            Err(VaultError::KeyUnavailable)
        }
    }
    let root = Scratch::new();
    assert!(matches!(
        Vault::create(&root.0, &Denied, FIRST),
        Err(VaultError::KeyUnavailable)
    ));
    assert!(root.0.join("vault.id").exists());
    assert!(!root.0.join("state.vault").exists());
    assert!(matches!(
        Vault::create(&root.0, &SyntheticKeys::default(), SECOND),
        Err(VaultError::AlreadyInitialized)
    ));
    for file in fs::read_dir(&root.0).unwrap() {
        let bytes = fs::read(file.unwrap().path()).unwrap();
        assert!(!bytes.windows(9).any(|w| w == b"SYNTHETIC"));
    }
}

#[test]
fn permissive_files_hard_links_and_named_pipes_are_rejected_without_changing_the_target() {
    let root = Scratch::new();
    let keys = SyntheticKeys::default();
    drop(Vault::create(&root.0, &keys, FIRST).unwrap());
    let path = root.0.join("state.vault");
    let original = fs::read(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(
        Vault::open(&root.0, &keys),
        Err(VaultError::InvalidStorage)
    ));
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o644
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let linked = root.0.join("second-link");
    fs::hard_link(&path, &linked).unwrap();
    assert!(matches!(
        Vault::open(&root.0, &keys),
        Err(VaultError::InvalidStorage)
    ));
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_file(&linked).unwrap();
    fs::remove_file(&path).unwrap();
    let named = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(named.as_ptr(), 0o600) }, 0);
    assert!(matches!(
        Vault::open(&root.0, &keys),
        Err(VaultError::InvalidStorage)
    ));
}
