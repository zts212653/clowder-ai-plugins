//! Explicit saved-session authentication. The one-shot acceptance callback and
//! intent receipt share the account transaction; no automatic renewal/retry.
use super::*;
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ResumePhase {
    Authenticating,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResumeRecord {
    pub id: String,
    pub source_generation: u64,
    pub account_generation: u64,
    pub account_identity: String,
    pub phase: ResumePhase,
    pub authentication_may_have_occurred: bool,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
}
#[derive(Clone)]
pub(crate) struct ResumeTicket {
    pub id: String,
    pub account_generation: u64,
}
pub(crate) enum ResumeAdmission {
    New(ResumeTicket),
    Existing(ResumeRecord),
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
fn now() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| StoreError::InvalidState)?
        .as_millis()
        .try_into()
        .map_err(|_| StoreError::InvalidState)
}
pub(super) fn validate(state: &State) -> Result<()> {
    let mut active = 0;
    let mut generations = std::collections::BTreeSet::new();
    for (id, r) in &state.resumes {
        if !valid_id(id)
            || *id != r.id
            || r.source_generation == 0
            || r.source_generation.checked_add(1) != Some(r.account_generation)
            || r.account_generation > state.generation
            || !generations.insert(r.account_generation)
            || r.account_identity.is_empty()
            || r.account_identity.len() > 256
            || r.account_identity.contains('\0')
            || r.started_at_ms == 0
            || r.updated_at_ms < r.started_at_ms
            || !r.authentication_may_have_occurred
        {
            return Err(StoreError::InvalidState);
        }
        if r.phase == ResumePhase::Authenticating {
            active += 1;
            if state.generation != r.account_generation
                || state
                    .account
                    .as_ref()
                    .is_none_or(|a| a.own_username != r.account_identity)
            {
                return Err(StoreError::InvalidState);
            }
        }
    }
    if active > 1 || (active > 0 && state.logins.values().any(|r| r.phase.active())) {
        return Err(StoreError::InvalidState);
    }
    Ok(())
}
pub(super) fn recover(state: &mut State) -> bool {
    let mut changed = false;
    for r in state.resumes.values_mut() {
        if r.phase == ResumePhase::Authenticating {
            r.phase = ResumePhase::Interrupted;
            changed = true;
        }
    }
    changed
}
pub(super) fn inhibit(state: &mut State) {
    for r in state.resumes.values_mut() {
        if r.phase == ResumePhase::Authenticating {
            r.phase = ResumePhase::Cancelled;
        }
    }
}
// Authentication generations fence writers; a same-account resume keeps the
// existing message stream. Derive lineage from durable intents, not a second
// mutable alias table or a copy of every historical message.
pub(super) fn data_generation(state: &State, generation: u64, identity: &str) -> Result<u64> {
    let links = state
        .resumes
        .values()
        .map(|r| (r.account_generation, r))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut root = generation;
    while let Some(record) = links.get(&root) {
        if record.account_identity != identity || record.source_generation >= root {
            return Err(StoreError::StaleGeneration);
        }
        root = record.source_generation;
    }
    Ok(root)
}
impl Store {
    pub(crate) fn begin_resume(
        &self,
        id: &str,
        generation: u64,
        identity: &str,
    ) -> Result<ResumeAdmission> {
        if !valid_id(id) {
            return Err(StoreError::InvalidState);
        }
        self.update(|state| {
            if let Some(r) = state.resumes.get(id) {
                if r.source_generation != generation || r.account_identity != identity {
                    return Err(StoreError::StaleGeneration);
                }
                return Ok(ResumeAdmission::Existing(r.clone()));
            }
            if state.generation != generation
                || state
                    .account
                    .as_ref()
                    .is_none_or(|a| a.own_username != identity)
            {
                return Err(StoreError::StaleGeneration);
            }
            if state
                .resumes
                .values()
                .any(|r| r.phase == ResumePhase::Authenticating)
                || state.logins.values().any(|r| r.phase.active())
            {
                return Err(StoreError::LoginBusy);
            }
            inbox::require_fresh(state, generation)?;
            state.generation = state
                .generation
                .checked_add(1)
                .ok_or(StoreError::InvalidState)?;
            outbox::inhibit(state);
            directory::recover(state);
            let timestamp = now()?;
            let record = ResumeRecord {
                id: id.into(),
                source_generation: generation,
                account_generation: state.generation,
                account_identity: identity.into(),
                phase: ResumePhase::Authenticating,
                authentication_may_have_occurred: true,
                started_at_ms: timestamp,
                updated_at_ms: timestamp,
            };
            let ticket = ResumeTicket {
                id: id.into(),
                account_generation: record.account_generation,
            };
            state.resumes.insert(id.into(), record);
            Ok(ResumeAdmission::New(ticket))
        })
    }
    pub fn resume_record(&self, id: &str) -> Result<ResumeRecord> {
        self.lock()?
            .state
            .resumes
            .get(id)
            .cloned()
            .ok_or(StoreError::UnknownLogin)
    }
    pub fn cancel_resume(&self, id: &str) -> Result<ResumeRecord> {
        self.update(|state| {
            let r = state.resumes.get_mut(id).ok_or(StoreError::UnknownLogin)?;
            if r.phase == ResumePhase::Authenticating {
                r.phase = ResumePhase::Cancelled;
                r.updated_at_ms = now()?.max(r.updated_at_ms);
            }
            Ok(r.clone())
        })
    }
    pub(crate) fn fail_resume(&self, ticket: &ResumeTicket) -> Result<ResumeRecord> {
        self.update(|state| {
            let r = state
                .resumes
                .get_mut(&ticket.id)
                .ok_or(StoreError::UnknownLogin)?;
            if r.account_generation != ticket.account_generation {
                return Err(StoreError::StaleGeneration);
            }
            if r.phase == ResumePhase::Authenticating {
                r.phase = ResumePhase::Failed;
                r.updated_at_ms = now()?.max(r.updated_at_ms);
            }
            Ok(r.clone())
        })
    }
    pub(crate) fn interrupt_resume(&self) -> Result<()> {
        self.update(|state| {
            recover(state);
            Ok(())
        })
    }
    pub(crate) fn resume_persistence(
        self: &Arc<Self>,
        ticket: &ResumeTicket,
    ) -> Arc<dyn AccountPersistence> {
        Arc::new(ResumePersistence {
            store: self.clone(),
            ticket: ticket.clone(),
        })
    }
}
struct ResumePersistence {
    store: Arc<Store>,
    ticket: ResumeTicket,
}
impl AccountPersistence for ResumePersistence {
    fn persist(&self, previous: &AccountState, accepted: &AccountState) -> anyhow::Result<()> {
        self.store.update(|state| {
            validate_update(state, self.ticket.account_generation, previous, accepted)?;
            let r = state
                .resumes
                .get_mut(&self.ticket.id)
                .ok_or(StoreError::UnknownLogin)?;
            if r.phase != ResumePhase::Authenticating
                || r.account_generation != self.ticket.account_generation
                || r.account_identity != accepted.own_username
            {
                return Err(StoreError::StaleGeneration);
            }
            r.phase = ResumePhase::Succeeded;
            r.updated_at_ms = now()?.max(r.updated_at_ms);
            state.account = Some(accepted.clone());
            Ok(())
        })?;
        Ok(())
    }
}
#[cfg(test)]
#[path = "resume_tests.rs"]
mod tests;
