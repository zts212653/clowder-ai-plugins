//! Private sync journal and allowlisted text projections share the account vault.
use super::*;
use std::collections::BTreeMap;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Inbox {
    identity: String,
    revision: u64,
    cursor: Vec<u8>,
    commands: BTreeMap<String, wechat_protocol::SyncCommand>,
    messages: BTreeMap<String, MessageProjection>,
    events: Vec<EventProjection>,
    unprojected: u64,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Debug)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MessageProjection {
    pub id: String,
    pub account_generation: u64,
    pub account_identity: String,
    pub thread_id: String,
    pub sender_id: Option<String>,
    pub direction: String,
    pub server_id: Option<String>,
    pub message_type: i32,
    pub body: Option<String>,
    pub created_at: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EventProjection {
    pub cursor: String,
    pub message_id: String,
    pub thread_id: String,
    pub created_at: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub items: Vec<EventProjection>,
    pub next_cursor: String,
    pub more: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProjection {
    pub account_generation: u64,
    pub checkpoint: u64,
    pub event_cursor: String,
    pub more: bool,
    pub retained_unprojected: u64,
}
pub(crate) struct SyncTicket {
    pub generation: u64,
    pub identity: String,
    pub cursor: Vec<u8>,
    revision: u64,
}
fn valid_coordinate(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}
fn valid_cursor(cursor: &[u8]) -> bool {
    cursor.len() <= 65536
        && (cursor.is_empty() || wechat_protocol::wire::decode_cursor(cursor).is_ok())
}
fn account(state: &State, generation: u64) -> Result<&AccountState> {
    if generation != state.generation {
        return Err(StoreError::StaleGeneration);
    }
    state.account.as_ref().ok_or(StoreError::StaleGeneration)
}
fn command_key(command: &wechat_protocol::SyncCommand) -> String {
    let mut hash = openssl::sha::Sha256::new();
    hash.update(&command.id.to_be_bytes());
    hash.update(&command.payload);
    hash.finish().iter().map(|b| format!("{b:02x}")).collect()
}
fn project(
    command: &wechat_protocol::SyncCommand,
    generation: u64,
    identity: &str,
    key: &str,
) -> Option<MessageProjection> {
    if command.id != 5 {
        return None;
    }
    let message = wechat_protocol::wire::decode_add_message(&command.payload, identity).ok()?;
    if !valid_coordinate(&message.peer)
        || !valid_coordinate(&message.from)
        || !valid_coordinate(&message.to)
        || (message.from != identity && message.to != identity)
    {
        return None;
    }
    let id = format!(
        "{generation}:{}",
        message.server_message_id.as_deref().unwrap_or(key)
    );
    let body = if message.message_type == 1 {
        message
            .content_text
            .filter(|body| body.len() <= 65536 && !body.contains('\0'))
    } else {
        None
    };
    Some(MessageProjection {
        id,
        account_generation: generation,
        account_identity: identity.into(),
        thread_id: message.peer,
        sender_id: message.sender_id,
        direction: if message.outgoing {
            "outgoing".into()
        } else {
            "incoming".into()
        },
        server_id: message.server_message_id,
        message_type: message.message_type,
        body,
        created_at: message.created_at,
    })
}
pub(super) fn validate(state: &State) -> Result<()> {
    for (generation, inbox) in &state.inboxes {
        if *generation == 0
            || *generation > state.generation
            || !valid_coordinate(&inbox.identity)
            || !valid_cursor(&inbox.cursor)
            || inbox.revision > 9_007_199_254_740_991
            || inbox.unprojected > inbox.commands.len() as u64
            || inbox.events.len() != inbox.messages.len()
        {
            return Err(StoreError::InvalidState);
        }
        for (key, command) in &inbox.commands {
            if command.payload.len() > wechat_protocol::MAX_MESSAGE_BYTES
                || *key != command_key(command)
            {
                return Err(StoreError::InvalidState);
            }
        }
        for (index, event) in inbox.events.iter().enumerate() {
            let message = inbox
                .messages
                .get(&event.message_id)
                .ok_or(StoreError::InvalidState)?;
            if event.cursor != (index + 1).to_string()
                || event.thread_id != message.thread_id
                || event.created_at != message.created_at
                || message.account_generation != *generation
                || message.account_identity != inbox.identity
                || !message.id.starts_with(&format!("{generation}:"))
                || !valid_coordinate(&message.thread_id)
                || !matches!(message.direction.as_str(), "incoming" | "outgoing")
                || message.body.as_ref().is_some_and(|body| {
                    message.message_type != 1 || body.len() > 65536 || body.contains('\0')
                })
            {
                return Err(StoreError::InvalidState);
            }
        }
    }
    Ok(())
}
impl Store {
    pub(crate) fn sync_ticket(&self, generation: u64) -> Result<SyncTicket> {
        let data = self.lock()?;
        let owner = account(&data.state, generation)?;
        let inbox = data.state.inboxes.get(&generation);
        Ok(SyncTicket {
            generation,
            identity: owner.own_username.clone(),
            cursor: inbox.map(|i| i.cursor.clone()).unwrap_or_default(),
            revision: inbox.map_or(0, |i| i.revision),
        })
    }
    pub(crate) fn commit_sync(
        &self,
        ticket: &SyncTicket,
        batch: wechat_protocol::SyncBatch,
    ) -> Result<SyncProjection> {
        if !valid_cursor(&batch.cursor)
            || !matches!(batch.code, 0 | -2006)
            || batch.commands.len() > 10000
            || batch
                .commands
                .iter()
                .try_fold(0usize, |n, command| n.checked_add(command.payload.len()))
                .is_none_or(|n| n > wechat_protocol::MAX_MESSAGE_BYTES)
        {
            return Err(StoreError::InvalidState);
        }
        {
            let data = self.lock()?;
            if account(&data.state, ticket.generation)?.own_username != ticket.identity {
                return Err(StoreError::StaleGeneration);
            }
            if let Some(inbox) = data.state.inboxes.get(&ticket.generation) {
                if inbox.revision != ticket.revision || inbox.cursor != ticket.cursor {
                    return Err(StoreError::StaleSync);
                }
                if batch.cursor == inbox.cursor
                    && batch
                        .commands
                        .iter()
                        .all(|command| inbox.commands.contains_key(&command_key(command)))
                {
                    return Ok(SyncProjection {
                        account_generation: ticket.generation,
                        checkpoint: inbox.revision,
                        event_cursor: inbox.events.len().to_string(),
                        more: batch.continuation,
                        retained_unprojected: inbox.unprojected,
                    });
                }
            }
        }
        self.update(|state| {
            if account(state, ticket.generation)?.own_username != ticket.identity {
                return Err(StoreError::StaleGeneration);
            }
            let inbox = state
                .inboxes
                .entry(ticket.generation)
                .or_insert_with(|| Inbox {
                    identity: ticket.identity.clone(),
                    ..Inbox::default()
                });
            if inbox.revision != ticket.revision || inbox.cursor != ticket.cursor {
                return Err(StoreError::StaleSync);
            }
            for command in batch.commands {
                let key = command_key(&command);
                if inbox.commands.contains_key(&key) {
                    continue;
                }
                let projection = project(&command, ticket.generation, &ticket.identity, &key);
                inbox.commands.insert(key, command);
                match projection {
                    Some(message) if !inbox.messages.contains_key(&message.id) => {
                        inbox.events.push(EventProjection {
                            cursor: (inbox.events.len() + 1).to_string(),
                            message_id: message.id.clone(),
                            thread_id: message.thread_id.clone(),
                            created_at: message.created_at,
                        });
                        inbox.messages.insert(message.id.clone(), message);
                    }
                    Some(message) if inbox.messages.get(&message.id) == Some(&message) => {}
                    _ => {
                        inbox.unprojected = inbox
                            .unprojected
                            .checked_add(1)
                            .ok_or(StoreError::InvalidState)?;
                    }
                }
            }
            // The cursor, raw retained commands and public events publish in one
            // encrypted commit. A rejected/conflicting batch cannot skip data.
            inbox.cursor = batch.cursor;
            inbox.revision = inbox
                .revision
                .checked_add(1)
                .ok_or(StoreError::InvalidState)?;
            Ok(SyncProjection {
                account_generation: ticket.generation,
                checkpoint: inbox.revision,
                event_cursor: inbox.events.len().to_string(),
                more: batch.continuation,
                retained_unprojected: inbox.unprojected,
            })
        })
    }
    pub fn events(&self, generation: u64, after: &str) -> Result<EventPage> {
        let offset = after
            .parse::<usize>()
            .ok()
            .filter(|n| n.to_string() == after)
            .ok_or(StoreError::InvalidState)?;
        let data = self.lock()?;
        account(&data.state, generation)?;
        let events = data
            .state
            .inboxes
            .get(&generation)
            .map_or(&[][..], |inbox| inbox.events.as_slice());
        if offset > events.len() {
            return Err(StoreError::InvalidState);
        }
        let end = offset.saturating_add(100).min(events.len());
        Ok(EventPage {
            items: events[offset..end].to_vec(),
            next_cursor: end.to_string(),
            more: end < events.len(),
        })
    }
    pub fn message(&self, generation: u64, id: &str) -> Result<MessageProjection> {
        let data = self.lock()?;
        account(&data.state, generation)?;
        data.state
            .inboxes
            .get(&generation)
            .and_then(|i| i.messages.get(id))
            .cloned()
            .ok_or(StoreError::UnknownMessage)
    }
}
#[cfg(test)]
#[path = "inbox_tests.rs"]
mod tests;
