//! Private encrypted state. No key or plaintext serialization is exposed to IPC.
use openssl::{
    rand::rand_bytes,
    symm::{Cipher, Crypter, Mode},
};
use std::{
    ffi::{CStr, CString},
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
use zeroize::Zeroizing;

#[derive(Debug, PartialEq, Eq)]
pub enum VaultError {
    Unavailable,
    InvalidStorage,
    AlreadyInitialized,
    Busy,
    KeyUnavailable,
    KeyMissing,
    KeyAccessDenied,
    AuthorizationCancelled,
    InteractionUnavailable,
    AuthorizationNotPersistent,
    InvalidCiphertext,
    TooLarge,
    CommitUncertain,
}
impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("private_state_unavailable")
    }
}
impl std::error::Error for VaultError {}
pub type Result<T> = std::result::Result<T, VaultError>;

pub trait KeyStore {
    fn load(&self, id: &[u8; 16]) -> Result<Zeroizing<[u8; 32]>>;
    /// Insert only. Never replace an existing item or widen its application ACL.
    fn create(&self, id: &[u8; 16], key: &[u8; 32]) -> Result<()>;
}

const MAGIC: &[u8; 8] = b"CWVAULT1";
const MAX_STATE: usize = 32 * 1024 * 1024;
const HEADER: usize = 56;

fn validated_length(bytes: &[u8], id: &[u8; 16]) -> Result<usize> {
    if bytes.len() < HEADER || &bytes[..8] != MAGIC || bytes[8..24] != *id {
        return Err(VaultError::InvalidCiphertext);
    }
    let length = u32::from_be_bytes(
        bytes[36..40]
            .try_into()
            .map_err(|_| VaultError::InvalidCiphertext)?,
    ) as usize;
    if length > MAX_STATE || bytes.len() != HEADER + length {
        return Err(VaultError::InvalidCiphertext);
    }
    Ok(length)
}

fn initialization_phase(id: &[u8; 16], phase: u8) -> [u8; 25] {
    let mut value = [0; 25];
    value[..8].copy_from_slice(b"CW_INIT1");
    value[8] = phase;
    value[9..].copy_from_slice(id);
    value
}

struct PrivateDir {
    directory: File,
    // Kept alive for the entire Vault lifetime. Never unlink the lock inode.
    _lock: File,
    #[cfg(test)]
    fail_commit_at: std::sync::atomic::AtomicU8,
}
fn private_file(file: &File) -> Result<()> {
    let stat = file.metadata().map_err(|_| VaultError::InvalidStorage)?;
    if !stat.is_file()
        || stat.uid() != unsafe { libc::geteuid() }
        || stat.mode() & 0o7777 != 0o600
        || stat.nlink() != 1
    {
        return Err(VaultError::InvalidStorage);
    }
    Ok(())
}
impl PrivateDir {
    fn open(path: &Path, create_lock: bool) -> Result<Self> {
        let path =
            CString::new(path.as_os_str().as_bytes()).map_err(|_| VaultError::InvalidStorage)?;
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(VaultError::InvalidStorage);
        }
        let directory = unsafe { File::from_raw_fd(fd) };
        let stat = directory
            .metadata()
            .map_err(|_| VaultError::InvalidStorage)?;
        if stat.uid() != unsafe { libc::geteuid() } || stat.mode() & 0o7777 != 0o700 {
            return Err(VaultError::InvalidStorage);
        }
        let lock = Self::open_at(
            &directory,
            "vault.lock",
            libc::O_RDWR | if create_lock { libc::O_CREAT } else { 0 },
        )?;
        private_file(&lock)?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(VaultError::Busy);
        }
        Ok(Self {
            directory,
            _lock: lock,
            #[cfg(test)]
            fail_commit_at: std::sync::atomic::AtomicU8::new(0),
        })
    }
    fn open_at(dir: &File, name: &str, flags: i32) -> Result<File> {
        let name = CString::new(name).map_err(|_| VaultError::InvalidStorage)?;
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err(VaultError::InvalidStorage);
        }
        let file = unsafe { File::from_raw_fd(fd) };
        private_file(&file)?;
        Ok(file)
    }
    fn read(&self, name: &str, maximum: usize) -> Result<Vec<u8>> {
        let file = Self::open_at(&self.directory, name, libc::O_RDONLY)?;
        let length = file
            .metadata()
            .map_err(|_| VaultError::InvalidStorage)?
            .len();
        if length > maximum as u64 {
            return Err(VaultError::TooLarge);
        }
        let mut bytes = Vec::with_capacity(length as usize);
        file.take(maximum as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| VaultError::InvalidStorage)?;
        if bytes.len() > maximum {
            return Err(VaultError::TooLarge);
        }
        Ok(bytes)
    }
    fn exists(&self, name: &str) -> Result<bool> {
        let name = CString::new(name).map_err(|_| VaultError::InvalidStorage)?;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        let status = unsafe {
            libc::fstatat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if status == 0 {
            return Ok(true);
        }
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            Ok(false)
        } else {
            Err(VaultError::InvalidStorage)
        }
    }
    fn create(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let mut file = Self::open_at(
            &self.directory,
            name,
            libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY,
        )?;
        file.write_all(bytes).map_err(|_| VaultError::Unavailable)?;
        durable(&file)?;
        self.directory
            .sync_all()
            .map_err(|_| VaultError::CommitUncertain)
    }
    fn replace(&self, target: &CStr, bytes: &[u8]) -> Result<()> {
        let mut random = [0; 16];
        rand_bytes(&mut random).map_err(|_| VaultError::Unavailable)?;
        let name = format!(
            ".commit-{}",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let staged = self.create(&name, bytes);
        if staged.is_err() {
            self.remove(&name);
            return staged;
        }
        #[cfg(test)]
        if self.fail_commit_at.load(Ordering::Acquire) == 1 {
            self.remove(&name);
            return Err(VaultError::Unavailable);
        }
        let from = CString::new(name.as_str()).map_err(|_| VaultError::Unavailable)?;
        if unsafe {
            libc::renameat(
                self.directory.as_raw_fd(),
                from.as_ptr(),
                self.directory.as_raw_fd(),
                target.as_ptr(),
            )
        } != 0
        {
            self.remove(&name);
            return Err(VaultError::Unavailable);
        }
        // After rename, an fsync failure has an uncertain durable outcome. The
        // owner must stop all operations; never roll back or retry a send.
        #[cfg(test)]
        if self.fail_commit_at.load(Ordering::Acquire) == 2 {
            return Err(VaultError::CommitUncertain);
        }
        self.directory
            .sync_all()
            .map_err(|_| VaultError::CommitUncertain)
    }
    fn remove(&self, name: &str) {
        if let Ok(name) = CString::new(name) {
            unsafe {
                libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0);
            }
        }
    }
}
fn durable(file: &File) -> Result<()> {
    file.sync_all().map_err(|_| VaultError::Unavailable)?;
    #[cfg(target_os = "macos")]
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_FULLFSYNC) } != 0 {
        return Err(VaultError::Unavailable);
    }
    Ok(())
}

pub struct Vault {
    directory: PrivateDir,
    id: [u8; 16],
    key: Zeroizing<[u8; 32]>,
    poisoned: AtomicBool,
}
impl Vault {
    pub fn check_health(&self) -> Result<()> {
        if self.poisoned.load(Ordering::Acquire) {
            Err(VaultError::CommitUncertain)
        } else {
            Ok(())
        }
    }
    /// Explicit initialization only. A durable identity is written first, so
    /// missing state/key after a crash can never look like a new empty vault.
    pub fn create(path: &Path, keys: &impl KeyStore, initial: &[u8]) -> Result<Self> {
        if initial.len() > MAX_STATE {
            return Err(VaultError::TooLarge);
        }
        let directory = PrivateDir::open(path, true)?;
        if directory.exists("vault.id")?
            || directory.exists("state.vault")?
            || directory.exists("init.phase")?
        {
            return Err(VaultError::AlreadyInitialized);
        }
        let mut id = [0; 16];
        rand_bytes(&mut id).map_err(|_| VaultError::Unavailable)?;
        directory.create("vault.id", &id)?;
        directory.create("init.phase", &initialization_phase(&id, 0))?;
        let mut key = Zeroizing::new([0; 32]);
        rand_bytes(key.as_mut()).map_err(|_| VaultError::Unavailable)?;
        keys.create(&id, &key)?;
        // Confirm the application can reopen its newly created item. Never
        // substitute a local key file if Keychain access fails.
        let saved = keys.load(&id)?;
        if !openssl::memcmp::eq(saved.as_ref(), key.as_ref()) {
            return Err(VaultError::KeyUnavailable);
        }
        let vault = Self {
            directory,
            id,
            key,
            poisoned: AtomicBool::new(false),
        };
        // This durable, never-deleted evidence precedes the first publication.
        // Missing ciphertext after this point cannot be treated as a new vault.
        vault
            .directory
            .replace(c"init.phase", &initialization_phase(&id, 1))?;
        vault.commit(initial)?;
        Ok(vault)
    }
    /// Explicit recovery of first initialization only. Never reset identity,
    /// replace an existing key, or infer an empty database from missing files.
    pub fn recover_initialization(path: &Path, keys: &impl KeyStore) -> Result<Self> {
        let directory = PrivateDir::open(path, false)?;
        let id: [u8; 16] = directory
            .read("vault.id", 16)?
            .try_into()
            .map_err(|_| VaultError::InvalidStorage)?;
        let phase = directory.read("init.phase", 25)?;
        if phase.len() != 25 || &phase[..8] != b"CW_INIT1" || phase[9..] != id || phase[8] > 1 {
            return Err(VaultError::InvalidStorage);
        }
        let has_state = directory.exists("state.vault")?;
        let publishing = phase[8] == 1;
        if has_state != publishing {
            return Err(VaultError::InvalidStorage);
        }
        let key = match keys.load(&id) {
            Ok(key) => key,
            Err(VaultError::KeyMissing) if !has_state && !publishing => {
                let mut key = Zeroizing::new([0; 32]);
                rand_bytes(key.as_mut()).map_err(|_| VaultError::Unavailable)?;
                keys.create(&id, &key)?;
                let accepted = keys.load(&id)?;
                if !openssl::memcmp::eq(key.as_ref(), accepted.as_ref()) {
                    return Err(VaultError::KeyUnavailable);
                }
                key
            }
            Err(error) => return Err(error),
        };
        let vault = Self {
            directory,
            id,
            key,
            poisoned: AtomicBool::new(false),
        };
        if has_state {
            if !vault.read()?.is_empty() {
                return Err(VaultError::AlreadyInitialized);
            }
        } else {
            vault
                .directory
                .replace(c"init.phase", &initialization_phase(&id, 1))?;
            vault.commit(b"")?;
        }
        Ok(vault)
    }
    pub fn open(path: &Path, keys: &impl KeyStore) -> Result<Self> {
        let directory = PrivateDir::open(path, false)?;
        let id: [u8; 16] = directory
            .read("vault.id", 16)?
            .try_into()
            .map_err(|_| VaultError::InvalidStorage)?;
        let bytes = directory.read("state.vault", MAX_STATE + HEADER)?;
        validated_length(&bytes, &id)?;
        let key = keys.load(&id)?;
        let vault = Self {
            directory,
            id,
            key,
            poisoned: AtomicBool::new(false),
        };
        vault.decrypt(&bytes)?;
        Ok(vault)
    }
    pub fn read(&self) -> Result<Zeroizing<Vec<u8>>> {
        if self.poisoned.load(Ordering::Acquire) {
            return Err(VaultError::CommitUncertain);
        }
        let bytes = self.directory.read("state.vault", MAX_STATE + HEADER)?;
        self.decrypt(&bytes)
    }
    fn decrypt(&self, bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        let length = validated_length(bytes, &self.id)?;
        // Keep all unauthenticated plaintext in a zeroizing buffer, including
        // the failure path. OpenSSL errors never become diagnostics or DTOs.
        let cipher = Cipher::aes_256_gcm();
        let mut decrypt = Crypter::new(
            cipher,
            Mode::Decrypt,
            self.key.as_ref(),
            Some(&bytes[24..36]),
        )
        .map_err(|_| VaultError::InvalidCiphertext)?;
        decrypt
            .aad_update(&bytes[..40])
            .map_err(|_| VaultError::InvalidCiphertext)?;
        decrypt
            .set_tag(&bytes[40..56])
            .map_err(|_| VaultError::InvalidCiphertext)?;
        let mut plain = Zeroizing::new(vec![0; length + cipher.block_size()]);
        let count = decrypt
            .update(&bytes[HEADER..], &mut plain)
            .map_err(|_| VaultError::InvalidCiphertext)?;
        let tail = decrypt
            .finalize(&mut plain[count..])
            .map_err(|_| VaultError::InvalidCiphertext)?;
        plain.truncate(count + tail);
        Ok(plain)
    }
    pub fn commit(&self, bytes: &[u8]) -> Result<()> {
        if self.poisoned.load(Ordering::Acquire) {
            return Err(VaultError::CommitUncertain);
        }
        if bytes.len() > MAX_STATE {
            return Err(VaultError::TooLarge);
        }
        let mut header = Vec::with_capacity(40);
        header.extend_from_slice(MAGIC);
        header.extend_from_slice(&self.id);
        let mut nonce = [0; 12];
        rand_bytes(&mut nonce).map_err(|_| VaultError::Unavailable)?;
        header.extend_from_slice(&nonce);
        header.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        let mut tag = [0; 16];
        let ciphertext = openssl::symm::encrypt_aead(
            Cipher::aes_256_gcm(),
            self.key.as_ref(),
            Some(&nonce),
            &header,
            bytes,
            &mut tag,
        )
        .map_err(|_| VaultError::Unavailable)?;
        header.extend_from_slice(&tag);
        header.extend_from_slice(&ciphertext);
        let result = self.directory.replace(c"state.vault", &header);
        if matches!(result, Err(VaultError::CommitUncertain)) {
            self.poisoned.store(true, Ordering::Release);
        }
        result
    }
}

#[cfg(test)]
#[path = "vault_tests.rs"]
mod tests;
