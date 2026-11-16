//! Test-only process bridge for the actual Host consumer. No production CLI
//! flags, Keychain backend, remote sockets or alternate account APIs are added.
use super::*;
use crate::{
    store::tests::{account, Keys, Root},
    vault::Vault,
};
use std::{
    collections::{BTreeSet, VecDeque},
    fs::File,
    io::BufReader,
    os::fd::FromRawFd,
};
use wechat_protocol::{protobuf as p, SyncBatch, SyncCommand, TextSendOptions, TextSendResult};

#[derive(Default)]
struct Remote {
    next: u64,
    pending: VecDeque<SyncCommand>,
    replied: BTreeSet<String>,
    sent: Vec<(String, bool)>,
}
fn text(id: u64, from: &str, to: &str, content: &str) -> SyncCommand {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
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
            p::uint(9, now),
            p::uint(12, id),
        ])
        .unwrap(),
    }
}
struct Text(Arc<Mutex<Remote>>);
impl TextPeer for Text {
    fn verify(&self, _: &NativeClient, destination: &str) -> Result<()> {
        if matches!(destination, "friend" | "room@chatroom") {
            Ok(())
        } else {
            Err(ServiceError::PermissionDenied)
        }
    }
    fn send(
        &self,
        _: &NativeClient,
        destination: &str,
        body: &str,
        _: TextSendOptions,
        before: &mut dyn FnMut() -> anyhow::Result<()>,
    ) -> anyhow::Result<TextSendResult> {
        before()?;
        let mut remote = self.0.lock().unwrap();
        let unknown = destination == "room@chatroom";
        remote.sent.push((destination.into(), unknown));
        if unknown {
            anyhow::bail!("PRIVATE_TRANSPORT_CANARY");
        }
        remote.next += 1;
        let server = remote.next;
        remote
            .pending
            .push_back(text(server, "synthetic-user", destination, body));
        if remote.replied.insert(destination.into()) {
            remote.next += 1;
            let id = remote.next;
            remote
                .pending
                .push_back(text(id, destination, "synthetic-user", "一起读书吧"));
        }
        Ok(TextSendResult {
            accepted: true,
            outer_code: 0,
            item_code: Some(0),
            server_message_id: Some(server.to_string()),
            returned_destination_matches: true,
            returned_client_id_matches: true,
        })
    }
}
struct Sync(Arc<Mutex<Remote>>);
impl SyncPeer for Sync {
    fn pull(&self, _: &NativeClient, _: &[u8]) -> anyhow::Result<SyncBatch> {
        Ok(SyncBatch {
            code: 0,
            flags: 0,
            cursor: vec![],
            commands: self.0.lock().unwrap().pending.drain(..).collect(),
            continuation: false,
        })
    }
}
struct Directory;
impl DirectoryPeer for Directory {
    fn catalog(
        &self,
        _: &NativeClient,
        _: u32,
        _: u32,
    ) -> Result<wechat_protocol::InitContactPage> {
        Ok(wechat_protocol::InitContactPage {
            contact_sequence: 1,
            room_sequence: 1,
            more: false,
            usernames: vec!["friend".into(), "room@chatroom".into()],
        })
    }
    fn groups(&self, _: &NativeClient, _: &[u8]) -> Result<wechat_protocol::GroupMetadataPage> {
        // Exercise honest incomplete-group discovery, not a fake complete list.
        Err(ServiceError::Unavailable)
    }
    fn target(&self, _: &NativeClient, id: &str) -> Result<crate::store::TargetProjection> {
        Ok(crate::store::TargetProjection {
            id: id.into(),
            kind: if id.ends_with("@chatroom") {
                "group"
            } else {
                "direct"
            }
            .into(),
            display_name: format!("synthetic {id}"),
            nickname: None,
            remark: None,
            alias: None,
        })
    }
}

#[test]
#[ignore = "Node journey explicitly starts this test process with private FD 3/4"]
fn serve_host_journey() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Arc::new(Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap());
    let mut accepted = account();
    accepted.auto_auth_key = b"PRIVATE_ACCOUNT_CANARY".to_vec();
    store.accept_login(0, accepted).unwrap();
    let remote = Arc::new(Mutex::new(Remote::default()));
    remote.lock().unwrap().pending.push_back(SyncCommand {
        id: 999,
        payload: b"PRIVATE_SYNC_CANARY".to_vec(),
    });
    let mut service = AccountService::new(store.clone()).unwrap();
    service.control.lock().unwrap().online = true;
    service.text_peer = Box::new(Text(remote.clone()));
    service.sync_peer = Box::new(Sync(remote.clone()));
    service.directory_peer = Box::new(Directory);
    // libtest owns stdout; the real protocol uses separate inherited pipes.
    let input = unsafe { File::from_raw_fd(3) };
    let output = unsafe { File::from_raw_fd(4) };
    crate::stdio::serve(&mut BufReader::new(input), output, Some(Arc::new(service))).unwrap();
    let before = store.stream().unwrap();
    let sent = remote.lock().unwrap();
    assert!(sent.sent.len() >= 4);
    assert_eq!(sent.sent.iter().filter(|(_, unknown)| *unknown).count(), 1);
    drop(sent);
    for secret in [b"PRIVATE_ACCOUNT_CANARY".as_slice(), b"PRIVATE_SYNC_CANARY"] {
        assert!(!std::fs::read(root.0.join("state.vault"))
            .unwrap()
            .windows(secret.len())
            .any(|part| part == secret));
    }
    drop(store);
    let reopened = Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(reopened.stream().unwrap()).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    assert!(reopened.account().unwrap().is_some());
    // Store::open also runs the same paused-grant / uncertain-outbox recovery
    // used by production; Node verifies each durable send before EOF.
}
