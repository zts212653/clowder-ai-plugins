use super::*;
use crate::{
    store::tests::{account, Keys, Root},
    vault::Vault,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc,
};
struct Peer {
    store: Arc<Store>,
    calls: Arc<AtomicUsize>,
    entered: Mutex<Option<mpsc::Sender<()>>>,
    release: Mutex<Option<mpsc::Receiver<()>>>,
}
impl ResumePeer for Peer {
    fn resume(&self, _: &NativeClient, ticket: &ResumeTicket) -> Result<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(tx) = self.entered.lock().unwrap().take() {
            tx.send(()).unwrap();
        }
        if let Some(rx) = self.release.lock().unwrap().take() {
            rx.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        let previous = self.store.account()?.unwrap();
        let mut next = previous.clone();
        next.session_key = vec![0x44; 16];
        self.store
            .resume_persistence(ticket)
            .persist(&previous, &next)
            .map_err(|_| ServiceError::Unavailable)
    }
}
fn setup(
    root: &Root,
    keys: &Keys,
    entered: Option<mpsc::Sender<()>>,
    release: Option<mpsc::Receiver<()>>,
) -> (Arc<AccountService>, Arc<AtomicUsize>) {
    let store = Arc::new(Store::initialize(Vault::create(&root.0, keys, b"").unwrap()).unwrap());
    store.accept_login(0, account()).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut service = AccountService::new(store.clone()).unwrap();
    service.resume_peer = Box::new(Peer {
        store,
        calls: calls.clone(),
        entered: Mutex::new(entered),
        release: Mutex::new(release),
    });
    (Arc::new(service), calls)
}
#[test]
fn explicit_resume_rpc_requires_durable_credential_acceptance_and_uses_the_accepted_owner() {
    let root = Root::new();
    let keys = Keys::default();
    let (service, calls) = setup(&root, &keys, None, None);
    assert!(!service.status().unwrap().authenticated);
    let frame=br#"{"id":1,"method":"session.resume","params":{"operationId":"resume-rpc","accountGeneration":1,"accountIdentity":"synthetic-user"}}"#;
    let done = crate::ipc::respond_with(frame, Some(&service));
    assert_eq!(
        done["result"]["phase"], "succeeded",
        "resume RPC must reach the account owner"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(service.status().unwrap().authenticated);
    assert_eq!(service.status().unwrap().account_generation, 2);
    assert_eq!(
        crate::ipc::respond_with(frame, Some(&service))["result"]["phase"],
        "succeeded"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    service
        .control
        .lock()
        .unwrap()
        .client
        .as_ref()
        .unwrap()
        .request_blocking(|request| {
            assert_eq!(request.account().session_key, vec![0x44; 16]);
            Ok(())
        })
        .unwrap();
    let wire = serde_json::to_string(&done).unwrap();
    assert!(!wire.contains("session_key"));
    assert!(!wire.contains(&serde_json::to_string(&vec![0x44; 16]).unwrap()));
}
#[test]
fn cancellation_does_not_wait_for_authentication_and_late_acceptance_cannot_reactivate() {
    let root = Root::new();
    let keys = Keys::default();
    let (tx, observe) = mpsc::channel();
    let (release, rx) = mpsc::channel();
    let (service, calls) = setup(&root, &keys, Some(tx), Some(rx));
    let worker = service.clone();
    let thread =
        std::thread::spawn(move || worker.resume_session("racing-resume", 1, "synthetic-user"));
    observe.recv_timeout(Duration::from_secs(2)).unwrap();
    let cancelled = service.cancel_resume("racing-resume").unwrap();
    assert_eq!(cancelled.phase, ResumePhase::Cancelled);
    release.send(()).unwrap();
    assert_eq!(
        thread.join().unwrap().unwrap().phase,
        ResumePhase::Cancelled
    );
    assert!(!service.status().unwrap().authenticated);
    assert!(service.status().unwrap().credentials_available);
    assert_eq!(
        service
            .resume_session("racing-resume", 1, "synthetic-user")
            .unwrap()
            .phase,
        ResumePhase::Cancelled
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn an_auth_adapter_returning_success_without_durable_acceptance_cannot_mark_online() {
    struct NoAcceptance;
    impl ResumePeer for NoAcceptance {
        fn resume(&self, _: &NativeClient, _: &ResumeTicket) -> Result<()> {
            Ok(())
        }
    }
    let root = Root::new();
    let keys = Keys::default();
    let (service, _) = setup(&root, &keys, None, None);
    let service = Arc::try_unwrap(service).ok().unwrap();
    let mut service = service;
    service.resume_peer = Box::new(NoAcceptance);
    assert_eq!(
        service
            .resume_session("missing-acceptance", 1, "synthetic-user")
            .unwrap()
            .phase,
        ResumePhase::Failed
    );
    assert!(!service.status().unwrap().authenticated);
}
#[test]
fn service_close_interrupts_pending_resume_and_the_late_callback_cannot_publish() {
    let root = Root::new();
    let keys = Keys::default();
    let (tx, observe) = mpsc::channel();
    let (release, rx) = mpsc::channel();
    let (service, _) = setup(&root, &keys, Some(tx), Some(rx));
    let worker = service.clone();
    let thread = std::thread::spawn(move || {
        worker.resume_session("interrupted-resume", 1, "synthetic-user")
    });
    observe.recv_timeout(Duration::from_secs(2)).unwrap();
    service.close();
    assert_eq!(
        service
            .resume_operation("interrupted-resume")
            .unwrap()
            .phase,
        ResumePhase::Interrupted
    );
    release.send(()).unwrap();
    assert_eq!(
        thread.join().unwrap().unwrap().phase,
        ResumePhase::Interrupted
    );
    assert!(!service.status().unwrap().authenticated);
}
#[test]
fn actual_stdio_accepts_session_cancel_while_resume_authentication_is_blocked() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    let root = Root::new();
    let keys = Keys::default();
    let (tx, observe) = mpsc::channel();
    let (release, rx) = mpsc::channel();
    let (service, _) = setup(&root, &keys, Some(tx), Some(rx));
    let (client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut input = client.try_clone().unwrap();
    let mut reader = BufReader::new(client);
    let writer = server.try_clone().unwrap();
    let worker = service.clone();
    let thread = std::thread::spawn(move || {
        crate::stdio::serve(&mut BufReader::new(server), writer, Some(worker))
    });
    writeln!(input,"{}",serde_json::json!({"id":1,"method":"session.resume","params":{"operationId":"stdio-resume","accountGeneration":1,"accountIdentity":"synthetic-user"}})).unwrap();
    observe.recv_timeout(Duration::from_secs(2)).unwrap();
    writeln!(input,"{}",serde_json::json!({"id":2,"method":"session.cancel","params":{"operationId":"stdio-resume"}})).unwrap();
    let read = |r: &mut BufReader<UnixStream>| {
        let mut line = String::new();
        r.read_line(&mut line)
            .expect("session cancel must remain responsive");
        serde_json::from_str::<serde_json::Value>(&line).unwrap()
    };
    let cancelled = read(&mut reader);
    assert_eq!(cancelled["id"], 2);
    assert_eq!(cancelled["result"]["phase"], "cancelled");
    release.send(()).unwrap();
    assert_eq!(read(&mut reader)["result"]["phase"], "cancelled");
    input.shutdown(std::net::Shutdown::Write).unwrap();
    thread.join().unwrap().unwrap();
}
