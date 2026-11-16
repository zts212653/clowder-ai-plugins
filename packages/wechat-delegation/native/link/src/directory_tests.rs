use super::*;
use crate::{
    store::tests::{account, Keys, Root},
    vault::Vault,
};
#[test]
fn directory_refresh_preserves_receipts_and_only_a_current_complete_snapshot_is_readable() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    let started = store
        .begin_directory("refresh-1", 1, "synthetic-user")
        .expect("directory intent must persist");
    assert_eq!(started.phase, "catalog");
    let mut first = store.directory_ticket("refresh-1").unwrap();
    let catalog = wechat_protocol::InitContactPage {
        contact_sequence: 1,
        room_sequence: 1,
        more: false,
        usernames: vec!["friend".into(), "room@chatroom".into()],
    };
    store
        .advance_directory(&mut first, DirectoryChange::Catalog(catalog))
        .unwrap();
    store
        .advance_directory(&mut first, DirectoryChange::GroupUnavailable)
        .unwrap();
    for id in ["friend", "room@chatroom"] {
        store
            .advance_directory(
                &mut first,
                DirectoryChange::Target(
                    Some(TargetProjection {
                        id: id.into(),
                        kind: if id.ends_with("@chatroom") {
                            "group".into()
                        } else {
                            "direct".into()
                        },
                        display_name: format!("label {id}"),
                        nickname: None,
                        remark: None,
                        alias: None,
                    }),
                    false,
                ),
            )
            .unwrap();
    }
    let mut stale = first.clone();
    store
        .advance_directory(&mut first, DirectoryChange::Finish)
        .unwrap();
    assert!(store
        .advance_directory(&mut stale, DirectoryChange::Failed)
        .is_err());
    let page = store.directory_page("refresh-1", 0).unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(page.directory.catalog_complete);
    assert!(page.directory.group_discovery_incomplete);
    drop(store);
    let restored = Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap();
    assert_eq!(
        restored.directory_page("refresh-1", 0).unwrap().items.len(),
        2
    );
    restored
        .begin_directory("refresh-2", 1, "synthetic-user")
        .unwrap();
    assert!(
        !restored
            .directory_operation("refresh-1")
            .unwrap()
            .snapshot_available
    );
    assert!(restored.directory_page("refresh-1", 0).is_err());
    assert_eq!(
        restored
            .begin_directory("refresh-1", 1, "synthetic-user")
            .unwrap()
            .phase,
        "ready"
    );
    drop(restored);
    let reopened = Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap();
    assert_eq!(
        reopened.directory_operation("refresh-2").unwrap().phase,
        "interrupted"
    );
}
#[test]
fn stalled_catalog_and_late_account_changes_cannot_publish_a_directory() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    store
        .begin_directory("stalled", 1, "synthetic-user")
        .unwrap();
    let mut ticket = store.directory_ticket("stalled").unwrap();
    assert!(store
        .advance_directory(
            &mut ticket,
            DirectoryChange::Catalog(wechat_protocol::InitContactPage {
                contact_sequence: 0,
                room_sequence: 0,
                more: true,
                usernames: vec![]
            })
        )
        .is_err());
    assert!(store.directory_page("stalled", 0).is_err());
    store.logout(1).unwrap();
    assert!(store
        .advance_directory(&mut ticket, DirectoryChange::Finish)
        .is_err());
}
#[test]
fn metadata_progress_does_not_rewrite_the_full_account_vault_before_publication() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    store
        .begin_directory("read-only-progress", 1, "synthetic-user")
        .unwrap();
    let mut ticket = store.directory_ticket("read-only-progress").unwrap();
    let before = std::fs::read(root.0.join("state.vault")).unwrap();
    store
        .advance_directory(
            &mut ticket,
            DirectoryChange::Catalog(wechat_protocol::InitContactPage {
                contact_sequence: 1,
                room_sequence: 1,
                more: false,
                usernames: vec!["friend".into()],
            }),
        )
        .unwrap();
    assert!(
        std::fs::read(root.0.join("state.vault")).unwrap() == before,
        "intermediate directory reads must not rewrite the full vault"
    );
}

#[test]
fn group_catalog_wait_is_returned_as_progress_without_sending_another_request() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap();
    store.accept_login(0, account()).unwrap();
    store
        .begin_directory("waiting", 1, "synthetic-user")
        .unwrap();
    let mut ticket = store.directory_ticket("waiting").unwrap();
    store
        .advance_directory(
            &mut ticket,
            DirectoryChange::Catalog(wechat_protocol::InitContactPage {
                contact_sequence: 1,
                room_sequence: 1,
                more: false,
                usernames: vec![],
            }),
        )
        .unwrap();
    let status = store
        .advance_directory(
            &mut ticket,
            DirectoryChange::Groups(wechat_protocol::GroupMetadataPage {
                contacts: vec![],
                next_cursor: Some(vec![1]),
                more: true,
                wait_seconds: 100,
                raw: b"SENTINEL_RAW_METADATA".to_vec(),
            }),
        )
        .unwrap();
    assert!(status.retry_after_ms > 0);
    assert!(matches!(ticket.step().unwrap(), DirectoryStep::Terminal));
    assert!(!serde_json::to_string(&status).unwrap().contains("SENTINEL"));
}
