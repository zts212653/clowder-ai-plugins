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
    let message = store.message(1, "1:91", 0).unwrap();
    assert_eq!(message.body.as_deref(), Some("synthetic incoming text"));
    let page = store.events(1, "0", 0).unwrap();
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
    assert_eq!(store.events(1, "0", 0).unwrap().items.len(), 1);
    drop(store);
    let restored = Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap();
    assert_eq!(restored.sync_ticket(1).unwrap().cursor, cursor(3));
    assert_eq!(restored.events(1, "0", 0).unwrap().items.len(), 1);
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
    assert!(store.events(3, "0", 0).unwrap().items.is_empty());
    assert!(store.message(3, "1:1", 0).is_err());
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
    assert!(store.events(1, "0", 0).unwrap().items.is_empty());
    assert!(store.sync_ticket(1).unwrap().cursor.is_empty());
    std::fs::remove_dir(root.0.join("state.vault")).unwrap();
    std::fs::rename(root.0.join("synthetic-backup"), root.0.join("state.vault")).unwrap();
    assert_eq!(std::fs::read(root.0.join("state.vault")).unwrap(), original);
    drop(store);
    let restored = Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap();
    assert!(restored.events(1, "0", 0).unwrap().items.is_empty());
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
    let page = store.events(1, "0", 0).unwrap();
    assert_eq!(page.items.len(), 100);
    assert_eq!(page.next_cursor, "100");
    assert!(page.more);
    let rest = store.events(1, &page.next_cursor, 0).unwrap();
    assert_eq!(rest.items.len(), 3);
    assert_eq!(rest.next_cursor, "103");
    assert!(!rest.more);
    let outgoing = store.message(1, "1:102", 0).unwrap();
    assert_eq!(outgoing.direction, "outgoing");
    assert_eq!(outgoing.thread_id, "room@chatroom");
    assert_eq!(outgoing.body.as_deref(), Some("canonical outgoing text"));
    let incoming = store.message(1, "1:103", 0).unwrap();
    assert_eq!(incoming.direction, "incoming");
    assert!(incoming.sender_id.is_none());
    assert!(store.message(1, "1:104", 0).is_err());
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
    assert_eq!(store.message(1, "1:102", 0).unwrap(), outgoing);
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

#[test]
fn canonical_server_lookup_is_exact_account_bound_and_does_not_guess_by_text() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    let id = u64::MAX;
    let ticket = store.sync_ticket(1).unwrap();
    store
        .commit_sync(
            &ticket,
            batch(
                vec![text(id, "synthetic-user", "friend", "canonical outgoing")],
                cursor(1),
            ),
        )
        .unwrap();
    let canonical = store
        .message_by_server(1, &id.to_string())
        .expect("lookup must use the server's exact u64 id within the selected account stream");
    assert_eq!(canonical.id, format!("1:{id}"));
    assert_eq!(canonical.direction, "outgoing");
    assert_eq!(canonical.body.as_deref(), Some("canonical outgoing"));
    for invalid in [
        "0",
        "01",
        "18446744073709551616",
        "canonical outgoing",
        "../vault.id",
    ] {
        assert!(store.message_by_server(1, invalid).is_err());
    }
    assert!(store.message_by_server(1, "42").is_err());
    store.logout(1).unwrap();
    store.accept_login(2, account()).unwrap();
    assert!(store.message_by_server(3, &id.to_string()).is_err());
}

#[test]
fn stream_baseline_requires_complete_sync_and_reset_pauses_senders_without_deleting_history() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    let initial = store.stream().unwrap().unwrap();
    assert!(!initial.caught_up);
    assert!(!initial.source_ref.contains("synthetic-user"));
    let mut first = batch(
        vec![text(1, "friend", "synthetic-user", "retained")],
        cursor(1),
    );
    first.continuation = true;
    store
        .commit_sync(&store.sync_ticket(1).unwrap(), first)
        .unwrap();
    assert!(!store.stream().unwrap().unwrap().caught_up);
    store
        .commit_sync(&store.sync_ticket(1).unwrap(), batch(vec![], cursor(2)))
        .unwrap();
    assert!(
        store.stream().unwrap().unwrap().caught_up,
        "a complete checkpoint must establish the stream baseline"
    );
    let lease = store.authorize(1, "friend").unwrap();
    store
        .queue_send(&lease, "before-reset", "synthetic")
        .unwrap();
    let mut reset = batch(vec![], cursor(2));
    reset.code = -2006;
    let after = store
        .commit_sync(&store.sync_ticket(1).unwrap(), reset)
        .unwrap();
    assert!(after.reset);
    assert_eq!(after.stream.reset_epoch, 1);
    assert!(!after.stream.caught_up);
    assert!(store.begin_submission("before-reset").is_err());
    assert_eq!(
        store.message(1, "1:1", 1).unwrap().body.as_deref(),
        Some("retained")
    );
    store
        .commit_sync(&store.sync_ticket(1).unwrap(), batch(vec![], cursor(3)))
        .unwrap();
    assert!(store.stream().unwrap().unwrap().caught_up);
    store
        .begin_resume("resume-stream", 1, "synthetic-user")
        .unwrap();
    let resumed = store.stream().unwrap().unwrap();
    assert_eq!(resumed.source_ref, initial.source_ref);
    assert!(
        !resumed.caught_up,
        "saved-session authentication still needs a fresh catch-up"
    );
}

#[test]
fn a_native_grant_requires_the_exact_caught_up_stream_epoch() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    assert!(
        store.authorize_until(1, "friend", None, 0).is_err(),
        "a fresh account has no safe message baseline yet"
    );
    store
        .commit_sync(&store.sync_ticket(1).unwrap(), batch(vec![], cursor(1)))
        .unwrap();
    store.authorize_until(1, "friend", None, 0).unwrap();
    let mut reset = batch(vec![], cursor(1));
    reset.code = -2006;
    store
        .commit_sync(&store.sync_ticket(1).unwrap(), reset)
        .unwrap();
    assert!(store.authorize_until(1, "friend", None, 1).is_err());
    store
        .commit_sync(&store.sync_ticket(1).unwrap(), batch(vec![], cursor(2)))
        .unwrap();
    assert!(store.authorize_until(1, "friend", None, 0).is_err());
    store.authorize_until(1, "friend", None, 1).unwrap();
}

#[test]
fn event_and_message_reads_cannot_cross_a_sync_reset_between_pull_and_body_fetch() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    store
        .commit_sync(
            &store.sync_ticket(1).unwrap(),
            batch(
                vec![text(1, "friend", "synthetic-user", "old scope")],
                cursor(1),
            ),
        )
        .unwrap();
    let mut reset = batch(
        vec![text(2, "friend", "synthetic-user", "backfill")],
        cursor(2),
    );
    reset.code = -2006;
    store
        .commit_sync(&store.sync_ticket(1).unwrap(), reset)
        .unwrap();
    assert!(
        store.events(1, "0", 0).is_err(),
        "an old event reader must not see reset backfill under its old authority"
    );
    assert!(store.message(1, "1:2", 0).is_err());
    assert!(store.events(1, "0", 1).is_ok());
}
