use super::*;
use crate::{
    store::tests::{account, Keys, Root},
    vault::Vault,
};
#[test]
fn explicit_resume_fences_the_prior_owner_and_commits_credentials_with_the_receipt_once() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Arc::new(Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap());
    let old = account();
    store.accept_login(0, old.clone()).unwrap();
    let prior = store.persistence(1);
    let lease = store.authorize(1, "friend").unwrap();
    let ticket = match store
        .begin_resume("resume-1", 1, "synthetic-user")
        .expect("explicit resume must persist before authenticating")
    {
        ResumeAdmission::New(ticket) => ticket,
        _ => panic!("new intent"),
    };
    assert_eq!(store.generation().unwrap(), 2);
    assert!(prior.persist(&old, &old).is_err());
    assert!(store
        .queue_send(&lease, "old-lease", "must not send")
        .is_err());
    let persistence = store.resume_persistence(&ticket);
    let mut accepted = old.clone();
    accepted.session_key = vec![0x42; 16];
    persistence.persist(&old, &accepted).unwrap();
    assert_eq!(
        store.resume_record("resume-1").unwrap().phase,
        ResumePhase::Succeeded
    );
    assert_eq!(
        store.account().unwrap().unwrap().session_key,
        accepted.session_key
    );
    assert!(persistence.persist(&accepted, &old).is_err());
    assert!(matches!(
        store.begin_resume("resume-1", 1, "synthetic-user").unwrap(),
        ResumeAdmission::Existing(_)
    ));
    drop(prior);
    drop(persistence);
    drop(store);
    let restored = Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap();
    assert_eq!(
        restored.resume_record("resume-1").unwrap().phase,
        ResumePhase::Succeeded
    );
}
#[test]
fn cancellation_restart_and_wrong_identity_cannot_accept_a_late_resume_callback() {
    for cancel in [false, true] {
        let root = Root::new();
        let keys = Keys::default();
        let store =
            Arc::new(Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap());
        let old = account();
        store.accept_login(0, old.clone()).unwrap();
        assert!(store.begin_resume("wrong", 1, "foreign-user").is_err());
        let ticket = match store.begin_resume("racing", 1, "synthetic-user").unwrap() {
            ResumeAdmission::New(ticket) => ticket,
            _ => panic!("new intent"),
        };
        let callback = store.resume_persistence(&ticket);
        if cancel {
            assert_eq!(
                store.cancel_resume("racing").unwrap().phase,
                ResumePhase::Cancelled
            );
            assert!(callback.persist(&old, &old).is_err());
        }
        drop(callback);
        drop(store);
        let restored = Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap();
        let record = restored.resume_record("racing").unwrap();
        assert_eq!(
            record.phase,
            if cancel {
                ResumePhase::Cancelled
            } else {
                ResumePhase::Interrupted
            }
        );
        assert!(record.authentication_may_have_occurred);
        assert!(matches!(
            restored
                .begin_resume("racing", 1, "synthetic-user")
                .unwrap(),
            ResumeAdmission::Existing(_)
        ));
    }
}

#[test]
fn same_account_resume_keeps_sync_cursor_message_ids_and_events_without_copying_history() {
    use wechat_protocol::protobuf as p;
    let root = Root::new();
    let keys = Keys::default();
    let store = Arc::new(Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap());
    store.accept_login(0, account()).unwrap();
    let cursor = p::message(&[
        p::uint(1, 1),
        p::bytes(2, &p::message(&[p::uint(1, 1), p::uint(2, 7)]).unwrap()),
    ])
    .unwrap();
    let payload = p::message(&[
        p::uint(1, 1),
        p::bytes(2, &p::bytes(1, b"friend")),
        p::bytes(3, &p::bytes(1, b"synthetic-user")),
        p::uint(4, 1),
        p::bytes(5, &p::bytes(1, b"saved text")),
        p::uint(6, 0),
        p::uint(7, 0),
        p::bytes(8, &p::buffer(&[])),
        p::uint(9, 100),
        p::uint(12, 91),
    ])
    .unwrap();
    let prior = store.sync_ticket(1).unwrap();
    store
        .commit_sync(
            &prior,
            wechat_protocol::SyncBatch {
                code: 0,
                flags: 0,
                cursor: cursor.clone(),
                commands: vec![wechat_protocol::SyncCommand { id: 5, payload }],
                continuation: false,
            },
        )
        .unwrap();
    store
        .begin_resume("restore-history", 1, "synthetic-user")
        .unwrap();
    assert_eq!(
        store.sync_ticket(2).unwrap().cursor,
        cursor,
        "changing authority generation must not reset the same account's sync cursor"
    );
    assert_eq!(
        store.message(2, "1:91", 0).unwrap().body.as_deref(),
        Some("saved text")
    );
    assert_eq!(store.events(2, "0", 0).unwrap().items.len(), 1);
    store.cancel_resume("restore-history").unwrap();
    store
        .begin_resume("restore-again", 2, "synthetic-user")
        .unwrap();
    assert_eq!(store.sync_ticket(3).unwrap().cursor, cursor);
    assert_eq!(store.lock().unwrap().state.inboxes.len(), 1);
    store.logout(3).unwrap();
    let mut foreign = account();
    foreign.uin = 321;
    foreign.own_username = "foreign-user".into();
    store.accept_login(4, foreign).unwrap();
    assert!(store.events(5, "0", 0).unwrap().items.is_empty());
    assert!(store.message(5, "1:91", 0).is_err());
}
