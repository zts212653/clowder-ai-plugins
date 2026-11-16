use super::*;
use crate::store::{ResumeAdmission, ResumePhase, ResumeRecord, ResumeTicket};
pub(super) trait ResumePeer: Send + Sync {
    fn resume(&self, client: &NativeClient, ticket: &ResumeTicket) -> Result<()>;
}
pub(super) struct NativeResumePeer;
impl ResumePeer for NativeResumePeer {
    fn resume(&self, client: &NativeClient, _: &ResumeTicket) -> Result<()> {
        client
            .renew_session_blocking("Clowder AI")
            .map_err(|e| ServiceError::network(&e))
    }
}
impl AccountService {
    pub fn resume_session(
        &self,
        id: &str,
        generation: u64,
        identity: &str,
        admission: &Admission,
    ) -> Result<ResumeRecord> {
        match self.store.resume_record(id) {
            Ok(record) => {
                if record.source_generation != generation || record.account_identity != identity {
                    return Err(ServiceError::InvalidOperation);
                }
                return Ok(record);
            }
            Err(StoreError::UnknownLogin) => {}
            Err(error) => return Err(error.into()),
        }
        let (client, ticket) = {
            let mut control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
            self.check_admission(&control, admission)?;
            if control.closed || control.online {
                return Err(ServiceError::PermissionDenied);
            }
            let ticket = match self.store.begin_resume(id, generation, identity)? {
                ResumeAdmission::New(ticket) => ticket,
                ResumeAdmission::Existing(record) => return Ok(record),
            };
            if let Some(old) = &control.client {
                old.stop().map_err(|_| ServiceError::Unavailable)?;
            }
            let account = self
                .store
                .account()?
                .ok_or(ServiceError::InvalidOperation)?;
            let client = NativeClient::from_account_with_persistence(
                account,
                NativeOptions::default(),
                self.store.resume_persistence(&ticket),
            )
            .map_err(|_| ServiceError::Unavailable)?;
            control.client = Some(client.clone());
            control.resume = Some(ticket.clone());
            control.online = false;
            (client, ticket)
        };
        // Only the one-shot acceptance callback proves durable authentication.
        let _result = self.resume_peer.resume(&client, &ticket);
        let mut control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        let current = !control.closed
            && control.resume.as_ref().is_some_and(|r| {
                r.id == ticket.id && r.account_generation == ticket.account_generation
            });
        if !current {
            return Ok(self.store.resume_record(id)?);
        }
        control.resume = None;
        client.stop().map_err(|_| ServiceError::Unavailable)?;
        let record = self.store.resume_record(id)?;
        if record.phase == ResumePhase::Succeeded {
            // Stop the temporary auth owner before constructing the ordinary
            // owner from accepted storage. No exported snapshot or auth retry.
            let accepted = self.store.account()?.ok_or(ServiceError::Unavailable)?;
            let next = NativeClient::from_account_with_persistence(
                accepted,
                NativeOptions::default(),
                self.store.persistence(ticket.account_generation),
            )
            .map_err(|_| ServiceError::Unavailable)?;
            control.client = Some(next);
            control.online = true;
            Ok(record)
        } else {
            Ok(self.store.fail_resume(&ticket)?)
        }
    }
    pub fn resume_operation(&self, id: &str) -> Result<ResumeRecord> {
        Ok(self.store.resume_record(id)?)
    }
    pub fn cancel_resume(&self, id: &str) -> Result<ResumeRecord> {
        let mut control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        control.invalidate_admissions()?;
        if control.resume.as_ref().is_some_and(|r| r.id == id) {
            control.resume = None;
            control.online = false;
            if let Some(client) = &control.client {
                client.stop().map_err(|_| ServiceError::Unavailable)?;
            }
        }
        Ok(self.store.cancel_resume(id)?)
    }
}
#[cfg(test)]
#[path = "resume_service_tests.rs"]
mod tests;
