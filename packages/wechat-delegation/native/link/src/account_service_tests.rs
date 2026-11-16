use super::*;
use crate::{
    store::tests::{account, Keys, Root},
    vault::Vault,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc,
};

struct FakePeer {
    starts: Arc<AtomicUsize>,
    release: Option<mpsc::Receiver<()>>,
    entered: Option<mpsc::Sender<()>>,
}
impl LoginPeer for FakePeer {
    fn start(&mut self, _: LoginGuard) -> std::result::Result<QrProjection, PeerError> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        Ok(QrProjection {
            png_base64: "iVBORw0KGgo=".into(),
            expires_at: 123,
        })
    }
    fn poll(&mut self, _: LoginGuard) -> std::result::Result<LoginStatus, PeerError> {
        Ok(LoginStatus::Approved)
    }
    fn complete(&mut self, _: LoginGuard) -> std::result::Result<AccountState, PeerError> {
        if let Some(entered) = self.entered.take() {
            entered.send(()).unwrap();
        }
        if let Some(release) = self.release.take() {
            release.recv_timeout(Duration::from_secs(10)).unwrap();
        }
        let mut account = account();
        account.session_key = b"SECRET_KEY_12345".to_vec();
        account.auto_auth_key = b"SENTINEL_AUTO_AUTH_SECRET".to_vec();
        Ok(account)
    }
    fn clear(&mut self) {}
}
fn setup(root: &Root, keys: &Keys, peer: FakePeer) -> Arc<AccountService> {
    let store = Arc::new(Store::initialize(Vault::create(&root.0, keys, b"").unwrap()).unwrap());
    Arc::new(AccountService::with_peer(store, Box::new(peer)).unwrap())
}
#[test]
fn completed_login_is_idempotent_persistent_and_projects_no_account_secrets() {
    let root = Root::new();
    let keys = Keys::default();
    let starts = Arc::new(AtomicUsize::new(0));
    let service = setup(
        &root,
        &keys,
        FakePeer {
            starts: starts.clone(),
            release: None,
            entered: None,
        },
    );
    let started = service
        .start_login("synthetic-login")
        .expect("login start must use the account service");
    assert_eq!(started.operation.phase, LoginPhase::Pending);
    assert!(started.qr.is_some());
    service.start_login("synthetic-login").unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    let done = service.poll_login("synthetic-login").unwrap();
    assert_eq!(done.operation.phase, LoginPhase::Succeeded);
    assert!(done.qr.is_none());
    let status = service.status().unwrap();
    assert!(status.authenticated);
    let text = serde_json::to_string(&(&done, &status)).unwrap();
    assert!(!text.contains("SENTINEL"));
    assert!(!text.contains("SECRET_KEY"));
    assert!(!text.contains(&serde_json::to_string(&b"SECRET_KEY_12345".to_vec()).unwrap()));
    drop(service);
    let restored = AccountService::new(Arc::new(
        Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap(),
    ))
    .unwrap();
    assert_eq!(
        restored
            .login_operation("synthetic-login")
            .unwrap()
            .operation
            .phase,
        LoginPhase::Succeeded
    );
    assert!(restored.status().unwrap().credentials_available);
    assert!(!restored.status().unwrap().authenticated);
}
#[test]
fn cancel_and_disconnect_do_not_wait_for_network_and_late_authentication_cannot_reactivate() {
    for disconnect in [false, true] {
        let root = Root::new();
        let keys = Keys::default();
        let (tx, rx) = mpsc::channel();
        let (entered_tx, entered_rx) = mpsc::channel();
        let service = setup(
            &root,
            &keys,
            FakePeer {
                starts: Arc::new(AtomicUsize::new(0)),
                release: Some(rx),
                entered: Some(entered_tx),
            },
        );
        service.start_login("racing-login").unwrap();
        let worker = service.clone();
        let thread = std::thread::spawn(move || worker.poll_login("racing-login"));
        entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        if disconnect {
            service.disconnect().unwrap();
        } else {
            service.cancel_login("racing-login").unwrap();
        }
        assert_eq!(
            service
                .login_operation("racing-login")
                .unwrap()
                .operation
                .phase,
            LoginPhase::Cancelled
        );
        assert!(
            service
                .login_operation("racing-login")
                .unwrap()
                .operation
                .authentication_may_have_occurred
        );
        tx.send(()).unwrap();
        let result = thread.join().unwrap().unwrap();
        assert_eq!(result.operation.phase, LoginPhase::Cancelled);
        assert!(!service.status().unwrap().credentials_available);
        assert!(!service.status().unwrap().authenticated);
    }
}

#[test]
fn actual_rpc_projection_rejects_duplicate_params_and_secret_imports_without_echoing_secrets() {
    let root = Root::new();
    let keys = Keys::default();
    let starts = Arc::new(AtomicUsize::new(0));
    let service = setup(
        &root,
        &keys,
        FakePeer {
            starts: starts.clone(),
            release: None,
            entered: None,
        },
    );
    let call = |body: &[u8]| crate::ipc::respond_with(body, Some(&service));
    let started = call(br#"{"id":1,"method":"login.start","params":{"operationId":"rpc-login"}}"#);
    assert_eq!(
        started["result"]["operation"]["phase"], "pending",
        "RPC must dispatch to the real account service"
    );
    for frame in [
        br#"{"id":2,"method":"login.start","params":{"operationId":"a","operationId":"b"}}"#.as_slice(),
        br#"{"id":3,"method":"login.start","params":{"operationId":"c","password":"SENTINEL_IMPORT"}}"#.as_slice(),
        br#"{"id":4,"method":"account.import","params":{"sessionKey":"SENTINEL_IMPORT"}}"#.as_slice(),
    ]{
        let reply=call(frame);assert!(reply.get("error").is_some());assert!(!reply.to_string().contains("SENTINEL"));
    }
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    let competing =
        call(br#"{"id":7,"method":"login.start","params":{"operationId":"other-login"}}"#);
    assert_eq!(
        competing["error"]["code"], "operation_busy",
        "an active login must not be described as broken storage"
    );
    let done = call(br#"{"id":5,"method":"login.poll","params":{"operationId":"rpc-login"}}"#);
    assert_eq!(done["result"]["operation"]["phase"], "succeeded");
    let status = call(br#"{"id":6,"method":"status"}"#);
    assert_eq!(status["result"]["authenticated"], true);
    let mut wire = Vec::new();
    crate::ipc::write_response(&mut wire, &done).unwrap();
    crate::ipc::write_response(&mut wire, &status).unwrap();
    for secret in [
        b"SECRET_KEY_12345".as_slice(),
        b"SENTINEL_AUTO_AUTH_SECRET".as_slice(),
    ] {
        use base64::Engine;
        for encoded in [
            secret.to_vec(),
            serde_json::to_vec(&secret).unwrap(),
            base64::engine::general_purpose::STANDARD
                .encode(secret)
                .into_bytes(),
            secret
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
                .into_bytes(),
        ] {
            assert!(!wire.windows(encoded.len()).any(|part| part == encoded));
        }
    }
}

#[test]
fn real_stdio_loop_accepts_cancel_while_manual_authentication_is_in_flight() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    let root = Root::new();
    let keys = Keys::default();
    let (tx, rx) = mpsc::channel();
    let (entered_tx, entered_rx) = mpsc::channel();
    let service = setup(
        &root,
        &keys,
        FakePeer {
            starts: Arc::new(AtomicUsize::new(0)),
            release: Some(rx),
            entered: Some(entered_tx),
        },
    );
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
    let read = |reader: &mut BufReader<UnixStream>| {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .expect("stdio must remain responsive");
        serde_json::from_str::<serde_json::Value>(&line).unwrap()
    };
    input
        .write_all(
            b"{\"id\":1,\"method\":\"login.start\",\"params\":{\"operationId\":\"stdio-login\"}}\n",
        )
        .unwrap();
    assert_eq!(
        read(&mut replies)["result"]["operation"]["phase"],
        "pending"
    );
    input
        .write_all(
            b"{\"id\":2,\"method\":\"login.poll\",\"params\":{\"operationId\":\"stdio-login\"}}\n",
        )
        .unwrap();
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    input.write_all(b"{\"id\":3,\"method\":\"login.cancel\",\"params\":{\"operationId\":\"stdio-login\"}}\n").unwrap();
    let cancelled = read(&mut replies);
    assert_eq!(cancelled["id"], 3);
    assert_eq!(cancelled["result"]["operation"]["phase"], "cancelled");
    tx.send(()).unwrap();
    let late = read(&mut replies);
    assert_eq!(late["id"], 2);
    assert_eq!(late["result"]["operation"]["phase"], "cancelled");
    assert!(!service.status().unwrap().credentials_available);
    input.shutdown(std::net::Shutdown::Write).unwrap();
    thread.join().unwrap().unwrap();
}

#[test]
fn closing_stdio_interrupts_pending_authentication_without_losing_its_receipt() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    let root = Root::new();
    let keys = Keys::default();
    let (tx, rx) = mpsc::channel();
    let (entered_tx, entered_rx) = mpsc::channel();
    let service = setup(
        &root,
        &keys,
        FakePeer {
            starts: Arc::new(AtomicUsize::new(0)),
            release: Some(rx),
            entered: Some(entered_tx),
        },
    );
    let (client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut input = client.try_clone().unwrap();
    let mut output = BufReader::new(client);
    let response = server.try_clone().unwrap();
    let worker = service.clone();
    let thread = std::thread::spawn(move || {
        crate::stdio::serve(&mut BufReader::new(server), response, Some(worker))
    });
    input.write_all(b"{\"id\":1,\"method\":\"login.start\",\"params\":{\"operationId\":\"interrupted-login\"}}\n").unwrap();
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    input.write_all(b"{\"id\":2,\"method\":\"login.poll\",\"params\":{\"operationId\":\"interrupted-login\"}}\n").unwrap();
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    input.shutdown(std::net::Shutdown::Write).unwrap();
    thread.join().unwrap().unwrap();
    assert_eq!(
        service
            .login_operation("interrupted-login")
            .unwrap()
            .operation
            .phase,
        LoginPhase::Interrupted
    );
    tx.send(()).unwrap();
    line.clear();
    output.read_line(&mut line).unwrap();
    let late: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(late["result"]["operation"]["phase"], "interrupted");
    assert!(!service.status().unwrap().credentials_available);
}

#[test]
fn only_qr_poll_is_repeatable_and_an_uncertain_authentication_is_never_replayed() {
    struct FailurePeer {
        polls: usize,
        completes: Arc<AtomicUsize>,
    }
    impl LoginPeer for FailurePeer {
        fn start(&mut self, _: LoginGuard) -> std::result::Result<QrProjection, PeerError> {
            Ok(QrProjection {
                png_base64: "iVBORw0KGgo=".into(),
                expires_at: 123,
            })
        }
        fn poll(&mut self, _: LoginGuard) -> std::result::Result<LoginStatus, PeerError> {
            self.polls += 1;
            if self.polls == 1 {
                Err(PeerError::Retryable)
            } else {
                Ok(LoginStatus::Approved)
            }
        }
        fn complete(&mut self, _: LoginGuard) -> std::result::Result<AccountState, PeerError> {
            self.completes.fetch_add(1, Ordering::SeqCst);
            Err(PeerError::Unavailable)
        }
        fn clear(&mut self) {}
    }
    let root = Root::new();
    let keys = Keys::default();
    let completes = Arc::new(AtomicUsize::new(0));
    let store = Arc::new(Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap());
    let service = AccountService::with_peer(
        store,
        Box::new(FailurePeer {
            polls: 0,
            completes: completes.clone(),
        }),
    )
    .unwrap();
    service.start_login("uncertain-login").unwrap();
    assert_eq!(
        service
            .poll_login("uncertain-login")
            .unwrap()
            .operation
            .phase,
        LoginPhase::Pending
    );
    let uncertain = service.poll_login("uncertain-login").unwrap();
    assert_eq!(uncertain.operation.phase, LoginPhase::Failed);
    assert!(uncertain.operation.authentication_may_have_occurred);
    assert_eq!(
        service
            .poll_login("uncertain-login")
            .unwrap()
            .operation
            .phase,
        LoginPhase::Failed
    );
    assert_eq!(
        service
            .start_login("uncertain-login")
            .unwrap()
            .operation
            .phase,
        LoginPhase::Failed
    );
    assert_eq!(completes.load(Ordering::SeqCst), 1);
    assert!(!service.status().unwrap().credentials_available);
}
