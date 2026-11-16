use super::*;
use crate::store::{DirectoryChange, DirectoryPage, DirectoryProjection, DirectoryStep};
pub(super) trait DirectoryPeer: Send + Sync {
    fn catalog(
        &self,
        client: &NativeClient,
        contacts: u32,
        rooms: u32,
    ) -> Result<wechat_protocol::InitContactPage>;
    fn groups(
        &self,
        client: &NativeClient,
        cursor: &[u8],
    ) -> Result<wechat_protocol::GroupMetadataPage>;
    fn target(&self, client: &NativeClient, id: &str) -> Result<crate::store::TargetProjection>;
}
pub(super) struct NativeDirectoryPeer;
impl DirectoryPeer for NativeDirectoryPeer {
    fn catalog(
        &self,
        client: &NativeClient,
        contacts: u32,
        rooms: u32,
    ) -> Result<wechat_protocol::InitContactPage> {
        client
            .request_blocking(|r| r.init_contacts(contacts, rooms))
            .map_err(|e| ServiceError::network(&e))
    }
    fn groups(
        &self,
        client: &NativeClient,
        cursor: &[u8],
    ) -> Result<wechat_protocol::GroupMetadataPage> {
        client
            .request_blocking(|r| r.group_inventory(cursor))
            .map_err(|e| ServiceError::network(&e))
    }
    fn target(&self, client: &NativeClient, id: &str) -> Result<crate::store::TargetProjection> {
        super::messaging::verified_target(client, id)
    }
}
impl AccountService {
    pub fn start_directory(
        &self,
        id: &str,
        generation: u64,
        identity: &str,
    ) -> Result<DirectoryProjection> {
        {
            let control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
            if control.closed || !control.online {
                return Err(ServiceError::PermissionDenied);
            }
            let record = self.store.begin_directory(id, generation, identity)?;
            if matches!(record.phase.as_str(), "catalog" | "groups" | "verifying") {
                let mut cache = self
                    .directory_work
                    .lock()
                    .map_err(|_| ServiceError::Unavailable)?;
                if cache.as_ref().is_none_or(|ticket| ticket.id != id) {
                    *cache = Some(self.store.directory_ticket(id)?);
                }
            }
        }
        self.directory_operation(id)
    }
    pub fn advance_directory(&self, id: &str) -> Result<DirectoryProjection> {
        let _gate = match self.directory_gate.try_lock() {
            Ok(gate) => gate,
            Err(std::sync::TryLockError::WouldBlock) => return Err(ServiceError::Busy),
            Err(_) => return Err(ServiceError::Unavailable),
        };
        let record = self.store.directory_operation(id)?;
        if !matches!(record.phase.as_str(), "catalog" | "groups" | "verifying") {
            return Ok(record);
        }
        let (client, mut ticket) = {
            let control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
            if control.closed
                || !control.online
                || self.store.generation()? != record.account_generation
            {
                return Err(ServiceError::PermissionDenied);
            }
            let cache = self
                .directory_work
                .lock()
                .map_err(|_| ServiceError::Unavailable)?;
            let ticket = cache
                .as_ref()
                .filter(|ticket| ticket.id == id)
                .cloned()
                .ok_or(ServiceError::InvalidOperation)?;
            (
                control.client.clone().ok_or(ServiceError::Unavailable)?,
                ticket,
            )
        };
        let change = match ticket.step()? {
            DirectoryStep::Catalog(contacts, rooms) => {
                match self.directory_peer.catalog(&client, contacts, rooms) {
                    Ok(page) => DirectoryChange::Catalog(page),
                    Err(problem) => {
                        self.observe_network_failure(ticket.generation, &problem)?;
                        if matches!(problem, ServiceError::SessionRejected) {
                            return Err(problem);
                        }
                        DirectoryChange::Failed
                    }
                }
            }
            DirectoryStep::Groups(cursor) => match self.directory_peer.groups(&client, &cursor) {
                Ok(page) => DirectoryChange::Groups(page),
                Err(problem) => {
                    self.observe_network_failure(ticket.generation, &problem)?;
                    if matches!(problem, ServiceError::SessionRejected) {
                        return Err(problem);
                    }
                    DirectoryChange::GroupUnavailable
                }
            },
            DirectoryStep::Verify(id) => match self.directory_peer.target(&client, &id) {
                Ok(target) => DirectoryChange::Target(Some(target), false),
                Err(problem) => {
                    self.observe_network_failure(ticket.generation, &problem)?;
                    if matches!(problem, ServiceError::SessionRejected) {
                        return Err(problem);
                    }
                    DirectoryChange::Target(
                        None,
                        !matches!(problem, ServiceError::PermissionDenied),
                    )
                }
            },
            DirectoryStep::Finish => DirectoryChange::Finish,
            DirectoryStep::Terminal => return self.directory_operation(id),
        };
        let control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        if control.closed || !control.online {
            return Err(ServiceError::PermissionDenied);
        }
        let result = match self.store.advance_directory(&mut ticket, change) {
            Err(StoreError::InvalidState) => self
                .store
                .advance_directory(&mut ticket, DirectoryChange::Failed)?,
            value => value?,
        };
        *self
            .directory_work
            .lock()
            .map_err(|_| ServiceError::Unavailable)? = Some(ticket);
        Ok(result)
    }
    pub fn directory_operation(&self, id: &str) -> Result<DirectoryProjection> {
        let record = self.store.directory_operation(id)?;
        if matches!(record.phase.as_str(), "catalog" | "groups" | "verifying") {
            let cache = self
                .directory_work
                .lock()
                .map_err(|_| ServiceError::Unavailable)?;
            if let Some(ticket) = cache.as_ref().filter(|ticket| ticket.id == id) {
                return Ok(ticket.projection()?);
            }
        }
        Ok(record)
    }
    pub fn directory_page(&self, id: &str, offset: usize) -> Result<DirectoryPage> {
        Ok(self.store.directory_page(id, offset)?)
    }
}
#[cfg(test)]
#[path = "directory_service_tests.rs"]
mod tests;
