//! Account lifecycle and explicit public projections. Protocol objects stay here.
use crate::store::{LoginAdmission, LoginPhase, LoginRecord, LoginTicket, Store, StoreError};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wechat_protocol::{
    AccountState, DeviceProfile, LoginAttempt, LoginGuard, LoginStatus, NativeClient, NativeOptions,
};
#[path = "messaging.rs"]
mod messaging;
use messaging::{NativeTextPeer, TextPeer};
#[path = "sync_service.rs"]
mod sync_service;
use sync_service::{NativeSyncPeer, SyncPeer};
#[path = "directory_service.rs"]
mod directory_service;
use directory_service::{DirectoryPeer, NativeDirectoryPeer};
#[path = "resume_service.rs"]
mod resume_service;
use resume_service::{NativeResumePeer, ResumePeer};

#[derive(Debug)]
pub enum ServiceError {
    PrivateState,
    Unavailable,
    Busy,
    InvalidOperation,
    PermissionDenied,
    SessionRejected,
}
impl ServiceError {
    fn network(error: &anyhow::Error) -> Self {
        if wechat_protocol::is_session_rejected(error) {
            Self::SessionRejected
        } else {
            Self::Unavailable
        }
    }
}
impl From<StoreError> for ServiceError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::LoginBusy => Self::Busy,
            StoreError::UnknownLogin
            | StoreError::UnknownSend
            | StoreError::StaleGeneration
            | StoreError::IdempotencyConflict
            | StoreError::AlreadySubmitted => Self::InvalidOperation,
            StoreError::StaleSync | StoreError::UnknownMessage => Self::InvalidOperation,
            StoreError::PermissionDenied => Self::PermissionDenied,
            _ => Self::PrivateState,
        }
    }
}
type Result<T> = std::result::Result<T, ServiceError>;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrProjection {
    pub png_base64: String,
    pub expires_at: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginProjection {
    pub operation: LoginRecord,
    pub qr: Option<QrProjection>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProjection {
    pub server_id: String,
    pub account_generation: u64,
    pub account_identity: Option<String>,
    pub credentials_available: bool,
    pub authenticated: bool,
    pub connection: &'static str,
    pub stream: Option<crate::store::StreamProjection>,
}
enum PeerError {
    Unavailable,
    Retryable,
    LanRequired,
}
trait LoginPeer: Send {
    fn start(&mut self, guard: LoginGuard) -> std::result::Result<QrProjection, PeerError>;
    fn poll(&mut self, guard: LoginGuard) -> std::result::Result<LoginStatus, PeerError>;
    fn complete(&mut self, guard: LoginGuard) -> std::result::Result<AccountState, PeerError>;
    fn clear(&mut self);
}
struct NativeLoginPeer {
    bootstrap: NativeClient,
    attempt: Option<LoginAttempt>,
}
impl NativeLoginPeer {
    fn new() -> Result<Self> {
        Ok(Self {
            bootstrap: NativeClient::new(NativeOptions::default())
                .map_err(|_| ServiceError::Unavailable)?,
            attempt: None,
        })
    }
}
impl LoginPeer for NativeLoginPeer {
    fn start(&mut self, guard: LoginGuard) -> std::result::Result<QrProjection, PeerError> {
        use base64::Engine;
        self.attempt = None;
        let device = DeviceProfile::generate("UnifiedPCLinux x86_64".into())
            .map_err(|_| PeerError::Unavailable)?;
        let attempt = self
            .bootstrap
            .start_qr_login_guarded(device, "Clowder AI", guard)
            .map_err(|_| PeerError::Unavailable)?;
        if attempt.qr_png.len() > 512 * 1024 || !attempt.qr_png.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(PeerError::Unavailable);
        }
        let projection = QrProjection {
            png_base64: base64::engine::general_purpose::STANDARD.encode(&attempt.qr_png),
            expires_at: attempt.expires_at,
        };
        self.attempt = Some(attempt);
        Ok(projection)
    }
    fn poll(&mut self, guard: LoginGuard) -> std::result::Result<LoginStatus, PeerError> {
        let attempt = self.attempt.as_mut().ok_or(PeerError::Unavailable)?;
        self.bootstrap
            .poll_login_cancellable(attempt, guard)
            .map_err(|error| {
                if error.is::<wechat_protocol::LanApprovalRequired>() {
                    PeerError::LanRequired
                } else if wechat_protocol::is_retryable_login_poll_error(&error) {
                    PeerError::Retryable
                } else {
                    PeerError::Unavailable
                }
            })
    }
    fn complete(&mut self, guard: LoginGuard) -> std::result::Result<AccountState, PeerError> {
        let mut attempt = self.attempt.take().ok_or(PeerError::Unavailable)?;
        self.bootstrap
            .complete_login_guarded(&mut attempt, guard)
            .map_err(|_| PeerError::Unavailable)
    }
    fn clear(&mut self) {
        self.attempt = None;
    }
}
struct AttemptControl {
    ticket: LoginTicket,
    guard: LoginGuard,
    qr: Option<QrProjection>,
}
struct Control {
    attempt: Option<AttemptControl>,
    client: Option<NativeClient>,
    online: bool,
    closed: bool,
    authorization_epoch: u64,
    resume: Option<crate::store::ResumeTicket>,
}
impl Control {
    fn invalidate_admissions(&mut self) -> Result<()> {
        self.authorization_epoch = self
            .authorization_epoch
            .checked_add(1)
            .ok_or(ServiceError::Unavailable)?;
        Ok(())
    }
}
pub struct AccountService {
    store: Arc<Store>,
    peer: Mutex<Box<dyn LoginPeer>>,
    control: Mutex<Control>,
    text_peer: Box<dyn TextPeer>,
    sync_peer: Box<dyn SyncPeer>,
    sync_gate: Mutex<()>,
    directory_peer: Box<dyn DirectoryPeer>,
    directory_gate: Mutex<()>,
    directory_work: Mutex<Option<crate::store::DirectoryTicket>>,
    resume_peer: Box<dyn ResumePeer>,
}
/// Process-local evidence captured by the stdio reader before dispatching a
/// worker. It is never deserialized, accepted from IPC, or a second owner.
pub struct Admission {
    store: Arc<Store>,
    generation: u64,
    epoch: u64,
}
impl AccountService {
    pub fn admission(&self) -> Result<Admission> {
        let control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        Ok(Admission {
            store: self.store.clone(),
            generation: self.store.generation()?,
            epoch: control.authorization_epoch,
        })
    }
    fn check_admission(&self, control: &Control, admission: &Admission) -> Result<()> {
        if control.closed
            || !Arc::ptr_eq(&self.store, &admission.store)
            || admission.generation != self.store.generation()?
            || admission.epoch != control.authorization_epoch
        {
            return Err(ServiceError::PermissionDenied);
        }
        Ok(())
    }
    fn observe_network_failure(&self, generation: u64, problem: &ServiceError) -> Result<()> {
        if !matches!(problem, ServiceError::SessionRejected) {
            return Ok(());
        }
        let mut control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        if generation != self.store.generation()? {
            return Ok(());
        }
        control.online = false;
        if let Some(client) = &control.client {
            client.stop().map_err(|_| ServiceError::Unavailable)?;
        }
        self.store.pause(generation, None)?;
        self.store.interrupt_directory()?;
        Ok(())
    }
    pub fn new(store: Arc<Store>) -> Result<Self> {
        Self::with_peer(store, Box::new(NativeLoginPeer::new()?))
    }
    fn with_peer(store: Arc<Store>, peer: Box<dyn LoginPeer>) -> Result<Self> {
        let generation = store.generation()?;
        let client = store
            .account()?
            .map(|account| {
                NativeClient::from_account_with_persistence(
                    account,
                    NativeOptions::default(),
                    store.persistence(generation),
                )
            })
            .transpose()
            .map_err(|_| ServiceError::Unavailable)?;
        Ok(Self {
            store,
            peer: Mutex::new(peer),
            text_peer: Box::new(NativeTextPeer),
            sync_peer: Box::new(NativeSyncPeer),
            sync_gate: Mutex::new(()),
            directory_peer: Box::new(NativeDirectoryPeer),
            directory_gate: Mutex::new(()),
            directory_work: Mutex::new(None),
            resume_peer: Box::new(NativeResumePeer),
            control: Mutex::new(Control {
                attempt: None,
                client,
                online: false,
                closed: false,
                authorization_epoch: 0,
                resume: None,
            }),
        })
    }
    fn projection(&self, control: &Control, id: &str) -> Result<LoginProjection> {
        let operation = self.store.login_record(id)?;
        let qr = control
            .attempt
            .as_ref()
            .filter(|a| {
                a.ticket.id == id
                    && matches!(operation.phase, LoginPhase::Pending | LoginPhase::Scanned)
            })
            .and_then(|a| a.qr.clone());
        Ok(LoginProjection { operation, qr })
    }
    fn status_locked(&self, control: &Control) -> Result<AccountProjection> {
        let account_identity = control
            .client
            .as_ref()
            .map(|client| client.account_identity().map(|id| id.own_username))
            .transpose()
            .map_err(|_| ServiceError::Unavailable)?;
        Ok(AccountProjection {
            stream: self.store.stream()?,
            server_id: self.store.server_id()?,
            account_generation: self.store.generation()?,
            credentials_available: control.client.is_some(),
            authenticated: control.online && !control.closed,
            account_identity,
            connection: if control.closed {
                "closed"
            } else if control.online {
                "online"
            } else if control.client.is_some() {
                "stored"
            } else {
                "offline"
            },
        })
    }
    pub fn status(&self) -> Result<AccountProjection> {
        let control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        self.status_locked(&control)
    }
    fn matches(control: &Control, ticket: &LoginTicket) -> bool {
        !control.closed
            && control.attempt.as_ref().is_some_and(|a| {
                a.ticket.id == ticket.id && a.ticket.generation == ticket.generation
            })
    }
    fn failed(&self, ticket: &LoginTicket, phase: LoginPhase) -> Result<LoginProjection> {
        let mut control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        if Self::matches(&control, ticket) {
            if let Some(attempt) = control.attempt.take() {
                attempt.guard.cancel();
            }
            self.store.advance_login(ticket, phase)?;
        }
        self.projection(&control, &ticket.id)
    }
    pub fn start_login(&self, id: &str, admission: &Admission) -> Result<LoginProjection> {
        match self.store.login_record(id) {
            Ok(_) => return self.login_operation(id),
            Err(StoreError::UnknownLogin) => {}
            Err(error) => return Err(error.into()),
        }
        let mut peer = match self.peer.try_lock() {
            Ok(peer) => peer,
            Err(std::sync::TryLockError::WouldBlock) => return Err(ServiceError::Busy),
            Err(_) => return Err(ServiceError::Unavailable),
        };
        let (ticket, guard) = {
            let mut control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
            self.check_admission(&control, admission)?;
            if control.closed {
                return Err(ServiceError::Unavailable);
            }
            let ticket = match self.store.begin_login(id)? {
                LoginAdmission::Existing(_) => return self.projection(&control, id),
                LoginAdmission::New(ticket) => ticket,
            };
            let guard = LoginGuard::new(Instant::now() + Duration::from_secs(300));
            control.attempt = Some(AttemptControl {
                ticket: ticket.clone(),
                guard: guard.clone(),
                qr: None,
            });
            (ticket, guard)
        };
        let qr = match peer.start(guard.clone()) {
            Ok(qr) => qr,
            Err(_) => {
                peer.clear();
                return self.failed(
                    &ticket,
                    if guard.interrupted() {
                        LoginPhase::Expired
                    } else {
                        LoginPhase::Failed
                    },
                );
            }
        };
        let mut control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        if !Self::matches(&control, &ticket) {
            peer.clear();
            return self.projection(&control, id);
        }
        if guard.interrupted() {
            drop(control);
            peer.clear();
            return self.failed(&ticket, LoginPhase::Expired);
        }
        self.store.advance_login(&ticket, LoginPhase::Pending)?;
        if let Some(attempt) = control.attempt.as_mut() {
            attempt.qr = Some(qr);
        }
        self.projection(&control, id)
    }
    pub fn poll_login(&self, id: &str) -> Result<LoginProjection> {
        let (ticket, guard) = {
            let control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
            let record = self.store.login_record(id)?;
            if !matches!(record.phase, LoginPhase::Pending | LoginPhase::Scanned) {
                return self.projection(&control, id);
            }
            let attempt = control
                .attempt
                .as_ref()
                .filter(|a| a.ticket.id == id)
                .ok_or(ServiceError::InvalidOperation)?;
            (attempt.ticket.clone(), attempt.guard.clone())
        };
        if guard.interrupted() {
            return self.failed(&ticket, LoginPhase::Expired);
        }
        let mut peer = match self.peer.try_lock() {
            Ok(peer) => peer,
            Err(std::sync::TryLockError::WouldBlock) => return self.login_operation(id),
            Err(_) => return Err(ServiceError::Unavailable),
        };
        let status = match peer.poll(guard.clone()) {
            Ok(status) => status,
            Err(PeerError::Retryable) => {
                return if guard.interrupted() {
                    peer.clear();
                    self.failed(&ticket, LoginPhase::Expired)
                } else {
                    self.login_operation(id)
                };
            }
            Err(error) => {
                peer.clear();
                return self.failed(
                    &ticket,
                    match error {
                        PeerError::LanRequired => LoginPhase::LanRequired,
                        _ => LoginPhase::Failed,
                    },
                );
            }
        };
        {
            let control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
            if !Self::matches(&control, &ticket) {
                peer.clear();
                return self.projection(&control, id);
            }
            if guard.interrupted() {
                drop(control);
                peer.clear();
                return self.failed(&ticket, LoginPhase::Expired);
            }
            match status {
                LoginStatus::Pending => {}
                LoginStatus::Scanned => {
                    self.store.advance_login(&ticket, LoginPhase::Scanned)?;
                }
                LoginStatus::Approved => {
                    self.store.advance_login(&ticket, LoginPhase::Completing)?;
                }
                terminal => {
                    drop(control);
                    peer.clear();
                    return self.failed(
                        &ticket,
                        match terminal {
                            LoginStatus::Expired => LoginPhase::Expired,
                            LoginStatus::Rejected => LoginPhase::Rejected,
                            LoginStatus::Cancelled => LoginPhase::Cancelled,
                            _ => LoginPhase::Failed,
                        },
                    );
                }
            }
            if status != LoginStatus::Approved {
                return self.projection(&control, id);
            }
        }
        // Persist Completing before starting manual authentication. Cancellation
        // is still admitted through the independent control lock during I/O.
        let accepted = match peer.complete(guard.clone()) {
            Ok(account) => account,
            Err(_) => {
                peer.clear();
                return self.failed(
                    &ticket,
                    if guard.interrupted() {
                        LoginPhase::Expired
                    } else {
                        LoginPhase::Failed
                    },
                );
            }
        };
        let mut control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        if !Self::matches(&control, &ticket) {
            return self.projection(&control, id);
        }
        if guard.interrupted() {
            drop(control);
            return self.failed(&ticket, LoginPhase::Expired);
        }
        let next = ticket
            .account_generation
            .checked_add(1)
            .ok_or(ServiceError::Unavailable)?;
        let client = NativeClient::from_account_with_persistence(
            accepted.clone(),
            NativeOptions::default(),
            self.store.persistence(next),
        )
        .map_err(|_| ServiceError::Unavailable)?;
        let committed = self.store.accept_login_ticket(&ticket, accepted)?;
        if committed != next {
            return Err(ServiceError::Unavailable);
        }
        control.client = Some(client);
        control.online = true;
        control.attempt = None;
        self.projection(&control, id)
    }
    pub fn login_operation(&self, id: &str) -> Result<LoginProjection> {
        let control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        self.projection(&control, id)
    }
    pub fn cancel_login(&self, id: &str) -> Result<LoginProjection> {
        let mut control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        // Even an intent not yet persisted by its queued worker loses its old
        // reader admission. Unknown lookup remains unknown, never a fake ACK.
        control.invalidate_admissions()?;
        if control.attempt.as_ref().is_some_and(|a| a.ticket.id == id) {
            if let Some(attempt) = control.attempt.take() {
                attempt.guard.cancel();
            }
            if let Ok(mut peer) = self.peer.try_lock() {
                peer.clear();
            }
        }
        self.store.cancel_login(id)?;
        self.projection(&control, id)
    }
    pub fn disconnect(&self) -> Result<AccountProjection> {
        let mut control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        control.invalidate_admissions()?;
        control.resume = None;
        if let Some(attempt) = control.attempt.take() {
            attempt.guard.cancel();
        }
        if let Some(client) = &control.client {
            client.stop().map_err(|_| ServiceError::Unavailable)?;
        }
        control.online = false;
        self.store.logout(self.store.generation()?)?;
        control.client = None;
        if let Ok(mut peer) = self.peer.try_lock() {
            peer.clear();
        }
        self.status_locked(&control)
    }
    pub fn close(&self) {
        if let Ok(mut control) = self.control.lock() {
            control.closed = true;
            control.online = false;
            control.resume = None;
            let _ = self.store.interrupt_resume();
            if let Some(attempt) = control.attempt.take() {
                attempt.guard.cancel();
                let _ = self
                    .store
                    .advance_login(&attempt.ticket, LoginPhase::Interrupted);
            }
            if let Some(client) = &control.client {
                let _ = client.stop();
            }
            if let Ok(generation) = self.store.generation() {
                let _ = self.store.pause(generation, None);
            }
            let _ = self.store.interrupt_directory();
            if let Ok(mut peer) = self.peer.try_lock() {
                peer.clear();
            }
        }
    }
}

#[cfg(test)]
#[path = "account_service_tests.rs"]
mod tests;
