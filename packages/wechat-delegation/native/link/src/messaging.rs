//! Text execution shares AccountService's account owner and Store transaction.
//! Flag/roster interpretation follows fixed upstream metadata.rs and the prior
//! reviewed current-directory.patch, without profile/cache or raw DTO export.
use super::*;
use crate::store::{ConversationLease, SendOutcome, SendPhase, SendReceipt};
use wechat_protocol::{protobuf as p, TextSendOptions, TextSendResult};

pub(super) trait TextPeer: Send + Sync {
    fn verify(&self, client: &NativeClient, destination: &str) -> Result<()>;
    fn send(
        &self,
        client: &NativeClient,
        destination: &str,
        text: &str,
        options: TextSendOptions,
        before_submit: &mut dyn FnMut() -> anyhow::Result<()>,
    ) -> anyhow::Result<TextSendResult>;
}
pub(super) struct NativeTextPeer;
fn number(fields: &[p::Field], id: u32) -> anyhow::Result<Option<u32>> {
    match p::optional(fields, id)? {
        None => Ok(None),
        Some(p::Value::Varint(n)) => Ok(Some(u32::try_from(*n)?)),
        _ => anyhow::bail!("invalid_contact_proof"),
    }
}
fn ordinary_destination(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
        && (!value.contains('@')
            || value.ends_with("@chatroom") && value.len() > 9 && value.matches('@').count() == 1)
        && !value.starts_with("gh_")
        && !matches!(
            value,
            "filehelper"
                | "weixin"
                | "weibo"
                | "fmessage"
                | "floatbottle"
                | "medianote"
                | "qmessage"
                | "tmessage"
                | "masssendapp"
                | "newsapp"
                | "blogapp"
                | "qqmail"
                | "qqsync"
                | "lbsapp"
                | "shakeapp"
                | "brandsessionholder"
                | "brandservicesessionholder"
                | "appbrandcustomerservicemsg"
                | "service_officialaccounts"
                | "notifymessage"
                | "notification_messages"
                | "wa_app_kefu_message"
                | "wxzhifu"
        )
}
fn direct_proof(record: &wechat_protocol::ContactRecord) -> anyhow::Result<bool> {
    let fields = p::decode(&record.raw)?;
    let controlled = wechat_protocol::controlled_contact_fields(&record.raw)?;
    Ok(!controlled.contains(&8)
        && number(&fields, 7)? == Some(u32::MAX)
        && number(&fields, 8)?.is_some_and(|flag| flag & 1 != 0)
        && number(&fields, 24)?.unwrap_or(0) == 0)
}
fn membership(record: &wechat_protocol::ContactRecord) -> anyhow::Result<Option<bool>> {
    Ok(match number(&p::decode(&record.raw)?, 85)? {
        Some(1) => Some(true),
        Some(2) => Some(false),
        _ => None,
    })
}
fn roster_proof(roster: &wechat_protocol::RoomRoster, room: &str, own: &str) -> bool {
    roster.room_id == room
        && (roster.members.iter().any(|m| m.username == own)
            || roster
                .full_member_ids
                .as_ref()
                .is_some_and(|ids| ids.iter().any(|id| id == own)))
}
pub(super) fn verified_target(
    client: &NativeClient,
    destination: &str,
) -> Result<crate::store::TargetProjection> {
    let own = client
        .account_identity()
        .map_err(|_| ServiceError::Unavailable)?
        .own_username;
    if !ordinary_destination(destination) || destination == own {
        return Err(ServiceError::PermissionDenied);
    }
    let reply = client
        .request_blocking(|request| request.lookup_contacts(&[destination.to_owned()]))
        .map_err(|error| ServiceError::network(&error))?;
    if reply.results != [0]
        || reply.contacts.len() != 1
        || reply.contacts[0].username != destination
    {
        return Err(ServiceError::PermissionDenied);
    }
    let record = &reply.contacts[0];
    let member = if destination.ends_with("@chatroom") {
        match membership(record).map_err(|_| ServiceError::Unavailable)? {
            Some(member) => member,
            None => {
                let roster = client
                    .request_blocking(|request| request.lookup_room(destination, 0))
                    .map_err(|error| ServiceError::network(&error))?;
                roster_proof(&roster, destination, &own)
            }
        }
    } else {
        direct_proof(record).map_err(|_| ServiceError::Unavailable)?
    };
    if !member {
        return Err(ServiceError::PermissionDenied);
    }
    let clean = |value: &Option<String>| {
        value
            .as_ref()
            .filter(|v| !v.is_empty() && v.len() <= 512 && !v.contains('\0'))
            .cloned()
    };
    let nickname = clean(&record.nickname);
    let remark = clean(&record.remark);
    let alias = clean(&record.alias);
    Ok(crate::store::TargetProjection {
        id: destination.into(),
        kind: if destination.ends_with("@chatroom") {
            "group".into()
        } else {
            "direct".into()
        },
        display_name: remark
            .as_ref()
            .or(nickname.as_ref())
            .cloned()
            .unwrap_or_else(|| destination.into()),
        nickname,
        remark,
        alias,
    })
}
impl TextPeer for NativeTextPeer {
    fn verify(&self, client: &NativeClient, destination: &str) -> Result<()> {
        verified_target(client, destination).map(|_| ())
    }
    fn send(
        &self,
        client: &NativeClient,
        destination: &str,
        text: &str,
        options: TextSendOptions,
        before_submit: &mut dyn FnMut() -> anyhow::Result<()>,
    ) -> anyhow::Result<TextSendResult> {
        client.request_blocking(|request| {
            request.send_text_guarded(destination, text, &options, before_submit)
        })
    }
}
impl AccountService {
    fn text_client(
        control: &Control,
        generation: u64,
        current_generation: u64,
    ) -> Result<NativeClient> {
        if control.closed || !control.online || generation != current_generation {
            return Err(ServiceError::PermissionDenied);
        }
        control.client.clone().ok_or(ServiceError::PermissionDenied)
    }
    pub fn authorize_conversation(
        &self,
        generation: u64,
        identity: &str,
        destination: &str,
    ) -> Result<ConversationLease> {
        if !ordinary_destination(destination) {
            return Err(ServiceError::PermissionDenied);
        }
        let (client, epoch) = {
            let control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
            let client = Self::text_client(&control, generation, self.store.generation()?)?;
            if client
                .account_identity()
                .map_err(|_| ServiceError::Unavailable)?
                .own_username
                != identity
            {
                return Err(ServiceError::PermissionDenied);
            }
            (client, control.authorization_epoch)
        };
        if let Err(problem) = self.text_peer.verify(&client, destination) {
            self.observe_network_failure(generation, &problem)?;
            return Err(problem);
        }
        let control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        Self::text_client(&control, generation, self.store.generation()?)?;
        if control.authorization_epoch != epoch {
            return Err(ServiceError::PermissionDenied);
        }
        Ok(self.store.authorize(generation, destination)?)
    }
    pub fn pause_conversation(&self, generation: u64, destination: Option<&str>) -> Result<()> {
        let mut control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        if generation != self.store.generation()? {
            return Err(ServiceError::InvalidOperation);
        }
        let next = control
            .authorization_epoch
            .checked_add(1)
            .ok_or(ServiceError::Unavailable)?;
        self.store.pause(generation, destination)?;
        control.authorization_epoch = next;
        Ok(())
    }
    pub fn send_text(
        &self,
        lease: &ConversationLease,
        key: &str,
        text: &str,
    ) -> Result<SendReceipt> {
        let (client, receipt) = {
            let control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
            // Durable old receipts remain readable after restart/logout. A key
            // conflict still goes through Store's payload and lease comparison.
            if self.store.receipt(key).is_ok() {
                let receipt = self.store.queue_send(lease, key, text)?;
                if receipt.state != SendPhase::Queued {
                    return Ok(receipt);
                }
            }
            let client =
                Self::text_client(&control, lease.account_generation, self.store.generation()?)?;
            let receipt = self.store.queue_send(lease, key, text)?;
            (client, receipt)
        };
        if let Err(problem) = self.text_peer.verify(&client, &lease.destination) {
            self.observe_network_failure(lease.account_generation, &problem)?;
            return Ok(self.store.stop_queued_send(key, false)?);
        }
        let mut started = false;
        let mut before_submit = || {
            let control = self
                .control
                .lock()
                .map_err(|_| anyhow::anyhow!("admission_unavailable"))?;
            Self::text_client(&control, lease.account_generation, self.store.generation()?)
                .map_err(|_| anyhow::anyhow!("admission_closed"))?;
            self.store.begin_submission(key)?;
            started = true;
            Ok(())
        };
        let result = self.text_peer.send(
            &client,
            &lease.destination,
            text,
            TextSendOptions {
                created_at: receipt.created_at,
                client_message_id: receipt.client_message_id,
                source: None,
            },
            &mut before_submit,
        );
        if let Err(error) = &result {
            self.observe_network_failure(lease.account_generation, &ServiceError::network(error))?;
        }
        if !started {
            return Ok(self.store.stop_queued_send(key, false)?);
        }
        let outcome = match result {
            Ok(value)
                if value.returned_destination_matches
                    && value.returned_client_id_matches
                    && value.outer_code == 0
                    && value.accepted
                    && value.item_code == Some(0)
                    && value.server_message_id.as_ref().is_some_and(|id| {
                        id.parse::<u64>()
                            .is_ok_and(|n| n > 0 && n.to_string() == *id)
                    }) =>
            {
                SendOutcome::Accepted(value.server_message_id.unwrap())
            }
            Ok(value)
                if value.returned_destination_matches
                    && value.returned_client_id_matches
                    && value.outer_code == 0
                    && !value.accepted
                    && value.item_code.is_some_and(|code| code != 0)
                    && value.server_message_id.is_none() =>
            {
                SendOutcome::Rejected
            }
            _ => SendOutcome::Unknown,
        };
        Ok(self.store.complete_send(key, outcome)?)
    }
    pub fn send_receipt(&self, id: &str) -> Result<SendReceipt> {
        Ok(self.store.receipt(id)?)
    }
    pub fn cancel_send(&self, id: &str) -> Result<SendReceipt> {
        let _control = self.control.lock().map_err(|_| ServiceError::Unavailable)?;
        Ok(self.store.stop_queued_send(id, true)?)
    }
}
#[cfg(test)]
#[path = "messaging_tests.rs"]
mod tests;
