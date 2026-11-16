use super::*;
use crate::{
    store::tests::{account, Keys, Root},
    vault::Vault,
};
struct Peer;
impl DirectoryPeer for Peer {
    fn catalog(
        &self,
        _: &NativeClient,
        contacts: u32,
        rooms: u32,
    ) -> Result<wechat_protocol::InitContactPage> {
        assert_eq!((contacts, rooms), (0, 0));
        Ok(wechat_protocol::InitContactPage {
            contact_sequence: 1,
            room_sequence: 1,
            more: false,
            usernames: vec!["friend".into(), "room@chatroom".into()],
        })
    }
    fn groups(
        &self,
        _: &NativeClient,
        cursor: &[u8],
    ) -> Result<wechat_protocol::GroupMetadataPage> {
        assert_eq!(cursor, [0]);
        Err(ServiceError::Unavailable)
    }
    fn target(&self, _: &NativeClient, id: &str) -> Result<crate::store::TargetProjection> {
        Ok(crate::store::TargetProjection {
            id: id.into(),
            kind: if id.ends_with("@chatroom") {
                "group".into()
            } else {
                "direct".into()
            },
            display_name: format!("current {id}"),
            nickname: None,
            remark: None,
            alias: None,
        })
    }
}
#[test]
fn actual_directory_rpc_publishes_verified_snapshot_with_partial_group_disclosure() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Arc::new(Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap());
    store.accept_login(0, account()).unwrap();
    let mut service = AccountService::new(store).unwrap();
    service.control.lock().unwrap().online = true;
    service.directory_peer = Box::new(Peer);
    let call = |v: serde_json::Value| {
        crate::ipc::respond_with(&serde_json::to_vec(&v).unwrap(), Some(&service))
    };
    let start = call(
        serde_json::json!({"id":1,"method":"directory.start","params":{"operationId":"directory-rpc","accountGeneration":1,"accountIdentity":"synthetic-user"}}),
    );
    assert_eq!(
        start["result"]["phase"], "catalog",
        "directory RPC must reach the account service"
    );
    let disk = std::fs::read(root.0.join("state.vault")).unwrap();
    for _ in 0..4 {
        let step = call(
            serde_json::json!({"id":2,"method":"directory.advance","params":{"operationId":"directory-rpc"}}),
        );
        assert!(step.get("result").is_some());
    }
    assert!(std::fs::read(root.0.join("state.vault")).unwrap() == disk);
    let ready = call(
        serde_json::json!({"id":3,"method":"directory.advance","params":{"operationId":"directory-rpc"}}),
    );
    assert_eq!(ready["result"]["phase"], "ready");
    let page = call(
        serde_json::json!({"id":4,"method":"directory.page","params":{"operationId":"directory-rpc","offset":0}}),
    );
    assert_eq!(page["result"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        page["result"]["directory"]["groupDiscoveryIncomplete"],
        true
    );
    let status = call(
        serde_json::json!({"id":5,"method":"directory.operation","params":{"operationId":"directory-rpc"}}),
    );
    assert_eq!(status["result"]["phase"], "ready");
    assert!(service
        .start_directory("directory-rpc", 1, "synthetic-user")
        .is_ok());
}

#[test]
fn disconnect_during_catalog_fetch_interrupts_the_receipt_and_rejects_late_publication() {
    use std::sync::mpsc;
    struct Blocked {
        entered: Mutex<Option<mpsc::Sender<()>>>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl DirectoryPeer for Blocked {
        fn catalog(
            &self,
            c: &NativeClient,
            a: u32,
            b: u32,
        ) -> Result<wechat_protocol::InitContactPage> {
            if let Some(tx) = self.entered.lock().unwrap().take() {
                tx.send(()).unwrap();
            }
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            Peer.catalog(c, a, b)
        }
        fn groups(
            &self,
            c: &NativeClient,
            cursor: &[u8],
        ) -> Result<wechat_protocol::GroupMetadataPage> {
            Peer.groups(c, cursor)
        }
        fn target(&self, c: &NativeClient, id: &str) -> Result<crate::store::TargetProjection> {
            Peer.target(c, id)
        }
    }
    let root = Root::new();
    let keys = Keys::default();
    let store = Arc::new(Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap());
    store.accept_login(0, account()).unwrap();
    let (tx, observe) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let mut service = AccountService::new(store).unwrap();
    service.control.lock().unwrap().online = true;
    service.directory_peer = Box::new(Blocked {
        entered: Mutex::new(Some(tx)),
        release: Mutex::new(wait),
    });
    let service = Arc::new(service);
    service
        .start_directory("racing-directory", 1, "synthetic-user")
        .unwrap();
    let worker = service.clone();
    let thread = std::thread::spawn(move || worker.advance_directory("racing-directory"));
    observe.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(matches!(
        service.advance_directory("racing-directory"),
        Err(ServiceError::Busy)
    ));
    service.disconnect().unwrap();
    assert_eq!(
        service
            .directory_operation("racing-directory")
            .unwrap()
            .phase,
        "interrupted"
    );
    release.send(()).unwrap();
    assert!(thread.join().unwrap().is_err());
    assert!(service.directory_page("racing-directory", 0).is_err());
}

#[test]
fn stalled_remote_catalog_becomes_a_durable_failure_without_restarting_the_same_intent() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Stalled(Arc<AtomicUsize>);
    impl DirectoryPeer for Stalled {
        fn catalog(
            &self,
            _: &NativeClient,
            _: u32,
            _: u32,
        ) -> Result<wechat_protocol::InitContactPage> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(wechat_protocol::InitContactPage {
                contact_sequence: 0,
                room_sequence: 0,
                more: true,
                usernames: vec![],
            })
        }
        fn groups(&self, _: &NativeClient, _: &[u8]) -> Result<wechat_protocol::GroupMetadataPage> {
            panic!("stalled catalog cannot advance")
        }
        fn target(&self, _: &NativeClient, _: &str) -> Result<crate::store::TargetProjection> {
            panic!("stalled catalog cannot verify")
        }
    }
    let root = Root::new();
    let keys = Keys::default();
    let store = Arc::new(Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap());
    store.accept_login(0, account()).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut service = AccountService::new(store).unwrap();
    service.control.lock().unwrap().online = true;
    service.directory_peer = Box::new(Stalled(calls.clone()));
    service
        .start_directory("stalled-remote", 1, "synthetic-user")
        .unwrap();
    assert_eq!(
        service.advance_directory("stalled-remote").unwrap().phase,
        "failed"
    );
    assert_eq!(
        service
            .start_directory("stalled-remote", 1, "synthetic-user")
            .unwrap()
            .phase,
        "failed"
    );
    service.advance_directory("stalled-remote").unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(service.directory_page("stalled-remote", 0).is_err());
}
