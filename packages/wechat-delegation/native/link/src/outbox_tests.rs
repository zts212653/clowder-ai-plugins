use super::*;
use crate::store::tests::{account, Keys, Root};

#[test]
fn takeover_is_durable_and_old_authority_cannot_start_or_repeat_a_send() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    let epoch = store.accept_login(0, account()).unwrap();
    for (index, destination) in ["synthetic-friend", "synthetic-group@chatroom"]
        .into_iter()
        .enumerate()
    {
        let lease = store
            .authorize(epoch, destination)
            .expect("native admission must persist explicit authority");
        let key = format!("cancel-{index}");
        let queued = store
            .queue_send(&lease, &key, "synthetic authorized hello")
            .unwrap();
        store.pause(epoch, Some(destination)).unwrap();
        assert!(store.begin_submission(&queued.id).is_err());
        assert_eq!(
            store.receipt(&queued.id).unwrap().state,
            SendPhase::Cancelled
        );
        assert!(store
            .queue_send(&lease, "obsolete", "stale authority")
            .is_err());
        let resumed = store.authorize(epoch, destination).unwrap();
        assert!(resumed.conversation_generation > lease.conversation_generation);
        let key = format!("once-{index}");
        let queued = store
            .queue_send(&resumed, &key, "synthetic authorized hello")
            .unwrap();
        assert_eq!(
            store
                .queue_send(&resumed, &key, "synthetic authorized hello")
                .unwrap(),
            queued
        );
        assert!(matches!(
            store.queue_send(&resumed, &key, "different text"),
            Err(StoreError::IdempotencyConflict)
        ));
        let request = store.begin_submission(&queued.id).unwrap();
        assert_eq!(request.text, "synthetic authorized hello");
        assert_eq!(request.receipt.client_message_id, queued.client_message_id);
        assert!(matches!(
            store.begin_submission(&queued.id),
            Err(StoreError::AlreadySubmitted)
        ));
        store.pause(epoch, Some(destination)).unwrap();
        assert_eq!(
            store.receipt(&queued.id).unwrap().state,
            SendPhase::Submitting
        );
        let completed = store
            .complete_send(
                &queued.id,
                SendOutcome::Accepted("12345678901234567890".into()),
            )
            .unwrap();
        assert_eq!(completed.state, SendPhase::Accepted);
        assert!(store.begin_submission(&queued.id).is_err());
    }
}

#[test]
fn restart_keeps_uncertain_sends_and_pauses_every_scope_without_retry() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    let epoch = store.accept_login(0, account()).unwrap();
    let lease = store.authorize(epoch, "synthetic-group@chatroom").unwrap();
    let in_flight = store
        .queue_send(&lease, "in-flight", "synthetic uncertain")
        .unwrap();
    store.begin_submission(&in_flight.id).unwrap();
    let queued = store
        .queue_send(&lease, "queued", "synthetic not submitted")
        .unwrap();
    drop(store);
    let restored = Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap();
    assert_eq!(
        restored.receipt(&in_flight.id).unwrap().state,
        SendPhase::NeedsReview
    );
    assert_eq!(
        restored.receipt(&queued.id).unwrap().state,
        SendPhase::Cancelled
    );
    assert!(restored.begin_submission(&in_flight.id).is_err());
    assert!(restored
        .queue_send(&lease, "new-after-restart", "must refuse")
        .is_err());
    let resumed = restored
        .authorize(epoch, "synthetic-group@chatroom")
        .unwrap();
    assert!(resumed.conversation_generation > lease.conversation_generation);
    assert_eq!(
        restored
            .queue_send(&lease, "in-flight", "synthetic uncertain")
            .unwrap()
            .state,
        SendPhase::NeedsReview
    );
    assert!(restored.begin_submission(&in_flight.id).is_err());
    restored.logout(epoch).unwrap();
    assert!(restored
        .queue_send(&resumed, "after-logout", "must refuse")
        .is_err());
}

#[test]
fn a_queued_send_cannot_cross_its_explicit_deadline_at_the_final_submission_checkpoint() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    let lease = store.authorize(1, "friend").unwrap();
    store
        .queue_send(&lease, "deadline-handoff", "synthetic text")
        .unwrap();
    // Configure the deadline after fixture admission, before the actual final
    // checkpoint, so slow setup cannot turn this into a queue-admission test.
    store
        .update(|state| {
            state.grants.get_mut("friend").unwrap().expires_at_ms = Some(1);
            Ok(())
        })
        .unwrap();
    assert!(
        store.begin_submission("deadline-handoff").is_err(),
        "expired authorization must fail at final handoff even if it was queued earlier"
    );
    assert_ne!(
        store.receipt("deadline-handoff").unwrap().state,
        SendPhase::Submitting
    );
}

#[test]
fn deadline_grants_are_bounded_durable_and_never_delete_send_history() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    for deadline in [0, 1, 9_007_199_254_740_992] {
        assert!(store.authorize_until(1, "friend", Some(deadline)).is_err());
    }
    let deadline = now_ms().unwrap() + 60_000;
    let lease = store.authorize_until(1, "friend", Some(deadline)).unwrap();
    store
        .queue_send(&lease, "retained", "synthetic text")
        .unwrap();
    drop(store);
    let store = Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap();
    assert_eq!(
        store.lock().unwrap().state.grants["friend"].expires_at_ms,
        Some(deadline)
    );
    assert_eq!(
        store.receipt("retained").unwrap().state,
        SendPhase::Cancelled
    );
    assert!(store
        .queue_send(&lease, "no-auto-restore", "synthetic text")
        .is_err());
}
