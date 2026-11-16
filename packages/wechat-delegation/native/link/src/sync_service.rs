use super::*;
use crate::store::{EventPage, MessageProjection, SyncProjection, SyncTicket};
pub(super) trait SyncPeer: Send + Sync {
    fn pull(
        &self,
        client: &NativeClient,
        cursor: &[u8],
    ) -> anyhow::Result<wechat_protocol::SyncBatch>;
}
pub(super) struct NativeSyncPeer;
impl SyncPeer for NativeSyncPeer {
    fn pull(
        &self,
        client: &NativeClient,
        cursor: &[u8],
    ) -> anyhow::Result<wechat_protocol::SyncBatch> {
        client.request_blocking(|request| request.sync(cursor))
    }
}
impl AccountService {
    pub fn pull_sync(&self, generation: u64, identity: &str) -> Result<SyncProjection> {
        let _gate = match self.sync_gate.try_lock() {
            Ok(gate) => gate,
            Err(std::sync::TryLockError::WouldBlock) => return Err(ServiceError::Busy),
            Err(_) => return Err(ServiceError::Unavailable),
        };
        let (client, ticket): (NativeClient, SyncTicket) = {
            let control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
            if control.closed || !control.online {
                return Err(ServiceError::PermissionDenied);
            }
            let ticket = self.store.sync_ticket(generation)?;
            if ticket.identity != identity {
                return Err(ServiceError::PermissionDenied);
            }
            (
                control.client.clone().ok_or(ServiceError::Unavailable)?,
                ticket,
            )
        };
        let batch = match self.sync_peer.pull(&client, &ticket.cursor) {
            Ok(batch) => batch,
            Err(error) => {
                let problem = ServiceError::network(&error);
                self.observe_network_failure(generation, &problem)?;
                return Err(problem);
            }
        };
        let mut control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        if control.closed || !control.online {
            return Err(ServiceError::PermissionDenied);
        }
        if batch.code == -2006 {
            control.invalidate_admissions()?;
        }
        match self.store.commit_sync(&ticket, batch) {
            Ok(value) => Ok(value),
            Err(error) => {
                // A failed durable reset cannot leave the old sender alive.
                // Preserve the store; do not publish an in-memory checkpoint.
                control.online = false;
                client.stop().map_err(|_| ServiceError::Unavailable)?;
                Err(error.into())
            }
        }
    }
    pub fn events(&self, generation: u64, after: &str, epoch: u64) -> Result<EventPage> {
        Ok(self.store.events(generation, after, epoch)?)
    }
    pub fn message(&self, generation: u64, id: &str, epoch: u64) -> Result<MessageProjection> {
        Ok(self.store.message(generation, id, epoch)?)
    }
    pub fn message_by_server(&self, generation: u64, id: &str) -> Result<MessageProjection> {
        Ok(self.store.message_by_server(generation, id)?)
    }
}
#[cfg(test)]
#[path = "sync_service_tests.rs"]
mod tests;
