use super::*;
use crate::{
    store::tests::{account, Keys, Root},
    vault::Vault,
};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
struct Peer {
    uploads: Arc<AtomicUsize>,
    polls: Arc<AtomicUsize>,
    allowed: Arc<AtomicBool>,
    entered: Option<mpsc::Sender<()>>,
    release: Option<mpsc::Receiver<()>>,
}
impl LoginPeer for Peer {
    fn start(&mut self, _: LoginGuard) -> std::result::Result<QrProjection, PeerError> {
        Ok(QrProjection {
            png_base64: "iVBORw0KGgo=".into(),
            expires_at: 123,
        })
    }
    fn poll(&mut self, _: LoginGuard) -> std::result::Result<LoginStatus, PeerError> {
        self.polls.fetch_add(1, Ordering::SeqCst);
        if self.allowed.load(Ordering::SeqCst) {
            Ok(LoginStatus::Approved)
        } else {
            Err(PeerError::LanRequired)
        }
    }
    fn allow_lan(&mut self, guard: LoginGuard) -> std::result::Result<(), PeerError> {
        self.uploads.fetch_add(1, Ordering::SeqCst);
        if let Some(entered) = self.entered.take() {
            entered.send(()).unwrap();
        }
        if let Some(release) = self.release.take() {
            release.recv_timeout(Duration::from_secs(10)).unwrap();
        }
        if guard.interrupted() {
            return Err(PeerError::Unavailable);
        }
        self.allowed.store(true, Ordering::SeqCst);
        Ok(())
    }
    fn complete(&mut self, _: LoginGuard) -> std::result::Result<AccountState, PeerError> {
        Ok(account())
    }
    fn clear(&mut self) {}
}
fn peer() -> Peer {
    Peer {
        uploads: Arc::new(AtomicUsize::new(0)),
        polls: Arc::new(AtomicUsize::new(0)),
        allowed: Arc::new(AtomicBool::new(false)),
        entered: None,
        release: None,
    }
}
fn setup(root: &Root, keys: &Keys, peer: Peer) -> Arc<AccountService> {
    let store = Arc::new(Store::initialize(Vault::create(&root.0, keys, b"").unwrap()).unwrap());
    Arc::new(AccountService::with_peer(store, Box::new(peer)).unwrap())
}
#[test]
fn lan_challenge_waits_for_one_explicit_rpc_and_still_requires_normal_server_approval() {
    let root = Root::new();
    let keys = Keys::default();
    let peer = peer();
    let uploads = peer.uploads.clone();
    let polls = peer.polls.clone();
    let service = setup(&root, &keys, peer);
    service
        .start_login("lan-rpc", &service.admission().unwrap())
        .unwrap();
    assert!(service
        .allow_login_lan("lan-rpc", &service.admission().unwrap())
        .is_err());
    assert_eq!(
        service.poll_login("lan-rpc").unwrap().operation.phase,
        LoginPhase::LanAwaitingConsent
    );
    service.poll_login("lan-rpc").unwrap();
    assert_eq!(polls.load(Ordering::SeqCst), 1);
    assert_eq!(uploads.load(Ordering::SeqCst), 0);
    let reply = crate::ipc::respond_with(
        br#"{"id":1,"method":"login.allow_lan","params":{"operationId":"lan-rpc"}}"#,
        Some(&service),
    );
    assert_eq!(reply["result"]["operation"]["phase"], "lan_verifying");
    assert_eq!(uploads.load(Ordering::SeqCst), 1);
    assert!(!service.status().unwrap().authenticated);
    let again = service
        .allow_login_lan("lan-rpc", &service.admission().unwrap())
        .unwrap();
    assert!(again.operation.lan_approval_requested);
    assert_eq!(uploads.load(Ordering::SeqCst), 1);
    let invalid=crate::ipc::respond_with(br#"{"id":2,"method":"login.allow_lan","params":{"operationId":"lan-rpc","token":"SENTINEL_FORBIDDEN"}}"#,Some(&service));
    assert_eq!(invalid["error"]["code"], "invalid_params");
    assert!(!invalid.to_string().contains("SENTINEL"));
    assert_eq!(
        service.poll_login("lan-rpc").unwrap().operation.phase,
        LoginPhase::Succeeded
    );
}
#[test]
fn cancelled_reader_admission_cannot_start_a_lan_upload() {
    let root = Root::new();
    let keys = Keys::default();
    let peer = peer();
    let uploads = peer.uploads.clone();
    let service = setup(&root, &keys, peer);
    service
        .start_login("lan-cancel", &service.admission().unwrap())
        .unwrap();
    service.poll_login("lan-cancel").unwrap();
    let queued = service.admission().unwrap();
    service.cancel_login("lan-cancel").unwrap();
    assert!(service.allow_login_lan("lan-cancel", &queued).is_err());
    assert_eq!(uploads.load(Ordering::SeqCst), 0);
    assert!(
        !service
            .login_operation("lan-cancel")
            .unwrap()
            .operation
            .lan_approval_requested
    );
}
#[test]
fn cancellation_during_upload_is_immediate_and_late_upload_does_not_authenticate_or_replay() {
    let root = Root::new();
    let keys = Keys::default();
    let mut peer = peer();
    let uploads = peer.uploads.clone();
    let (enter, entered) = mpsc::channel();
    let (release, released) = mpsc::channel();
    peer.entered = Some(enter);
    peer.release = Some(released);
    let service = setup(&root, &keys, peer);
    service
        .start_login("lan-blocked", &service.admission().unwrap())
        .unwrap();
    service.poll_login("lan-blocked").unwrap();
    let child = service.clone();
    let admission = service.admission().unwrap();
    let worker = std::thread::spawn(move || child.allow_login_lan("lan-blocked", &admission));
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(
        service
            .allow_login_lan("lan-blocked", &service.admission().unwrap())
            .unwrap()
            .operation
            .phase,
        LoginPhase::LanVerifying
    );
    assert_eq!(
        service.cancel_login("lan-blocked").unwrap().operation.phase,
        LoginPhase::Cancelled
    );
    release.send(()).unwrap();
    assert_eq!(
        worker.join().unwrap().unwrap().operation.phase,
        LoginPhase::Cancelled
    );
    assert_eq!(uploads.load(Ordering::SeqCst), 1);
    assert!(!service.status().unwrap().authenticated);
    assert!(
        !service
            .login_operation("lan-blocked")
            .unwrap()
            .operation
            .authentication_may_have_occurred
    );
}

#[test]
fn real_stdio_reader_cancels_a_blocked_lan_upload_without_waiting_for_its_reply() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    let root = Root::new();
    let keys = Keys::default();
    let mut peer = peer();
    let uploads = peer.uploads.clone();
    let (enter, entered) = mpsc::channel();
    let (release, released) = mpsc::channel();
    peer.entered = Some(enter);
    peer.release = Some(released);
    let service = setup(&root, &keys, peer);
    service
        .start_login("stdio-lan", &service.admission().unwrap())
        .unwrap();
    service.poll_login("stdio-lan").unwrap();
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
            .expect("LAN upload must not block the reader");
        serde_json::from_str::<serde_json::Value>(&line).unwrap()
    };
    input.write_all(b"{\"id\":1,\"method\":\"login.allow_lan\",\"params\":{\"operationId\":\"stdio-lan\"}}\n").unwrap();
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    input
        .write_all(
            b"{\"id\":2,\"method\":\"login.cancel\",\"params\":{\"operationId\":\"stdio-lan\"}}\n",
        )
        .unwrap();
    let cancelled = read(&mut replies);
    assert_eq!(cancelled["id"], 2);
    assert_eq!(cancelled["result"]["operation"]["phase"], "cancelled");
    release.send(()).unwrap();
    let late = read(&mut replies);
    assert_eq!(late["id"], 1);
    assert_eq!(late["result"]["operation"]["phase"], "cancelled");
    assert_eq!(uploads.load(Ordering::SeqCst), 1);
    assert!(!service.status().unwrap().credentials_available);
    assert!(!format!("{cancelled}{late}").contains("SENTINEL"));
    input.shutdown(std::net::Shutdown::Write).unwrap();
    thread.join().unwrap().unwrap();
}
