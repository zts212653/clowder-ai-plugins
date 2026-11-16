use super::*;
use crate::{
    store::tests::{account, Keys, Root},
    vault::Vault,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc,
};
struct Gate {
    entered: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
}
fn gate() -> (Gate, mpsc::Receiver<()>, mpsc::Sender<()>) {
    let (entered, observation) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    (
        Gate {
            entered,
            release: wait,
        },
        observation,
        release,
    )
}
impl Gate {
    fn wait(self) {
        self.entered.send(()).unwrap();
        self.release.recv_timeout(Duration::from_secs(5)).unwrap();
    }
}
struct Peer {
    before: Mutex<Option<Gate>>,
    after: Mutex<Option<Gate>>,
    verifying: Mutex<Option<Gate>>,
    sends: Arc<AtomicUsize>,
    unknown: bool,
    valid_target: bool,
    reply: Option<TextSendResult>,
    session_rejected: bool,
    verification_rejected: bool,
}
impl TextPeer for Peer {
    fn verify(&self, _: &NativeClient, _: &str) -> Result<()> {
        if self.verification_rejected {
            return Err(ServiceError::SessionRejected);
        }
        if let Some(gate) = self.verifying.lock().unwrap().take() {
            gate.wait();
        }
        if self.valid_target {
            Ok(())
        } else {
            Err(ServiceError::PermissionDenied)
        }
    }
    fn send(
        &self,
        _: &NativeClient,
        _: &str,
        _: &str,
        _: TextSendOptions,
        before_submit: &mut dyn FnMut() -> anyhow::Result<()>,
    ) -> anyhow::Result<TextSendResult> {
        if let Some(gate) = self.before.lock().unwrap().take() {
            gate.wait();
        }
        before_submit()?;
        self.sends.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = self.after.lock().unwrap().take() {
            gate.wait();
        }
        if self.unknown {
            anyhow::bail!("SENTINEL_TRANSPORT_SECRET");
        }
        if self.session_rejected {
            return Err(wechat_protocol::ServiceRejected::new(
                wechat_protocol::Service::NativeEnvelope,
                -13,
            )
            .into());
        }
        if let Some(reply) = &self.reply {
            return Ok(reply.clone());
        }
        Ok(TextSendResult {
            accepted: true,
            outer_code: 0,
            item_code: Some(0),
            server_message_id: Some("12345".into()),
            returned_destination_matches: true,
            returned_client_id_matches: true,
        })
    }
}
fn peer(sends: Arc<AtomicUsize>) -> Peer {
    Peer {
        before: Mutex::new(None),
        after: Mutex::new(None),
        verifying: Mutex::new(None),
        sends,
        unknown: false,
        valid_target: true,
        reply: None,
        session_rejected: false,
        verification_rejected: false,
    }
}
fn setup(root: &Root, keys: &Keys, peer: Peer) -> Arc<AccountService> {
    let store = Arc::new(Store::initialize(Vault::create(&root.0, keys, b"").unwrap()).unwrap());
    store.accept_login(0, account()).unwrap();
    store
        .commit_sync(
            &store.sync_ticket(1).unwrap(),
            wechat_protocol::SyncBatch {
                code: 0,
                flags: 0,
                cursor: vec![],
                commands: vec![],
                continuation: false,
            },
        )
        .unwrap();
    let mut service = AccountService::new(store).unwrap();
    service.text_peer = Box::new(peer);
    service.control.lock().unwrap().online = true;
    Arc::new(service)
}
#[test]
fn real_service_text_submission_is_idempotent_and_takeover_fences_the_last_checkpoint() {
    for destination in ["friend", "room@chatroom"] {
        let root = Root::new();
        let keys = Keys::default();
        let sends = Arc::new(AtomicUsize::new(0));
        let (gate, entered, release) = gate();
        let fake = peer(sends.clone());
        *fake.before.lock().unwrap() = Some(gate);
        let service = setup(&root, &keys, fake);
        let lease = service
            .authorize_conversation(
                1,
                "synthetic-user",
                destination,
                None,
                0,
                &service.admission().unwrap(),
            )
            .expect("service must admit verified explicit authorization")
            .lease;
        let worker = service.clone();
        let copy = lease.clone();
        let thread = std::thread::spawn(move || {
            worker.send_text(&copy, "before-takeover", "synthetic text")
        });
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        service.pause_conversation(1, Some(destination)).unwrap();
        release.send(()).unwrap();
        assert_eq!(thread.join().unwrap().unwrap().state, SendPhase::Cancelled);
        assert_eq!(sends.load(Ordering::SeqCst), 0);
        assert_eq!(
            service
                .send_text(&lease, "before-takeover", "synthetic text")
                .unwrap()
                .state,
            SendPhase::Cancelled
        );
        assert!(service
            .send_text(&lease, "new-after-pause", "must not send")
            .is_err());
        assert!(service
            .send_text(&lease, "before-takeover", "changed payload")
            .is_err());
    }
}
#[test]
fn in_flight_results_stay_truthful_and_unknown_never_resubmits_after_restart() {
    for unknown in [false, true] {
        let root = Root::new();
        let keys = Keys::default();
        let sends = Arc::new(AtomicUsize::new(0));
        let (gate, entered, release) = gate();
        let mut fake = peer(sends.clone());
        fake.unknown = unknown;
        *fake.after.lock().unwrap() = Some(gate);
        let service = setup(&root, &keys, fake);
        let lease = service
            .authorize_conversation(
                1,
                "synthetic-user",
                "friend",
                None,
                0,
                &service.admission().unwrap(),
            )
            .unwrap()
            .lease;
        let worker = service.clone();
        let copy = lease.clone();
        let thread =
            std::thread::spawn(move || worker.send_text(&copy, "in-flight", "synthetic text"));
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            service
                .send_text(&lease, "in-flight", "synthetic text")
                .unwrap()
                .state,
            SendPhase::Submitting
        );
        service.pause_conversation(1, None).unwrap();
        assert_eq!(
            service.cancel_send("in-flight").unwrap().state,
            SendPhase::Submitting
        );
        release.send(()).unwrap();
        let receipt = thread.join().unwrap().unwrap();
        assert_eq!(
            receipt.state,
            if unknown {
                SendPhase::NeedsReview
            } else {
                SendPhase::Accepted
            }
        );
        assert_eq!(
            service
                .send_text(&lease, "in-flight", "synthetic text")
                .unwrap(),
            receipt
        );
        assert_eq!(sends.load(Ordering::SeqCst), 1);
        drop(service);
        let restored = AccountService::new(Arc::new(
            Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap(),
        ))
        .unwrap();
        assert_eq!(restored.send_receipt("in-flight").unwrap(), receipt);
        assert_eq!(
            restored
                .send_text(&lease, "in-flight", "synthetic text")
                .unwrap(),
            receipt
        );
        assert_eq!(sends.load(Ordering::SeqCst), 1);
        assert!(!serde_json::to_string(&receipt)
            .unwrap()
            .contains("SENTINEL"));
    }
}
#[test]
fn concurrent_takeover_or_account_change_prevents_a_late_authorization() {
    for disconnect in [false, true] {
        let root = Root::new();
        let keys = Keys::default();
        let sends = Arc::new(AtomicUsize::new(0));
        let (gate, entered, release) = gate();
        let fake = peer(sends);
        *fake.verifying.lock().unwrap() = Some(gate);
        let service = setup(&root, &keys, fake);
        let worker = service.clone();
        let thread = std::thread::spawn(move || {
            worker.authorize_conversation(
                1,
                "synthetic-user",
                "friend",
                None,
                0,
                &worker.admission().unwrap(),
            )
        });
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        if disconnect {
            service.disconnect().unwrap();
        } else {
            service.pause_conversation(1, None).unwrap();
        }
        release.send(()).unwrap();
        assert!(thread.join().unwrap().is_err());
    }
}
#[test]
fn actual_text_rpc_has_narrow_parameters_and_receipts() {
    let root = Root::new();
    let keys = Keys::default();
    let sends = Arc::new(AtomicUsize::new(0));
    let service = setup(&root, &keys, peer(sends.clone()));
    let call = |v: serde_json::Value| {
        crate::ipc::respond_with(&serde_json::to_vec(&v).unwrap(), Some(&service))
    };
    let granted = call(
        serde_json::json!({"id":1,"method":"conversation.authorize","params":{"accountGeneration":1,"accountIdentity":"synthetic-user","destination":"friend","syncEpoch":0}}),
    );
    let lease = granted["result"]["lease"].clone();
    assert_eq!(
        lease["destination"], "friend",
        "RPC must call the real service"
    );
    let sent = call(
        serde_json::json!({"id":2,"method":"text.send","params":{"lease":lease,"operationId":"rpc-send","text":"synthetic text"}}),
    );
    assert_eq!(sent["result"]["state"], "accepted");
    assert_eq!(sends.load(Ordering::SeqCst), 1);
    for method in [
        "text.send",
        "conversation.authorize",
        "conversation.pause",
        "send.receipt",
        "send.cancel",
    ] {
        let bad = call(
            serde_json::json!({"id":3,"method":method,"params":{"password":"SENTINEL_IMPORT"}}),
        );
        assert_eq!(bad["error"]["code"], "invalid_params");
        assert!(!bad.to_string().contains("SENTINEL"));
    }
}

#[test]
fn current_friend_proof_requires_a_full_fresh_mask_and_ordinary_identity() {
    let record = |mask, flag, verified| wechat_protocol::ContactRecord {
        username: "friend".into(),
        nickname: None,
        remark: None,
        alias: None,
        large_avatar_url: None,
        small_avatar_url: None,
        raw: p::message(&[p::uint(7, mask), p::uint(8, flag), p::uint(24, verified)]).unwrap(),
    };
    assert!(direct_proof(&record(u32::MAX.into(), 3, 0)).unwrap());
    assert!(!direct_proof(&record(0x800, 0x801, 0)).unwrap());
    assert!(!direct_proof(&record(u32::MAX.into(), 2, 0)).unwrap());
    assert!(!direct_proof(&record(u32::MAX.into(), 1, 8)).unwrap());
    for destination in [
        "filehelper",
        "gh_synthetic",
        "x@openim",
        "room@im.chatroom",
        "x@x@chatroom",
        "white space",
        "",
    ] {
        assert!(!ordinary_destination(destination));
    }
    let mut controlled = record(u32::MAX.into(), 1, 0);
    controlled.raw.extend(p::bytes(
        89,
        &p::message(&[
            p::uint(1, 1),
            p::bytes(
                2,
                &p::message(&[p::uint(3, 1), p::bytes(4, &p::uint(1, 8))]).unwrap(),
            ),
        ])
        .unwrap(),
    ));
    assert!(!direct_proof(&controlled).unwrap());
}

#[test]
fn only_a_correlated_acceptance_or_rejection_can_resolve_submission() {
    for mode in ["mismatch", "bad-id", "reject"] {
        let root = Root::new();
        let keys = Keys::default();
        let sends = Arc::new(AtomicUsize::new(0));
        let mut fake = peer(sends.clone());
        fake.reply = Some(TextSendResult {
            accepted: mode != "reject",
            outer_code: 0,
            item_code: Some(if mode == "reject" { -1 } else { 0 }),
            server_message_id: match mode {
                "reject" => None,
                "bad-id" => Some("0".into()),
                _ => Some("1234".into()),
            },
            returned_destination_matches: mode != "mismatch",
            returned_client_id_matches: true,
        });
        let service = setup(&root, &keys, fake);
        let lease = service
            .authorize_conversation(
                1,
                "synthetic-user",
                "friend",
                None,
                0,
                &service.admission().unwrap(),
            )
            .unwrap()
            .lease;
        let receipt = service
            .send_text(&lease, "correlation", "synthetic text")
            .unwrap();
        assert_eq!(
            receipt.state,
            if mode == "reject" {
                SendPhase::Failed
            } else {
                SendPhase::NeedsReview
            }
        );
        assert_eq!(
            service
                .send_text(&lease, "correlation", "synthetic text")
                .unwrap(),
            receipt
        );
        assert_eq!(sends.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn a_target_that_cannot_be_verified_never_reaches_the_send_operation() {
    let root = Root::new();
    let keys = Keys::default();
    let sends = Arc::new(AtomicUsize::new(0));
    let mut fake = peer(sends.clone());
    fake.valid_target = false;
    let service = setup(&root, &keys, fake);
    assert!(service
        .authorize_conversation(
            1,
            "synthetic-user",
            "friend",
            None,
            0,
            &service.admission().unwrap()
        )
        .is_err());
    let lease = service.store.authorize(1, "friend").unwrap(); // synthetic existing policy
    assert_eq!(
        service
            .send_text(&lease, "unverified", "synthetic text")
            .unwrap()
            .state,
        SendPhase::Failed
    );
    assert_eq!(sends.load(Ordering::SeqCst), 0);
    assert!(service
        .authorize_conversation(
            2,
            "synthetic-user",
            "friend",
            None,
            0,
            &service.admission().unwrap()
        )
        .is_err());
    assert!(service
        .authorize_conversation(
            1,
            "different-user",
            "friend",
            None,
            0,
            &service.admission().unwrap()
        )
        .is_err());
}

#[test]
fn actual_stdio_pause_remains_responsive_while_a_text_send_waits_at_submission() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    let root = Root::new();
    let keys = Keys::default();
    let sends = Arc::new(AtomicUsize::new(0));
    let (gate, entered, release) = gate();
    let fake = peer(sends.clone());
    *fake.before.lock().unwrap() = Some(gate);
    let service = setup(&root, &keys, fake);
    let lease = service
        .authorize_conversation(
            1,
            "synthetic-user",
            "room@chatroom",
            None,
            0,
            &service.admission().unwrap(),
        )
        .unwrap()
        .lease;
    let (client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut input = client.try_clone().unwrap();
    let mut replies = BufReader::new(client);
    let worker = service.clone();
    let output = server.try_clone().unwrap();
    let thread = std::thread::spawn(move || {
        crate::stdio::serve(&mut BufReader::new(server), output, Some(worker))
    });
    let send = serde_json::json!({"id":1,"method":"text.send","params":{"lease":lease,"operationId":"stdio-send","text":"synthetic text"}});
    writeln!(input, "{send}").unwrap();
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    writeln!(input, "{}", serde_json::json!({"id":2,"method":"conversation.pause","params":{"accountGeneration":1,"destination":"room@chatroom"}})).unwrap();
    let read = |reader: &mut BufReader<UnixStream>| {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .expect("stdio pause must remain responsive");
        serde_json::from_str::<serde_json::Value>(&line).unwrap()
    };
    let paused = read(&mut replies);
    assert_eq!(paused["id"], 2);
    assert_eq!(paused["result"]["paused"], true);
    release.send(()).unwrap();
    let send = read(&mut replies);
    assert_eq!(send["id"], 1);
    assert_eq!(send["result"]["state"], "cancelled");
    assert_eq!(sends.load(Ordering::SeqCst), 0);
    input.shutdown(std::net::Shutdown::Write).unwrap();
    thread.join().unwrap().unwrap();
}

#[test]
fn group_proof_needs_positive_current_membership_and_the_exact_room() {
    let mut record = wechat_protocol::ContactRecord {
        username: "room@chatroom".into(),
        nickname: None,
        remark: None,
        alias: None,
        large_avatar_url: None,
        small_avatar_url: None,
        raw: vec![],
    };
    assert_eq!(membership(&record).unwrap(), None);
    record.raw = p::uint(85, 1);
    assert_eq!(membership(&record).unwrap(), Some(true));
    record.raw = p::uint(85, 2);
    assert_eq!(membership(&record).unwrap(), Some(false));
    record.raw = p::bytes(85, b"invalid");
    assert!(membership(&record).is_err());
    let mut roster = wechat_protocol::RoomRoster {
        room_id: "room@chatroom".into(),
        version: 1,
        members: vec![],
        full_member_ids: None,
        owner: None,
        administrator_ids: None,
    };
    assert!(!roster_proof(&roster, "room@chatroom", "synthetic-user"));
    roster.full_member_ids = Some(vec!["synthetic-user".into()]);
    assert!(roster_proof(&roster, "room@chatroom", "synthetic-user"));
    assert!(!roster_proof(&roster, "other@chatroom", "synthetic-user"));
    assert!(!roster_proof(&roster, "room@chatroom", "different-user"));
}

#[test]
fn session_rejection_during_verification_or_send_stops_every_grant_without_erasing_credentials() {
    for stage in ["authorize", "verify", "send"] {
        let root = Root::new();
        let keys = Keys::default();
        let sends = Arc::new(AtomicUsize::new(0));
        let mut fake = peer(sends.clone());
        fake.verification_rejected = stage != "send";
        fake.session_rejected = stage == "send";
        let service = setup(&root, &keys, fake);
        let lease = service.store.authorize(1, "friend").unwrap();
        if stage == "authorize" {
            assert!(service
                .authorize_conversation(
                    1,
                    "synthetic-user",
                    "another-friend",
                    None,
                    0,
                    &service.admission().unwrap()
                )
                .is_err());
        } else {
            let result = service
                .send_text(&lease, "expired-session", "synthetic text")
                .unwrap();
            assert_eq!(
                result.state,
                if stage == "send" {
                    SendPhase::NeedsReview
                } else {
                    SendPhase::Cancelled
                }
            );
        }
        let status = service.status().unwrap();
        assert!(!status.authenticated);
        assert!(status.credentials_available);
        assert!(service
            .store
            .queue_send(&lease, "later", "must not send")
            .is_err());
        assert_eq!(
            sends.load(Ordering::SeqCst),
            if stage == "send" { 1 } else { 0 }
        );
    }
}

#[test]
fn queued_authorization_cannot_capture_a_new_epoch_after_takeover() {
    let root = Root::new();
    let keys = Keys::default();
    let service = setup(&root, &keys, peer(Arc::new(AtomicUsize::new(0))));
    let admission = service.admission().unwrap();
    service.pause_conversation(1, Some("friend")).unwrap();
    assert!(
        service
            .authorize_conversation(1, "synthetic-user", "friend", None, 0, &admission)
            .is_err(),
        "the reader admission must fence a delayed worker, before verification starts"
    );
}
