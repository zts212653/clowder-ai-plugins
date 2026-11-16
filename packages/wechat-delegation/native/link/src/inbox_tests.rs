use super::*;
use crate::{
    store::tests::{account, Keys, Root},
    vault::Vault,
};
use wechat_protocol::{protobuf as p, SyncBatch, SyncCommand};
fn text(id: u64, from: &str, to: &str, content: &str) -> SyncCommand {
    SyncCommand {
        id: 5,
        payload: p::message(&[
            p::uint(1, 1),
            p::bytes(2, &p::bytes(1, from.as_bytes())),
            p::bytes(3, &p::bytes(1, to.as_bytes())),
            p::uint(4, 1),
            p::bytes(5, &p::bytes(1, content.as_bytes())),
            p::uint(6, 0),
            p::uint(7, 0),
            p::bytes(8, &p::buffer(&[])),
            p::uint(9, 100),
            p::uint(12, id),
        ])
        .unwrap(),
    }
}
fn batch(commands: Vec<SyncCommand>, cursor: Vec<u8>) -> SyncBatch {
    SyncBatch {
        code: 0,
        flags: 0,
        cursor,
        commands,
        continuation: false,
    }
}
fn cursor(n: u64) -> Vec<u8> {
    p::message(&[
        p::uint(1, 1),
        p::bytes(2, &p::message(&[p::uint(1, 1), p::uint(2, n)]).unwrap()),
    ])
    .unwrap()
}
#[test]
fn sync_commit_retains_commands_and_messages_atomically_without_exposing_raw_state() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    let ticket = store
        .sync_ticket(1)
        .expect("owned sync checkpoint must be available");
    let command = text(91, "friend", "synthetic-user", "synthetic incoming text");
    let next = store
        .commit_sync(
            &ticket,
            batch(
                vec![
                    command.clone(),
                    SyncCommand {
                        id: 999,
                        payload: b"SENTINEL_UNKNOWN_PRIVATE_COMMAND".to_vec(),
                    },
                ],
                cursor(2),
            ),
        )
        .unwrap();
    assert_eq!(next.event_cursor, "1");
    assert_eq!(next.retained_unprojected, 1);
    let message = store.message(1, "1:91").unwrap();
    assert_eq!(message.body.as_deref(), Some("synthetic incoming text"));
    let page = store.events(1, "0").unwrap();
    assert_eq!(page.items.len(), 1);
    let wire = serde_json::to_string(&(next, page, message)).unwrap();
    assert!(!wire.contains("SENTINEL"));
    assert!(!wire.contains("session_key"));
    assert!(store
        .commit_sync(&ticket, batch(vec![], cursor(1)))
        .is_err());
    let current = store.sync_ticket(1).unwrap();
    store
        .commit_sync(&current, batch(vec![command], cursor(3)))
        .unwrap();
    assert_eq!(store.events(1, "0").unwrap().items.len(), 1);
    drop(store);
    let restored = Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap();
    assert_eq!(restored.sync_ticket(1).unwrap().cursor, cursor(3));
    assert_eq!(restored.events(1, "0").unwrap().items.len(), 1);
    let data = restored.lock().unwrap();
    assert_eq!(data.state.inboxes[&1].commands.len(), 2);
    let disk = std::fs::read(root.0.join("state.vault")).unwrap();
    assert!(!disk.windows(8).any(|part| part == b"SENTINEL"));
}
#[test]
fn account_fences_reject_late_sync_and_malformed_pages_never_advance_the_checkpoint() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    let ticket = store.sync_ticket(1).unwrap();
    assert!(store
        .commit_sync(&ticket, batch(vec![], vec![255]))
        .is_err());
    assert!(store.sync_ticket(1).unwrap().cursor.is_empty());
    store.logout(1).unwrap();
    assert!(store
        .commit_sync(
            &ticket,
            batch(vec![text(1, "friend", "synthetic-user", "late")], cursor(1))
        )
        .is_err());
    store.accept_login(2, account()).unwrap();
    assert!(store.events(3, "0").unwrap().items.is_empty());
    assert!(store.message(3, "1:1").is_err());
}

#[test]
fn a_real_commit_failure_cannot_publish_messages_or_skip_the_cursor() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    let ticket = store.sync_ticket(1).unwrap();
    let original = std::fs::read(root.0.join("state.vault")).unwrap();
    std::fs::rename(root.0.join("state.vault"), root.0.join("synthetic-backup")).unwrap();
    std::fs::create_dir(root.0.join("state.vault")).unwrap();
    assert!(store
        .commit_sync(
            &ticket,
            batch(
                vec![text(7, "friend", "synthetic-user", "not committed")],
                cursor(1)
            )
        )
        .is_err());
    assert!(store.events(1, "0").unwrap().items.is_empty());
    assert!(store.sync_ticket(1).unwrap().cursor.is_empty());
    std::fs::remove_dir(root.0.join("state.vault")).unwrap();
    std::fs::rename(root.0.join("synthetic-backup"), root.0.join("state.vault")).unwrap();
    assert_eq!(std::fs::read(root.0.join("state.vault")).unwrap(), original);
    drop(store);
    let restored = Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap();
    assert!(restored.events(1, "0").unwrap().items.is_empty());
}
#[test]
fn paged_events_and_group_outgoing_projections_preserve_identity_and_conflicts() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    let mut commands = (1..=101)
        .map(|id| text(id, "friend", "synthetic-user", "hello"))
        .collect::<Vec<_>>();
    commands.push(text(
        102,
        "synthetic-user",
        "room@chatroom",
        "canonical outgoing text",
    ));
    commands.push(text(
        103,
        "room@chatroom",
        "synthetic-user",
        "member:\nhello",
    ));
    commands.push(text(
        104,
        "room@chatroom",
        "foreign-account",
        "must remain private",
    ));
    let ticket = store.sync_ticket(1).unwrap();
    let result = store
        .commit_sync(&ticket, batch(commands, cursor(1)))
        .unwrap();
    assert_eq!(result.retained_unprojected, 1);
    let page = store.events(1, "0").unwrap();
    assert_eq!(page.items.len(), 100);
    assert_eq!(page.next_cursor, "100");
    assert!(page.more);
    let rest = store.events(1, &page.next_cursor).unwrap();
    assert_eq!(rest.items.len(), 3);
    assert_eq!(rest.next_cursor, "103");
    assert!(!rest.more);
    let outgoing = store.message(1, "1:102").unwrap();
    assert_eq!(outgoing.direction, "outgoing");
    assert_eq!(outgoing.thread_id, "room@chatroom");
    assert_eq!(outgoing.body.as_deref(), Some("canonical outgoing text"));
    let incoming = store.message(1, "1:103").unwrap();
    assert_eq!(incoming.direction, "incoming");
    assert!(incoming.sender_id.is_none());
    assert!(store.message(1, "1:104").is_err());
    let current = store.sync_ticket(1).unwrap();
    let conflict = store
        .commit_sync(
            &current,
            batch(
                vec![text(
                    102,
                    "synthetic-user",
                    "room@chatroom",
                    "conflicting text",
                )],
                cursor(2),
            ),
        )
        .unwrap();
    assert_eq!(conflict.retained_unprojected, 2);
    assert_eq!(store.message(1, "1:102").unwrap(), outgoing);
}

#[test]
fn unchanged_sync_does_not_rewrite_the_vault_or_advance_the_checkpoint() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    let ticket = store.sync_ticket(1).unwrap();
    store
        .commit_sync(&ticket, batch(vec![], cursor(1)))
        .unwrap();
    let disk = std::fs::read(root.0.join("state.vault")).unwrap();
    let same = store.sync_ticket(1).unwrap();
    let result = store
        .commit_sync(&same, batch(vec![], same.cursor.clone()))
        .unwrap();
    assert_eq!(
        result.checkpoint, 1,
        "an empty poll must not create another durable checkpoint"
    );
    assert_eq!(std::fs::read(root.0.join("state.vault")).unwrap(), disk);
}
