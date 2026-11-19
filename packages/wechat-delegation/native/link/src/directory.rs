//! The current directory is a refreshable cache; intent receipts remain durable.
use super::*;
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetProjection {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub nickname: Option<String>,
    pub remark: Option<String>,
    pub alias: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DirectoryProjection {
    pub operation_id: String,
    pub account_generation: u64,
    pub account_identity: String,
    pub phase: String,
    pub catalog_complete: bool,
    pub verified_count: usize,
    pub unverified_count: usize,
    pub group_discovery_incomplete: bool,
    pub snapshot_available: bool,
    pub observed_at: Option<u64>,
    pub retry_after_ms: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPage {
    pub directory: DirectoryProjection,
    pub items: Vec<TargetProjection>,
    pub next_offset: Option<usize>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Work {
    record: DirectoryProjection,
    revision: u64,
    sequence: (u32, u32),
    catalog_seen: BTreeSet<(u32, u32)>,
    group_cursor: Vec<u8>,
    group_seen: BTreeSet<Vec<u8>>,
    ids: BTreeSet<String>,
    next: usize,
    items: BTreeMap<String, TargetProjection>,
    next_allowed_at: u64,
}
pub(crate) enum DirectoryStep {
    Catalog(u32, u32),
    Groups(Vec<u8>),
    Verify(String),
    Finish,
    Terminal,
}
#[derive(Clone)]
pub(crate) struct DirectoryTicket {
    pub id: String,
    pub generation: u64,
    pub identity: String,
    revision: u64,
    work: Work,
}
impl DirectoryTicket {
    pub fn projection(&self) -> Result<DirectoryProjection> {
        let mut result = self.work.record.clone();
        result.retry_after_ms = self.work.next_allowed_at.saturating_sub(now()?);
        Ok(result)
    }
    pub fn step(&self) -> Result<DirectoryStep> {
        let work = &self.work;
        Ok(if now()? < work.next_allowed_at {
            DirectoryStep::Terminal
        } else {
            match work.record.phase.as_str() {
                "catalog" => DirectoryStep::Catalog(work.sequence.0, work.sequence.1),
                "groups" => DirectoryStep::Groups(work.group_cursor.clone()),
                "verifying" => work
                    .ids
                    .iter()
                    .nth(work.next)
                    .cloned()
                    .map_or(DirectoryStep::Finish, DirectoryStep::Verify),
                _ => DirectoryStep::Terminal,
            }
        })
    }
}
pub(crate) enum DirectoryChange {
    Catalog(wechat_protocol::InitContactPage),
    Groups(wechat_protocol::GroupMetadataPage),
    GroupUnavailable,
    Target(Option<TargetProjection>, bool),
    Finish,
    Failed,
}
fn active(phase: &str) -> bool {
    matches!(phase, "catalog" | "groups" | "verifying")
}
fn now() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| StoreError::InvalidState)?
        .as_millis()
        .try_into()
        .map_err(|_| StoreError::InvalidState)
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
fn coordinate(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(|c| c.is_control() || c.is_whitespace())
}
fn valid_target(id: &str, item: &TargetProjection) -> bool {
    item.id == id
        && coordinate(id)
        && item.kind
            == if id.ends_with("@chatroom") {
                "group"
            } else {
                "direct"
            }
        && item.display_name.len() <= 512
        && [&item.nickname, &item.remark, &item.alias]
            .iter()
            .all(|v| v.as_ref().is_none_or(|v| v.len() <= 512))
}
fn owner(state: &State, generation: u64, identity: &str) -> Result<()> {
    if state.generation != generation
        || state
            .account
            .as_ref()
            .is_none_or(|a| a.own_username != identity)
    {
        return Err(StoreError::StaleGeneration);
    }
    Ok(())
}
pub(super) fn validate(state: &State) -> Result<()> {
    for (id, record) in &state.directory_history {
        if !valid_id(id)
            || record.operation_id != *id
            || record.account_generation == 0
            || record.account_generation > state.generation
            || !coordinate(&record.account_identity)
            || !matches!(
                record.phase.as_str(),
                "catalog" | "groups" | "verifying" | "ready" | "failed" | "interrupted"
            )
            || record.verified_count > 10000
            || record.unverified_count > 10000
            || (record.snapshot_available && record.phase != "ready")
        {
            return Err(StoreError::InvalidState);
        }
    }
    if let Some(work) = &state.directory {
        if !state
            .directory_history
            .contains_key(&work.record.operation_id)
            || work.ids.len() > 10000
            || work.next > work.ids.len()
            || work.items.len() > work.ids.len()
            || work.catalog_seen.len() > 50
            || work.group_seen.len() > 50
            || work.group_cursor.len() > 65536
            || work.group_cursor.is_empty()
            || work.ids.iter().any(|id| !coordinate(id))
        {
            return Err(StoreError::InvalidState);
        }
        for (id, item) in &work.items {
            if item.id != *id
                || !work.ids.contains(id)
                || item.kind
                    != if id.ends_with("@chatroom") {
                        "group"
                    } else {
                        "direct"
                    }
                || item.display_name.len() > 512
                || [&item.nickname, &item.remark, &item.alias]
                    .iter()
                    .any(|v| v.as_ref().is_some_and(|v| v.len() > 512))
            {
                return Err(StoreError::InvalidState);
            }
        }
    }
    Ok(())
}
pub(super) fn recover(state: &mut State) -> bool {
    if let Some(work) = &mut state.directory {
        if active(&work.record.phase) {
            work.record.phase = "interrupted".into();
            work.record.snapshot_available = false;
            work.record.retry_after_ms = 0;
            state
                .directory_history
                .insert(work.record.operation_id.clone(), work.record.clone());
            return true;
        }
    }
    false
}
impl Store {
    pub(crate) fn interrupt_directory(&self) -> Result<()> {
        self.update(|state| {
            recover(state);
            Ok(())
        })
    }
    pub fn begin_directory(
        &self,
        id: &str,
        generation: u64,
        identity: &str,
    ) -> Result<DirectoryProjection> {
        if !valid_id(id) {
            return Err(StoreError::InvalidState);
        }
        {
            let data = self.lock()?;
            owner(&data.state, generation, identity)?;
            if let Some(old) = data.state.directory_history.get(id) {
                if old.account_generation != generation || old.account_identity != identity {
                    return Err(StoreError::StaleGeneration);
                }
                return Ok(old.clone());
            }
        }
        let hints = self.current_group_hints(generation)?;
        self.update(|state| {
            owner(state, generation, identity)?;
            if let Some(old) = state.directory_history.get(id) {
                if old.account_generation != generation || old.account_identity != identity {
                    return Err(StoreError::StaleGeneration);
                }
                return Ok(old.clone());
            }
            if state.directory.as_ref().is_some_and(|w| {
                active(&w.record.phase) && w.record.account_generation == generation
            }) {
                return Err(StoreError::LoginBusy);
            }
            for old in state.directory_history.values_mut() {
                old.snapshot_available = false;
            }
            let record = DirectoryProjection {
                operation_id: id.into(),
                account_generation: generation,
                account_identity: identity.into(),
                phase: "catalog".into(),
                catalog_complete: false,
                verified_count: 0,
                unverified_count: 0,
                group_discovery_incomplete: true,
                snapshot_available: false,
                observed_at: None,
                retry_after_ms: 0,
            };
            state.directory = Some(Work {
                record: record.clone(),
                revision: 0,
                sequence: (0, 0),
                catalog_seen: BTreeSet::from([(0, 0)]),
                group_cursor: vec![0],
                group_seen: BTreeSet::from([vec![0]]),
                ids: hints.into_iter().collect(),
                next: 0,
                items: BTreeMap::new(),
                next_allowed_at: 0,
            });
            state.directory_history.insert(id.into(), record.clone());
            Ok(record)
        })
    }
    pub(crate) fn directory_ticket(&self, id: &str) -> Result<DirectoryTicket> {
        let data = self.lock()?;
        let work = data
            .state
            .directory
            .as_ref()
            .filter(|w| w.record.operation_id == id)
            .ok_or(StoreError::UnknownLogin)?;
        owner(
            &data.state,
            work.record.account_generation,
            &work.record.account_identity,
        )?;
        Ok(DirectoryTicket {
            id: id.into(),
            generation: work.record.account_generation,
            identity: work.record.account_identity.clone(),
            revision: work.revision,
            work: work.clone(),
        })
    }

    pub(crate) fn advance_directory(
        &self,
        ticket: &mut DirectoryTicket,
        change: DirectoryChange,
    ) -> Result<DirectoryProjection> {
        let check = |state: &State| -> Result<()> {
            owner(state, ticket.generation, &ticket.identity)?;
            let live = state.directory.as_ref().filter(|w| {
                w.record.operation_id == ticket.id
                    && w.revision == ticket.revision
                    && active(&w.record.phase)
            });
            if live.is_none() {
                return Err(StoreError::StaleSync);
            }
            Ok(())
        };
        {
            let data = self.lock()?;
            check(&data.state)?;
        }
        let mut next = ticket.work.clone();
        let work = &mut next;
        match change {
            DirectoryChange::Catalog(page) if work.record.phase == "catalog" => {
                let seq = (page.contact_sequence, page.room_sequence);
                if page.more && (work.catalog_seen.len() >= 50 || !work.catalog_seen.insert(seq)) {
                    return Err(StoreError::InvalidState);
                }
                for id in page.usernames {
                    if !coordinate(&id) {
                        return Err(StoreError::InvalidState);
                    }
                    work.ids.insert(id);
                }
                work.sequence = seq;
                if !page.more {
                    work.record.catalog_complete = true;
                    work.record.phase = "groups".into();
                }
            }
            DirectoryChange::Groups(page) if work.record.phase == "groups" => {
                for record in page.contacts {
                    if record.username.ends_with("@chatroom") && coordinate(&record.username) {
                        work.ids.insert(record.username);
                    }
                }
                if page.more {
                    let next = page.next_cursor.ok_or(StoreError::InvalidState)?;
                    if next.is_empty()
                        || next.len() > 65536
                        || work.group_seen.len() >= 50
                        || !work.group_seen.insert(next.clone())
                    {
                        return Err(StoreError::InvalidState);
                    }
                    work.group_cursor = next;
                    work.next_allowed_at = now()?
                        .checked_add(u64::from(page.wait_seconds) * 1000)
                        .ok_or(StoreError::InvalidState)?;
                } else {
                    work.record.group_discovery_incomplete = false;
                    work.record.phase = "verifying".into();
                    work.next_allowed_at = 0;
                }
            }
            DirectoryChange::GroupUnavailable if work.record.phase == "groups" => {
                work.record.group_discovery_incomplete = true;
                work.record.phase = "verifying".into();
                work.next_allowed_at = 0;
            }
            DirectoryChange::Target(target, unverified)
                if work.record.phase == "verifying" && work.next < work.ids.len() =>
            {
                let id = work
                    .ids
                    .iter()
                    .nth(work.next)
                    .ok_or(StoreError::InvalidState)?;
                if let Some(target) = target {
                    if !valid_target(id, &target) {
                        return Err(StoreError::InvalidState);
                    }
                    work.items.insert(id.clone(), target);
                }
                if unverified {
                    work.record.unverified_count += 1;
                }
                work.next += 1;
            }
            DirectoryChange::Finish
                if work.record.phase == "verifying" && work.next == work.ids.len() =>
            {
                work.record.phase = "ready".into();
                work.record.snapshot_available = true;
                work.record.observed_at = Some(now()?);
            }
            DirectoryChange::Failed if active(&work.record.phase) => {
                work.record.phase = "failed".into();
                work.record.snapshot_available = false;
                work.next_allowed_at = 0;
            }
            _ => return Err(StoreError::InvalidState),
        }

        if work.ids.len() > 10000 || work.items.len() > 10000 {
            return Err(StoreError::InvalidState);
        }
        work.revision = work
            .revision
            .checked_add(1)
            .ok_or(StoreError::InvalidState)?;
        work.record.verified_count = work.items.len();
        work.record.retry_after_ms = work.next_allowed_at.saturating_sub(now()?);
        let record = work.record.clone();
        // Intermediate metadata is a recoverable external cache, not a send or
        // sole copy of user data. Keep progress in this process; persist the
        // intent and final snapshot/receipt, avoiding a full-vault write per ID.
        if !active(&record.phase) {
            self.update(|state| {
                check(state)?;
                state.directory = Some(next.clone());
                state
                    .directory_history
                    .insert(ticket.id.clone(), record.clone());
                Ok(())
            })?;
        }
        ticket.work = next;
        Ok(record)
    }
    pub fn directory_operation(&self, id: &str) -> Result<DirectoryProjection> {
        let data = self.lock()?;
        let mut record = data
            .state
            .directory_history
            .get(id)
            .cloned()
            .ok_or(StoreError::UnknownLogin)?;
        if owner(
            &data.state,
            record.account_generation,
            &record.account_identity,
        )
        .is_err()
        {
            record.snapshot_available = false;
        }
        if let Some(work) = data
            .state
            .directory
            .as_ref()
            .filter(|w| w.record.operation_id == id)
        {
            record.retry_after_ms = work.next_allowed_at.saturating_sub(now()?);
        } else {
            record.snapshot_available = false;
            record.retry_after_ms = 0;
        }
        Ok(record)
    }
    pub fn directory_page(&self, id: &str, offset: usize) -> Result<DirectoryPage> {
        let data = self.lock()?;
        let work = data
            .state
            .directory
            .as_ref()
            .filter(|w| {
                w.record.operation_id == id
                    && w.record.phase == "ready"
                    && w.record.snapshot_available
            })
            .ok_or(StoreError::UnknownLogin)?;
        owner(
            &data.state,
            work.record.account_generation,
            &work.record.account_identity,
        )?;
        if offset > work.items.len() {
            return Err(StoreError::InvalidState);
        }
        let end = offset.saturating_add(100).min(work.items.len());
        Ok(DirectoryPage {
            directory: work.record.clone(),
            items: work
                .items
                .values()
                .skip(offset)
                .take(end - offset)
                .cloned()
                .collect(),
            next_offset: (end < work.items.len()).then_some(end),
        })
    }
}
#[cfg(test)]
#[path = "directory_tests.rs"]
mod tests;
