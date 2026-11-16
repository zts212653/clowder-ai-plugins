use super::*;
use crate::vault::Vault;
use std::{
    ffi::CString,
    fs,
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::PathBuf,
};

extern "C" {
    fn SecKeychainCreate(
        path: *const i8,
        length: u32,
        password: *const c_void,
        prompt: u8,
        access: Ref,
        keychain: *mut Ref,
    ) -> i32;
    fn SecKeychainDelete(keychain: Ref) -> i32;
    fn SecKeychainOpen(path: *const i8, keychain: *mut Ref) -> i32;
    fn SecKeychainLock(keychain: Ref) -> i32;
    fn SecKeychainUnlock(
        keychain: Ref,
        length: u32,
        password: *const c_void,
        use_password: u8,
    ) -> i32;
    fn SecKeychainCopySearchList(list: *mut Ref) -> i32;
    fn SecKeychainGetUserInteractionAllowed(allowed: *mut u8) -> i32;
    fn CFEqual(a: Ref, b: Ref) -> u8;
}
struct Isolated {
    keys: Keychain,
    root: PathBuf,
}
impl Isolated {
    fn new() -> Self {
        let mut suffix = [0; 16];
        openssl::rand::rand_bytes(&mut suffix).unwrap();
        let root = std::env::temp_dir().join(format!(
            "clowder-keychain-integration-{}",
            suffix
                .iter()
                .map(|v| format!("{v:02x}"))
                .collect::<String>()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = CString::new(root.join("synthetic.keychain-db").as_os_str().as_bytes()).unwrap();
        let password = b"synthetic-isolated-test-password";
        let mut handle = std::ptr::null();
        unsafe {
            assert_eq!(SecKeychainSetUserInteractionAllowed(0), 0);
            assert_eq!(
                SecKeychainCreate(
                    path.as_ptr(),
                    password.len() as u32,
                    password.as_ptr().cast(),
                    0,
                    std::ptr::null(),
                    &mut handle
                ),
                0
            );
        }
        Self {
            keys: Keychain { handle },
            root,
        }
    }
}
impl Drop for Isolated {
    fn drop(&mut self) {
        assert_eq!(unsafe { SecKeychainDelete(self.keys.handle) }, 0);
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn real_keychain_backend_seals_restores_and_never_overwrites_an_existing_item() {
    let mut before = std::ptr::null();
    assert_eq!(unsafe { SecKeychainCopySearchList(&mut before) }, 0);
    let isolated = Isolated::new();
    let root = isolated.root.join("vault");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let secret = b"SYNTHETIC_ONLY_real_backend_session";
    let vault =
        Vault::create(&root, &isolated.keys, secret).expect("real backend must seal a new vault");
    assert_eq!(vault.read().unwrap().as_slice(), secret);
    drop(vault);
    let id: [u8; 16] = fs::read(root.join("vault.id")).unwrap().try_into().unwrap();
    let old = isolated.keys.load(&id).unwrap();
    // Already trusted, unlocked synthetic item: exercises the repair backend
    // without presenting any dialog or accessing the user's default Keychain.
    let original_ciphertext = fs::read(root.join("state.vault")).unwrap();
    assert_eq!(
        isolated.keys.reauthorize_existing(&id).unwrap().as_ref(),
        old.as_ref()
    );
    let mut interaction = 1;
    assert_eq!(
        unsafe { SecKeychainGetUserInteractionAllowed(&mut interaction) },
        0
    );
    assert_eq!(interaction, 0);
    assert_eq!(
        fs::read(root.join("state.vault")).unwrap(),
        original_ciphertext
    );
    assert!(matches!(
        isolated.keys.create(&id, &[0xa5; 32]),
        Err(VaultError::KeyUnavailable)
    ));
    assert_eq!(isolated.keys.load(&id).unwrap().as_ref(), old.as_ref());
    let reopened = Vault::open(&root, &isolated.keys).unwrap();
    assert_eq!(reopened.read().unwrap().as_slice(), secret);
    drop(reopened);
    // The actual Rust executable restarts with only a test-only private-keychain
    // path. No production override or account data is available to this helper.
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "keychain::tests::restart_child"])
        .env_clear()
        .env("CLOWDER_SYNTHETIC_KEYCHAIN_ROOT", &isolated.root)
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "restart helper failed: {}",
        String::from_utf8_lossy(&child.stderr)
    );
    assert!(String::from_utf8_lossy(&child.stdout)
        .contains("test keychain::tests::restart_child ... ok"));
    assert!(!String::from_utf8_lossy(&child.stdout).contains("SYNTHETIC_ONLY"));
    // The foreign executable links the very same production C backend, but its
    // code identity is not on the creating executable's ACL.
    let peer = isolated.root.join("foreign-peer");
    let built = std::process::Command::new("/usr/bin/clang")
        .args([
            "-Werror",
            "-Wno-deprecated-declarations",
            "-framework",
            "Security",
            "-framework",
            "CoreFoundation",
        ])
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/src/keychain.c"))
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/keychain-peer.c"
        ))
        .arg("-o")
        .arg(&peer)
        .output()
        .unwrap();
    assert!(
        built.status.success(),
        "peer compile failed: {}",
        String::from_utf8_lossy(&built.stderr)
    );
    let denied = std::process::Command::new(&peer)
        .arg(isolated.root.join("synthetic.keychain-db"))
        .arg(id.iter().map(|v| format!("{v:02x}")).collect::<String>())
        .env_clear()
        .output()
        .unwrap();
    assert_eq!(
        denied.status.code(),
        Some(2),
        "foreign identity must not obtain the key"
    );
    assert!(denied.stdout.is_empty() && denied.stderr.is_empty());
    let original = fs::read(root.join("state.vault")).unwrap();
    assert_eq!(unsafe { SecKeychainLock(isolated.keys.handle) }, 0);
    assert!(matches!(
        Vault::open(&root, &isolated.keys),
        Err(VaultError::KeyUnavailable)
    ));
    assert_eq!(fs::read(root.join("state.vault")).unwrap(), original);
    let password = b"synthetic-isolated-test-password";
    assert_eq!(
        unsafe {
            SecKeychainUnlock(
                isolated.keys.handle,
                password.len() as u32,
                password.as_ptr().cast(),
                1,
            )
        },
        0
    );
    drop(isolated);
    let mut after = std::ptr::null();
    assert_eq!(unsafe { SecKeychainCopySearchList(&mut after) }, 0);
    assert_ne!(unsafe { CFEqual(before, after) }, 0);
    unsafe {
        CFRelease(before);
        CFRelease(after);
    }
}

#[test]
#[ignore = "spawned only by the parent with an isolated synthetic keychain"]
fn restart_child() {
    let root = PathBuf::from(std::env::var_os("CLOWDER_SYNTHETIC_KEYCHAIN_ROOT").unwrap());
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("clowder-keychain-integration-"));
    let path = CString::new(root.join("synthetic.keychain-db").as_os_str().as_bytes()).unwrap();
    let mut handle = std::ptr::null();
    assert_eq!(unsafe { SecKeychainSetUserInteractionAllowed(0) }, 0);
    assert_eq!(unsafe { SecKeychainOpen(path.as_ptr(), &mut handle) }, 0);
    let keys = Keychain { handle };
    let vault = Vault::open(&root.join("vault"), &keys).unwrap();
    assert_eq!(
        vault.read().unwrap().as_slice(),
        b"SYNTHETIC_ONLY_real_backend_session"
    );
}
