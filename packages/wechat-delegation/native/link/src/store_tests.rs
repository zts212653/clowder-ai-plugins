use super::*;
use crate::vault::{KeyStore, Result as VaultResult};
use std::{collections::HashMap, fs, os::unix::fs::PermissionsExt, path::PathBuf, sync::Mutex};
use zeroize::Zeroizing;
#[derive(Default)]
pub(crate) struct Keys(Mutex<HashMap<[u8; 16], Zeroizing<[u8; 32]>>>);
impl KeyStore for Keys {
    fn create(&self, id: &[u8; 16], key: &[u8; 32]) -> VaultResult<()> {
        self.0.lock().unwrap().insert(*id, Zeroizing::new(*key));
        Ok(())
    }
    fn load(&self, id: &[u8; 16]) -> VaultResult<Zeroizing<[u8; 32]>> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or(VaultError::KeyUnavailable)
    }
}
pub(crate) struct Root(pub(crate) PathBuf);
impl Root {
    pub(crate) fn new() -> Self {
        let mut id = [0; 16];
        openssl::rand::rand_bytes(&mut id).unwrap();
        let root = std::env::temp_dir().join(format!("clowder-store-synthetic-{:x?}", id));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
pub(crate) fn account() -> AccountState {
    serde_json::from_value(serde_json::json!({
        "schema":1,"device":{"device_id":vec![0x6c;16],"device_type":"MacBookPro","client_version":-227271398},
        "uin":123,"own_username":"synthetic-user","cookie":[],"session_key":vec![0x71;16],
        "request_key":[],"response_key":[],"auto_auth_key":b"SYNTHETIC_AUTO_AUTH_SECRET","key_info":[],
        "long_host":"long.weixin.qq.com","short_host":"short.weixin.qq.com"
    })).unwrap()
}
#[test]
fn account_renewal_is_durable_and_logout_fences_stale_writers_across_restart() {
    let root = Root::new();
    let keys = Keys::default();
    let vault = Vault::create(&root.0, &keys, b"").unwrap();
    let store = Arc::new(Store::initialize(vault).expect("account store must initialize"));
    let first = account();
    first.validate().unwrap();
    let generation = store
        .accept_login(store.generation().unwrap(), first.clone())
        .unwrap();
    let persistence = store.persistence(generation);
    let mut renewed = first.clone();
    renewed.session_key = vec![0x33; 16];
    persistence.persist(&first, &renewed).unwrap();
    assert!(persistence.persist(&first, &first).is_err());
    assert_eq!(
        store.account().unwrap().unwrap().session_key,
        renewed.session_key
    );
    drop(persistence);
    drop(store);
    let restored = Arc::new(Store::open(Vault::open(&root.0, &keys).unwrap()).unwrap());
    assert_eq!(restored.generation().unwrap(), generation);
    assert_eq!(
        restored.account().unwrap().unwrap().session_key,
        renewed.session_key
    );
    let obsolete = restored.persistence(generation);
    let next = restored.logout(generation).unwrap();
    assert!(next > generation);
    assert!(obsolete.persist(&renewed, &first).is_err());
    assert!(restored.accept_login(generation, first).is_err());
    assert!(restored.account().unwrap().is_none());
    drop(obsolete);
    drop(restored);
    assert!(Store::open(Vault::open(&root.0, &keys).unwrap())
        .unwrap()
        .account()
        .unwrap()
        .is_none());
    let bytes = fs::read(root.0.join("state.vault")).unwrap();
    assert!(!bytes.windows(9).any(|b| b == b"SYNTHETIC"));
}

#[test]
fn private_profile_material_and_invalid_renewal_cannot_replace_accepted_credentials() {
    let root = Root::new();
    let keys = Keys::default();
    let store = Arc::new(Store::initialize(Vault::create(&root.0, &keys, b"").unwrap()).unwrap());
    let first = account();
    let generation = store.accept_login(0, first.clone()).unwrap();
    let original = fs::read(root.0.join("state.vault")).unwrap();
    let mut invalid = first.clone();
    invalid.database_password = vec![0x7f; 32];
    assert!(store
        .persistence(generation)
        .persist(&first, &invalid)
        .is_err());
    assert!(store.accept_login(generation, invalid).is_err());
    let mut changed = first.clone();
    changed.own_username = "different-synthetic-account".into();
    assert!(store
        .persistence(generation)
        .persist(&first, &changed)
        .is_err());
    assert_eq!(fs::read(root.0.join("state.vault")).unwrap(), original);
    assert_eq!(store.generation().unwrap(), generation);
    let client = wechat_protocol::NativeClient::from_account_with_persistence(
        store.account().unwrap().unwrap(),
        wechat_protocol::NativeOptions::default(),
        store.persistence(generation),
    )
    .unwrap();
    assert_eq!(
        client.account_identity().unwrap().own_username,
        "synthetic-user"
    );
    client.stop().unwrap();
    drop(client);
    drop(store);
    let vault = Vault::open(&root.0, &keys).unwrap();
    assert!(Store::initialize(vault).is_err());
    assert_eq!(fs::read(root.0.join("state.vault")).unwrap(), original);
}
