//! Durable send admission and takeover. Network execution is owned by the service.
use super::*;
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SendPhase {
    Queued,
    Submitting,
    Accepted,
    Failed,
    NeedsReview,
    Cancelled,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConversationLease {
    pub account_generation: u64,
    pub conversation_generation: u64,
    pub destination: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SendReceipt {
    pub id: String,
    pub destination: String,
    pub account_generation: u64,
    pub conversation_generation: u64,
    pub state: SendPhase,
    pub created_at: u32,
    pub client_message_id: u32,
    pub server_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Entry {
    receipt: SendReceipt,
    text: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Grant {
    generation: u64,
    active: bool,
}
pub struct PreparedSend {
    pub receipt: SendReceipt,
    pub text: String,
}
pub enum SendOutcome {
    Accepted(String),
    Rejected,
    Unknown,
}

pub(super) fn initialize_fields() -> (BTreeMap<String, Entry>, BTreeMap<String, Grant>) {
    (BTreeMap::new(), BTreeMap::new())
}
fn valid_destination(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.chars().any(char::is_control)
        && (!value.contains('@')
            || (value.ends_with("@chatroom") && value.len() > 9 && value.matches('@').count() == 1))
}
fn valid_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
fn valid_server_id(value: &str) -> bool {
    !value.starts_with('0')
        && value.len() <= 20
        && value.bytes().all(|b| b.is_ascii_digit())
        && value.parse::<u64>().is_ok_and(|v| v > 0)
}
pub(super) fn inhibit(state: &mut State) {
    for grant in state.grants.values_mut() {
        grant.active = false;
    }
    for entry in state.outbox.values_mut() {
        if entry.receipt.state == SendPhase::Queued {
            entry.receipt.state = SendPhase::Cancelled;
        }
    }
}
pub(super) fn recover(state: &mut State) -> bool {
    let changed = state.grants.values().any(|g| g.active)
        || state
            .outbox
            .values()
            .any(|e| matches!(e.receipt.state, SendPhase::Queued | SendPhase::Submitting));
    inhibit(state);
    for entry in state.outbox.values_mut() {
        if entry.receipt.state == SendPhase::Submitting {
            entry.receipt.state = SendPhase::NeedsReview;
        }
    }
    changed
}
pub(super) fn validate(state: &State) -> Result<()> {
    if state.next_message_id == 0 || state.grants.len() > 10000 {
        return Err(StoreError::InvalidState);
    }
    for (destination, grant) in &state.grants {
        if !valid_destination(destination)
            || grant.generation == 0
            || (grant.active && state.account.is_none())
        {
            return Err(StoreError::InvalidState);
        }
    }
    let mut ids = std::collections::BTreeSet::new();
    for (key, entry) in &state.outbox {
        let receipt = &entry.receipt;
        let grant = state
            .grants
            .get(&receipt.destination)
            .ok_or(StoreError::InvalidState)?;
        if !valid_key(key)
            || key != &receipt.id
            || !valid_destination(&receipt.destination)
            || receipt.account_generation == 0
            || receipt.account_generation > state.generation
            || receipt.conversation_generation == 0
            || receipt.conversation_generation > grant.generation
            || receipt.created_at == 0
            || receipt.client_message_id == 0
            || receipt.client_message_id >= state.next_message_id
            || !ids.insert(receipt.client_message_id)
            || entry.text.trim().is_empty()
            || entry.text.len() > 65536
            || entry.text.contains('\0')
        {
            return Err(StoreError::InvalidState);
        }
        if match &receipt.server_id {
            Some(id) => receipt.state != SendPhase::Accepted || !valid_server_id(id),
            None => receipt.state == SendPhase::Accepted,
        } {
            return Err(StoreError::InvalidState);
        }
    }
    Ok(())
}
fn check_lease(state: &State, lease: &ConversationLease) -> Result<()> {
    if state.account.is_none()
        || state.generation != lease.account_generation
        || !state
            .grants
            .get(&lease.destination)
            .is_some_and(|g| g.active && g.generation == lease.conversation_generation)
    {
        return Err(StoreError::PermissionDenied);
    }
    Ok(())
}
impl Store {
    /// Called after the service verifies account and current friend/group identity
    /// and consumes an explicit host authorization. This is not a directory check.
    pub fn authorize(&self, generation: u64, destination: &str) -> Result<ConversationLease> {
        if !valid_destination(destination) {
            return Err(StoreError::InvalidState);
        }
        self.update(|state| {
            if state.account.is_none() || state.generation != generation {
                return Err(StoreError::StaleGeneration);
            }
            let next = state
                .grants
                .get(destination)
                .map_or(Some(1), |g| g.generation.checked_add(1))
                .ok_or(StoreError::InvalidState)?;
            state.grants.insert(
                destination.to_owned(),
                Grant {
                    generation: next,
                    active: true,
                },
            );
            for entry in state.outbox.values_mut() {
                if entry.receipt.destination == destination
                    && entry.receipt.state == SendPhase::Queued
                {
                    entry.receipt.state = SendPhase::Cancelled;
                }
            }
            Ok(ConversationLease {
                account_generation: generation,
                conversation_generation: next,
                destination: destination.to_owned(),
            })
        })
    }
    pub fn pause(&self, generation: u64, destination: Option<&str>) -> Result<()> {
        if destination.is_some_and(|d| !valid_destination(d)) {
            return Err(StoreError::InvalidState);
        }
        self.update(|state| {
            if state.generation != generation {
                return Err(StoreError::StaleGeneration);
            }
            if let Some(destination) = destination {
                if let Some(grant) = state.grants.get_mut(destination) {
                    grant.active = false;
                }
                for entry in state.outbox.values_mut() {
                    if entry.receipt.destination == destination
                        && entry.receipt.state == SendPhase::Queued
                    {
                        entry.receipt.state = SendPhase::Cancelled;
                    }
                }
            } else {
                inhibit(state);
            }
            Ok(())
        })
    }
    pub fn queue_send(
        &self,
        lease: &ConversationLease,
        key: &str,
        text: &str,
    ) -> Result<SendReceipt> {
        if !valid_key(key) || text.trim().is_empty() || text.len() > 65536 || text.contains('\0') {
            return Err(StoreError::InvalidState);
        }
        self.update(|state| {
            if let Some(old) = state.outbox.get(key) {
                if old.receipt.destination != lease.destination
                    || old.receipt.account_generation != lease.account_generation
                    || old.receipt.conversation_generation != lease.conversation_generation
                    || old.text != text
                {
                    return Err(StoreError::IdempotencyConflict);
                }
                // Receipt lookup is safe after pause/logout/restart. The old
                // entry cannot transition back to queued or be sent again.
                return Ok(old.receipt.clone());
            }
            check_lease(state, lease)?;
            let client_message_id = state.next_message_id;
            state.next_message_id = state
                .next_message_id
                .checked_add(1)
                .ok_or(StoreError::InvalidState)?;
            let created_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| StoreError::InvalidState)?
                .as_secs()
                .try_into()
                .map_err(|_| StoreError::InvalidState)?;
            let receipt = SendReceipt {
                id: key.to_owned(),
                destination: lease.destination.clone(),
                account_generation: lease.account_generation,
                conversation_generation: lease.conversation_generation,
                state: SendPhase::Queued,
                created_at,
                client_message_id,
                server_id: None,
            };
            state.outbox.insert(
                key.to_owned(),
                Entry {
                    receipt: receipt.clone(),
                    text: text.to_owned(),
                },
            );
            Ok(receipt)
        })
    }
    /// Invoke inside NativeClient's final before-submit guard. Do not call this
    /// before a network handshake or an await: it is the durable handoff point.
    pub fn begin_submission(&self, id: &str) -> Result<PreparedSend> {
        self.update(|state| {
            let entry = state.outbox.get(id).ok_or(StoreError::UnknownSend)?;
            if entry.receipt.state != SendPhase::Queued {
                return Err(StoreError::AlreadySubmitted);
            }
            check_lease(
                state,
                &ConversationLease {
                    account_generation: entry.receipt.account_generation,
                    conversation_generation: entry.receipt.conversation_generation,
                    destination: entry.receipt.destination.clone(),
                },
            )?;
            let entry = state.outbox.get_mut(id).ok_or(StoreError::UnknownSend)?;
            entry.receipt.state = SendPhase::Submitting;
            Ok(PreparedSend {
                receipt: entry.receipt.clone(),
                text: entry.text.clone(),
            })
        })
    }
    pub fn complete_send(&self, id: &str, outcome: SendOutcome) -> Result<SendReceipt> {
        if matches!(&outcome,SendOutcome::Accepted(remote) if !valid_server_id(remote)) {
            return Err(StoreError::InvalidState);
        }
        self.update(|state| {
            let entry = state.outbox.get_mut(id).ok_or(StoreError::UnknownSend)?;
            if entry.receipt.state != SendPhase::Submitting {
                return Err(StoreError::AlreadySubmitted);
            }
            match outcome {
                SendOutcome::Accepted(remote) => {
                    entry.receipt.state = SendPhase::Accepted;
                    entry.receipt.server_id = Some(remote);
                }
                SendOutcome::Unknown => entry.receipt.state = SendPhase::NeedsReview,
                SendOutcome::Rejected => entry.receipt.state = SendPhase::Failed,
            }
            Ok(entry.receipt.clone())
        })
    }
    pub fn receipt(&self, id: &str) -> Result<SendReceipt> {
        self.lock()?
            .state
            .outbox
            .get(id)
            .map(|e| e.receipt.clone())
            .ok_or(StoreError::UnknownSend)
    }
    /// Only a pre-submission failure/cancel may change Queued. In-flight or
    /// terminal receipts are immutable here, including after takeover.
    pub fn stop_queued_send(&self, id: &str, cancelled: bool) -> Result<SendReceipt> {
        self.update(|state| {
            let entry = state.outbox.get_mut(id).ok_or(StoreError::UnknownSend)?;
            if entry.receipt.state == SendPhase::Queued {
                entry.receipt.state = if cancelled {
                    SendPhase::Cancelled
                } else {
                    SendPhase::Failed
                };
            }
            Ok(entry.receipt.clone())
        })
    }
}

#[cfg(test)]
#[path = "outbox_tests.rs"]
mod tests;
