use super::*;
use crate::{
    store::tests::{account, Keys, Root},
    vault::Vault,
};
use std::sync::mpsc;
struct Peer {
    entered: Mutex<Option<mpsc::Sender<()>>>,
    release: Mutex<Option<mpsc::Receiver<()>>>,
}
impl SyncPeer for Peer {
    fn pull(&self, _: &NativeClient, _: &[u8]) -> anyhow::Result<wechat_protocol::SyncBatch> {
        if let Some(entered) = self.entered.lock().unwrap().take() {
            entered.send(()).unwrap();
        }
        if let Some(release) = self.release.lock().unwrap().take() {
            release.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        Ok(wechat_protocol::SyncBatch {
            code: 0,
            flags: 0,
            cursor: vec![],
            commands: vec![wechat_protocol::SyncCommand {
                id: 999,
                payload: b"SENTINEL_PRIVATE_COMMAND".to_vec(),
            }],
            continuation: false,
        })
    }
}
fn setup(root: &Root, keys: &Keys, peer: Peer) -> Arc<AccountService> {
    let store = Arc::new(Store::initialize(Vault::create(&root.0, keys, b"").unwrap()).unwrap());
    store.accept_login(0, account()).unwrap();
    let mut service = AccountService::new(store).unwrap();
    service.control.lock().unwrap().online = true;
    service.sync_peer = Box::new(peer);
    Arc::new(service)
}
#[test]
fn sync_rpc_returns_only_the_committed_projection_and_old_account_responses_are_fenced() {
    let root = Root::new();
    let keys = Keys::default();
    let service = setup(
        &root,
        &keys,
        Peer {
            entered: Mutex::new(None),
            release: Mutex::new(None),
        },
    );
    let frame=br#"{"id":1,"method":"sync.pull","params":{"accountGeneration":1,"accountIdentity":"synthetic-user"}}"#;
    let result = crate::ipc::respond_with(frame, Some(&service));
    assert_eq!(
        result["result"]["checkpoint"], 1,
        "sync RPC must reach the actual journal owner"
    );
    assert!(!result.to_string().contains("SENTINEL"));
    assert!(!result.to_string().contains("cursor\""));
    let page = crate::ipc::respond_with(
        br#"{"id":2,"method":"events.page","params":{"accountGeneration":1,"after":"0"}}"#,
        Some(&service),
    );
    assert_eq!(page["result"]["items"], serde_json::json!([]));
    for frame in [br#"{"id":3,"method":"sync.pull","params":{"accountGeneration":1,"accountIdentity":"synthetic-user","secret":"SENTINEL_IMPORT"}}"#.as_slice(),
        br#"{"id":3,"method":"events.page","params":{"accountGeneration":1,"after":"0","after":"1"}}"#.as_slice()] {
        let rejected=crate::ipc::respond_with(frame,Some(&service));assert_eq!(rejected["error"]["code"],"invalid_params");assert!(!rejected.to_string().contains("SENTINEL"));
    }
    let (entered, observe) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let second_root = Root::new();
    let second_keys = Keys::default();
    let racing = setup(
        &second_root,
        &second_keys,
        Peer {
            entered: Mutex::new(Some(entered)),
            release: Mutex::new(Some(wait)),
        },
    );
    let worker = racing.clone();
    let thread = std::thread::spawn(move || worker.pull_sync(1, "synthetic-user"));
    observe.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(racing.pull_sync(1, "synthetic-user").is_err());
    racing.disconnect().unwrap();
    release.send(()).unwrap();
    assert!(thread.join().unwrap().is_err());
    assert!(racing.store.sync_ticket(1).is_err());
}

#[test]
fn a_definitively_rejected_session_keeps_credentials_but_stops_delegation() {
    struct Rejected;
    impl SyncPeer for Rejected {
        fn pull(&self, _: &NativeClient, _: &[u8]) -> anyhow::Result<wechat_protocol::SyncBatch> {
            Err(wechat_protocol::ServiceRejected::new(wechat_protocol::Service::Sync, -13).into())
        }
    }
    let root = Root::new();
    let keys = Keys::default();
    let store = Arc::new(Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap());
    store.accept_login(0, account()).unwrap();
    let lease = store.authorize(1, "friend").unwrap();
    let mut service = AccountService::new(store).unwrap();
    service.control.lock().unwrap().online = true;
    service.sync_peer = Box::new(Rejected);
    assert!(service.pull_sync(1, "synthetic-user").is_err());
    let status = service.status().unwrap();
    assert!(
        !status.authenticated,
        "a rejected account must not still report online"
    );
    assert!(status.credentials_available);
    assert!(service
        .store
        .queue_send(&lease, "after-session-rejection", "must not send")
        .is_err());
}
