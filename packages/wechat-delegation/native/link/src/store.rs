//! Transactional account ownership above the encrypted vault.
use crate::vault::{Vault, VaultError};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, MutexGuard};
use wechat_protocol::{AccountPersistence, AccountState};
use zeroize::Zeroizing;
#[path = "outbox.rs"]
mod outbox;
pub use outbox::{ConversationLease, PreparedSend, SendOutcome, SendPhase, SendReceipt};

#[derive(Debug)]
pub enum StoreError {
    Storage(VaultError),
    InvalidState,
    StaleGeneration,
    PermissionDenied,
    IdempotencyConflict,
    AlreadySubmitted,
    UnknownSend,
}
impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("account_state_unavailable")
    }
}
impl std::error::Error for StoreError {}
impl From<VaultError> for StoreError {
    fn from(e: VaultError) -> Self {
        Self::Storage(e)
    }
}
type Result<T> = std::result::Result<T, StoreError>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct State {
    schema: u32,
    server_id: String,
    generation: u64,
    account: Option<AccountState>,
    outbox: std::collections::BTreeMap<String, outbox::Entry>,
    grants: std::collections::BTreeMap<String, outbox::Grant>,
    next_message_id: u32,
}
fn validate_account(account: &AccountState) -> Result<()> {
    account.validate().map_err(|_| StoreError::InvalidState)?;
    if !account.database_password.is_empty()
        || !account.auth_snapshot.response.is_empty()
        || !account.auth_snapshot.auth.is_empty()
        || !account.auth_snapshot.account.is_empty()
        || !account.auth_snapshot.network.is_empty()
        || !account.auth_snapshot.ax_auth.is_empty()
    {
        return Err(StoreError::InvalidState);
    }
    Ok(())
}
fn encode(value: &impl Serialize) -> Result<Zeroizing<Vec<u8>>> {
    serde_json::to_vec(value)
        .map(Zeroizing::new)
        .map_err(|_| StoreError::InvalidState)
}
impl State {
    fn validate(&self) -> Result<()> {
        if self.schema != 1
            || self.server_id.len() != 32
            || !self.server_id.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(StoreError::InvalidState);
        }
        if let Some(account) = &self.account {
            validate_account(account)?;
        }
        outbox::validate(self)?;
        Ok(())
    }
}
struct Data {
    vault: Vault,
    state: State,
}
pub struct Store {
    data: Mutex<Data>,
}
impl Store {
    pub fn initialize(vault: Vault) -> Result<Self> {
        // Explicit initialization never truncates a nonempty accepted snapshot.
        if !vault.read()?.is_empty() {
            return Err(StoreError::InvalidState);
        }
        let mut id = [0; 16];
        openssl::rand::rand_bytes(&mut id).map_err(|_| StoreError::InvalidState)?;
        let (outbox, grants) = outbox::initialize_fields();
        let state = State {
            schema: 1,
            server_id: id.iter().map(|v| format!("{v:02x}")).collect(),
            generation: 0,
            account: None,
            outbox,
            grants,
            next_message_id: (u32::from_be_bytes(
                id[..4].try_into().map_err(|_| StoreError::InvalidState)?,
            ) & 0x7fff_ffff)
                | 1,
        };
        vault.commit(&encode(&state)?)?;
        Ok(Self {
            data: Mutex::new(Data { vault, state }),
        })
    }
    pub fn open(vault: Vault) -> Result<Self> {
        let plaintext = vault.read()?;
        let mut state: State =
            serde_json::from_slice(&plaintext).map_err(|_| StoreError::InvalidState)?;
        state.validate()?;
        if outbox::recover(&mut state) {
            vault.commit(&encode(&state)?)?;
        }
        Ok(Self {
            data: Mutex::new(Data { vault, state }),
        })
    }
    fn lock(&self) -> Result<MutexGuard<'_, Data>> {
        let data = self.data.lock().map_err(|_| StoreError::InvalidState)?;
        data.vault.check_health()?;
        Ok(data)
    }
    fn update<T>(&self, change: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        let mut data = self.lock()?;
        let mut next = data.state.clone();
        let value = change(&mut next)?;
        next.validate()?;
        data.vault.commit(&encode(&next)?)?;
        data.state = next;
        Ok(value)
    }
    pub fn generation(&self) -> Result<u64> {
        Ok(self.lock()?.state.generation)
    }
    pub fn server_id(&self) -> Result<String> {
        Ok(self.lock()?.state.server_id.clone())
    }
    pub fn accept_login(&self, generation: u64, account: AccountState) -> Result<u64> {
        validate_account(&account)?;
        self.update(move |state| {
            if generation != state.generation {
                return Err(StoreError::StaleGeneration);
            }
            state.generation = state
                .generation
                .checked_add(1)
                .ok_or(StoreError::InvalidState)?;
            state.account = Some(account);
            outbox::inhibit(state);
            Ok(state.generation)
        })
    }
    /// Internal snapshot for constructing NativeClient, never serialized to IPC.
    pub fn account(&self) -> Result<Option<AccountState>> {
        Ok(self.lock()?.state.account.clone())
    }
    pub fn logout(&self, generation: u64) -> Result<u64> {
        self.update(|state| {
            if generation != state.generation {
                return Err(StoreError::StaleGeneration);
            }
            state.generation = state
                .generation
                .checked_add(1)
                .ok_or(StoreError::InvalidState)?;
            state.account = None;
            outbox::inhibit(state);
            Ok(state.generation)
        })
    }
    pub fn persistence(self: &Arc<Self>, generation: u64) -> Arc<dyn AccountPersistence> {
        Arc::new(Persistence {
            store: self.clone(),
            generation,
        })
    }
}
struct Persistence {
    store: Arc<Store>,
    generation: u64,
}
impl AccountPersistence for Persistence {
    fn persist(&self, previous: &AccountState, accepted: &AccountState) -> anyhow::Result<()> {
        validate_account(accepted)?;
        self.store.update(|state| {
            if state.generation != self.generation {
                return Err(StoreError::StaleGeneration);
            }
            let current = state.account.as_ref().ok_or(StoreError::StaleGeneration)?;
            let stored = encode(current)?;
            let expected = encode(previous)?;
            if current.uin != accepted.uin
                || current.own_username != accepted.own_username
                || stored.len() != expected.len()
                || !openssl::memcmp::eq(&stored, &expected)
            {
                return Err(StoreError::StaleGeneration);
            }
            state.account = Some(accepted.clone());
            Ok(())
        })?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
