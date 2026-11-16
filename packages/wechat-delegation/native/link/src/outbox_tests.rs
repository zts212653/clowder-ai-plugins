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
