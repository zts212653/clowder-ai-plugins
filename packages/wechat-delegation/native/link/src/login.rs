//! Durable login intent, separate from volatile QR credentials.
use super::*;

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum LoginPhase {
    Starting,
    Pending,
    Scanned,
    Completing,
    Succeeded,
    Cancelled,
    Interrupted,
    Failed,
    Expired,
    Rejected,
    LanRequired,
    LanAwaitingConsent,
    LanVerifying,
}
impl LoginPhase {
    pub fn active(self) -> bool {
        matches!(
            self,
            Self::Starting
                | Self::Pending
                | Self::Scanned
                | Self::Completing
                | Self::LanAwaitingConsent
                | Self::LanVerifying
        )
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LoginRecord {
    pub id: String,
    pub generation: u64,
    pub account_generation: u64,
    pub phase: LoginPhase,
    pub account_identity: Option<String>,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub authentication_may_have_occurred: bool,
    #[serde(default)]
    pub lan_approval_requested: bool,
    #[serde(default)]
    pub lan_deadline_at_ms: Option<u64>,
}
/// Internal authority; this is never accepted as an IPC input.
#[derive(Clone)]
pub struct LoginTicket {
    pub(crate) id: String,
    pub(crate) generation: u64,
    pub(crate) account_generation: u64,
}
pub enum LoginAdmission {
    New(LoginTicket),
    Existing(LoginRecord),
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
fn now_ms() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| StoreError::InvalidState)?
        .as_millis()
        .try_into()
        .map_err(|_| StoreError::InvalidState)
}
pub(super) fn validate(state: &State) -> Result<()> {
    let mut active = 0;
    for (id, record) in &state.logins {
        if !valid_id(id)
            || id != &record.id
            || record.generation == 0
            || record.generation > state.login_generation
            || record.account_generation > state.generation
            || record.started_at_ms == 0
            || record.updated_at_ms < record.started_at_ms
            || (record.phase == LoginPhase::Succeeded) != record.account_identity.is_some()
            || (matches!(record.phase, LoginPhase::Completing | LoginPhase::Succeeded)
                && !record.authentication_may_have_occurred)
            || record.lan_approval_requested != record.lan_deadline_at_ms.is_some()
            || record
                .lan_deadline_at_ms
                .is_some_and(|deadline| deadline <= record.started_at_ms)
            || record.phase == LoginPhase::LanVerifying && !record.lan_approval_requested
            || record.phase == LoginPhase::LanAwaitingConsent && record.lan_approval_requested
            || record
                .account_identity
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.len() > 256 || id.contains('\0'))
        {
            return Err(StoreError::InvalidState);
        }
        if record.phase.active() {
            active += 1;
            if state.account.is_some()
                || record.generation != state.login_generation
                || record.account_generation != state.generation
            {
                return Err(StoreError::InvalidState);
            }
        }
    }
    if active > 1 {
        return Err(StoreError::InvalidState);
    }
    Ok(())
}
pub(super) fn recover(state: &mut State) -> bool {
    let mut changed = false;
    for record in state.logins.values_mut() {
        if record.phase.active() {
            record.phase = LoginPhase::Interrupted;
            changed = true;
        }
    }
    changed
}
pub(super) fn inhibit(state: &mut State) {
    for record in state.logins.values_mut() {
        if record.phase.active() {
            record.phase = LoginPhase::Cancelled;
        }
    }
}
fn current(state: &State, ticket: &LoginTicket) -> Result<()> {
    let record = state
        .logins
        .get(&ticket.id)
        .ok_or(StoreError::UnknownLogin)?;
    if state.account.is_some()
        || state.generation != ticket.account_generation
        || state.login_generation != ticket.generation
        || record.generation != ticket.generation
        || record.account_generation != ticket.account_generation
        || !record.phase.active()
    {
        return Err(StoreError::StaleGeneration);
    }
    Ok(())
}
impl Store {
    pub fn begin_login(&self, id: &str) -> Result<LoginAdmission> {
        if !valid_id(id) {
            return Err(StoreError::InvalidState);
        }
        self.update(|state| {
            if let Some(record) = state.logins.get(id) {
                return Ok(LoginAdmission::Existing(record.clone()));
            }
            if state.account.is_some() || state.logins.values().any(|r| r.phase.active()) {
                return Err(StoreError::LoginBusy);
            }
            state.login_generation = state
                .login_generation
                .checked_add(1)
                .ok_or(StoreError::InvalidState)?;
            let timestamp = now_ms()?;
            let record = LoginRecord {
                id: id.to_owned(),
                generation: state.login_generation,
                account_generation: state.generation,
                phase: LoginPhase::Starting,
                account_identity: None,
                started_at_ms: timestamp,
                updated_at_ms: timestamp,
                authentication_may_have_occurred: false,
                lan_approval_requested: false,
                lan_deadline_at_ms: None,
            };
            let ticket = LoginTicket {
                id: record.id.clone(),
                generation: record.generation,
                account_generation: record.account_generation,
            };
            state.logins.insert(id.to_owned(), record);
            Ok(LoginAdmission::New(ticket))
        })
    }
    pub fn login_record(&self, id: &str) -> Result<LoginRecord> {
        self.lock()?
            .state
            .logins
            .get(id)
            .cloned()
            .ok_or(StoreError::UnknownLogin)
    }
    pub fn advance_login(&self, ticket: &LoginTicket, phase: LoginPhase) -> Result<LoginRecord> {
        self.update(|state| {
            current(state, ticket)?;
            let record = state
                .logins
                .get_mut(&ticket.id)
                .ok_or(StoreError::UnknownLogin)?;
            let permitted = match phase {
                LoginPhase::Pending => {
                    matches!(record.phase, LoginPhase::Starting | LoginPhase::Pending)
                }
                LoginPhase::Scanned => {
                    matches!(record.phase, LoginPhase::Pending | LoginPhase::Scanned)
                }
                LoginPhase::Completing => {
                    matches!(
                        record.phase,
                        LoginPhase::Pending | LoginPhase::Scanned | LoginPhase::LanVerifying
                    )
                }
                LoginPhase::LanAwaitingConsent => {
                    matches!(record.phase, LoginPhase::Pending | LoginPhase::Scanned)
                }
                LoginPhase::Cancelled
                | LoginPhase::Interrupted
                | LoginPhase::Failed
                | LoginPhase::Expired
                | LoginPhase::Rejected
                | LoginPhase::LanRequired => true,
                _ => false,
            };
            if !permitted {
                return Err(StoreError::InvalidState);
            }
            record.phase = phase;
            if phase == LoginPhase::Completing {
                record.authentication_may_have_occurred = true;
            }
            record.updated_at_ms = now_ms()?.max(record.updated_at_ms);
            Ok(record.clone())
        })
    }
    pub fn cancel_login(&self, id: &str) -> Result<LoginRecord> {
        self.update(|state| {
            let record = state.logins.get_mut(id).ok_or(StoreError::UnknownLogin)?;
            if record.phase.active() {
                record.phase = LoginPhase::Cancelled;
                record.updated_at_ms = now_ms()?.max(record.updated_at_ms);
            }
            Ok(record.clone())
        })
    }
    pub fn allow_login_lan(
        &self,
        ticket: &LoginTicket,
        deadline_at_ms: u64,
    ) -> Result<LoginRecord> {
        self.update(|state| {
            current(state, ticket)?;
            let record = state
                .logins
                .get_mut(&ticket.id)
                .ok_or(StoreError::UnknownLogin)?;
            let timestamp = now_ms()?;
            if record.phase != LoginPhase::LanAwaitingConsent
                || record.lan_approval_requested
                || deadline_at_ms <= timestamp
                || deadline_at_ms > timestamp.saturating_add(120000)
            {
                return Err(StoreError::PermissionDenied);
            }
            record.lan_approval_requested = true;
            record.lan_deadline_at_ms = Some(deadline_at_ms);
            record.phase = LoginPhase::LanVerifying;
            record.updated_at_ms = timestamp.max(record.updated_at_ms);
            Ok(record.clone())
        })
    }
    pub fn accept_login_ticket(&self, ticket: &LoginTicket, account: AccountState) -> Result<u64> {
        validate_account(&account)?;
        self.update(move |state| {
            current(state, ticket)?;
            let record = state
                .logins
                .get_mut(&ticket.id)
                .ok_or(StoreError::UnknownLogin)?;
            if record.phase != LoginPhase::Completing {
                return Err(StoreError::InvalidState);
            }
            state.generation = state
                .generation
                .checked_add(1)
                .ok_or(StoreError::InvalidState)?;
            record.phase = LoginPhase::Succeeded;
            record.account_identity = Some(account.own_username.clone());
            record.updated_at_ms = now_ms()?.max(record.updated_at_ms);
            state.account = Some(account);
            super::directory::recover(state);
            outbox::inhibit(state);
            Ok(state.generation)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::tests::{account, Keys, Root};
    #[test]
    fn cancelled_login_cannot_publish_a_late_account_and_history_survives_reopen() {
        let root = Root::new();
        let keys = Keys::default();
        let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
        let ticket = match store
            .begin_login("login-first")
            .expect("login intent must be admitted")
        {
            LoginAdmission::New(ticket) => ticket,
            _ => panic!("new intent was not admitted"),
        };
        store.advance_login(&ticket, LoginPhase::Pending).unwrap();
        store.cancel_login("login-first").unwrap();
        assert!(store.accept_login_ticket(&ticket, account()).is_err());
        assert!(store.account().unwrap().is_none());
        assert_eq!(
            store.login_record("login-first").unwrap().phase,
            LoginPhase::Cancelled
        );
        assert!(matches!(
            store.begin_login("login-first").unwrap(),
            LoginAdmission::Existing(_)
        ));
        let second = match store.begin_login("login-second").unwrap() {
            LoginAdmission::New(t) => t,
            _ => panic!(),
        };
        store.advance_login(&second, LoginPhase::Pending).unwrap();
        drop(store);
        let restored = Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap();
        assert_eq!(
            restored.login_record("login-first").unwrap().phase,
            LoginPhase::Cancelled
        );
        assert_eq!(
            restored.login_record("login-second").unwrap().phase,
            LoginPhase::Interrupted
        );
        assert!(restored.accept_login_ticket(&second, account()).is_err());
    }
    #[test]
    fn accepted_account_and_login_receipt_commit_together_and_logout_blocks_old_completion() {
        let root = Root::new();
        let keys = Keys::default();
        let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
        let ticket = match store.begin_login("login-accepted").unwrap() {
            LoginAdmission::New(t) => t,
            _ => panic!(),
        };
        assert!(store.begin_login("other-operation").is_err());
        store.advance_login(&ticket, LoginPhase::Pending).unwrap();
        store
            .advance_login(&ticket, LoginPhase::Completing)
            .unwrap();
        let generation = store.accept_login_ticket(&ticket, account()).unwrap();
        assert_eq!(
            store.login_record("login-accepted").unwrap().phase,
            LoginPhase::Succeeded
        );
        assert_eq!(
            store.account().unwrap().unwrap().own_username,
            "synthetic-user"
        );
        assert!(store.accept_login_ticket(&ticket, account()).is_err());
        drop(store);
        let restored = Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap();
        assert_eq!(
            restored.login_record("login-accepted").unwrap().phase,
            LoginPhase::Succeeded
        );
        restored.logout(generation).unwrap();
        assert!(restored.accept_login_ticket(&ticket, account()).is_err());
        assert!(restored.account().unwrap().is_none());
    }
    #[test]
    fn lan_permission_is_durable_bounded_once_and_restart_never_revives_a_listener() {
        let root = Root::new();
        let keys = Keys::default();
        let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
        let ticket = match store.begin_login("lan-intent").unwrap() {
            LoginAdmission::New(ticket) => ticket,
            _ => panic!(),
        };
        store.advance_login(&ticket, LoginPhase::Pending).unwrap();
        store
            .advance_login(&ticket, LoginPhase::LanAwaitingConsent)
            .unwrap();
        assert!(store.begin_login("another").is_err());
        assert!(store
            .allow_login_lan(&ticket, now_ms().unwrap() + 121000)
            .is_err());
        let deadline = now_ms().unwrap() + 60000;
        let admitted = store.allow_login_lan(&ticket, deadline).unwrap();
        assert_eq!(admitted.phase, LoginPhase::LanVerifying);
        assert!(admitted.lan_approval_requested);
        assert_eq!(admitted.lan_deadline_at_ms, Some(deadline));
        assert!(store.allow_login_lan(&ticket, deadline).is_err());
        drop(store);
        let restored = Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap();
        let record = restored.login_record("lan-intent").unwrap();
        assert_eq!(record.phase, LoginPhase::Interrupted);
        assert!(record.lan_approval_requested);
        assert_eq!(record.lan_deadline_at_ms, Some(deadline));
        assert!(
            !LoginPhase::LanRequired.active(),
            "old terminal records retain their original meaning"
        );
        let mut old = serde_json::to_value(&record).unwrap();
        old["phase"] = serde_json::json!("lan_required");
        old.as_object_mut().unwrap().remove("lanApprovalRequested");
        old.as_object_mut().unwrap().remove("lanDeadlineAtMs");
        let legacy: LoginRecord = serde_json::from_value(old).unwrap();
        assert!(!legacy.phase.active());
        assert!(!legacy.lan_approval_requested);
        assert_eq!(legacy.lan_deadline_at_ms, None);
    }
}
