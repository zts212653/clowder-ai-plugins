//! Account-owned asynchronous protocol operations.
use super::*;

impl NativeClient {
    /// Fetch one sync page using the owned account. The application still owns
    /// command retention, projection and committing the returned cursor.
    pub async fn sync(&self, cursor: &[u8]) -> Result<crate::SyncBatch> {
        let cursor = cursor.to_vec();
        self.account_request(move |transport, state, _| transport.sync_snapshot(state, &cursor))
            .await
    }

    pub async fn heartbeat(&self, cursor: &[u8]) -> Result<crate::Heartbeat> {
        let cursor = cursor.to_vec();
        self.account_request(move |transport, state, _| {
            transport.heartbeat_snapshot(state, &cursor)
        })
        .await
    }

    pub async fn sync_scene(&self, cursor: &[u8], scene: u32) -> Result<crate::SyncBatch> {
        let cursor = cursor.to_vec();
        self.account_request(move |transport, state, _| {
            transport.sync_scene_snapshot(state, &cursor, scene)
        })
        .await
    }

    pub async fn lookup_contacts(&self, usernames: &[String]) -> Result<crate::ContactLookup> {
        let usernames = usernames.to_vec();
        self.account_request(move |transport, state, _| {
            transport.lookup_contacts_snapshot(state, &usernames)
        })
        .await
    }

    pub async fn lookup_room(&self, room_id: &str, version: u32) -> Result<crate::RoomRoster> {
        let room_id = room_id.to_owned();
        self.account_request(move |transport, state, _| {
            transport.lookup_room_snapshot(state, &room_id, version)
        })
        .await
    }

    pub async fn init_contacts(
        &self,
        contact_sequence: u32,
        room_sequence: u32,
    ) -> Result<crate::InitContactPage> {
        self.account_request(move |transport, state, _| {
            transport.init_contacts_snapshot(state, contact_sequence, room_sequence)
        })
        .await
    }

    pub async fn group_inventory(&self, cursor: &[u8]) -> Result<crate::GroupMetadataPage> {
        let cursor = cursor.to_vec();
        self.account_request(move |transport, state, _| {
            transport.group_inventory_snapshot(state, &cursor)
        })
        .await
    }

    pub async fn lookup_contacts_raw(&self, usernames: &[String]) -> Result<Vec<u8>> {
        let usernames = usernames.to_vec();
        self.account_request(move |transport, state, _| {
            transport.lookup_contacts_raw_snapshot(state, &usernames)
        })
        .await
    }

    pub async fn lookup_contacts_receipt(
        &self,
        usernames: &[String],
    ) -> Result<crate::MetadataReply<crate::ContactLookup>> {
        let usernames = usernames.to_vec();
        self.account_request(move |transport, state, _| {
            transport.lookup_contacts_receipt_snapshot(state, &usernames)
        })
        .await
    }

    pub async fn lookup_room_receipt(
        &self,
        room_id: &str,
        version: u32,
    ) -> Result<crate::MetadataReply<crate::RoomRoster>> {
        let room_id = room_id.to_owned();
        self.account_request(move |transport, state, _| {
            transport.lookup_room_receipt_snapshot(state, &room_id, version)
        })
        .await
    }

    pub async fn lookup_room_raw(&self, room_id: &str, version: u32) -> Result<Vec<u8>> {
        let room_id = room_id.to_owned();
        self.account_request(move |transport, state, _| {
            transport.lookup_room_raw_snapshot(state, &room_id, version)
        })
        .await
    }

    pub async fn init_contacts_receipt(
        &self,
        contact_sequence: u32,
        room_sequence: u32,
    ) -> Result<crate::MetadataReply<crate::InitContactPage>> {
        self.account_request(move |transport, state, _| {
            transport.init_contacts_receipt_snapshot(state, contact_sequence, room_sequence)
        })
        .await
    }

    pub async fn group_detail_raw(&self, group_id: &str) -> Result<Vec<u8>> {
        let group_id = group_id.to_owned();
        self.account_request(move |transport, state, _| {
            transport.group_detail_raw_snapshot(state, &group_id)
        })
        .await
    }

    pub async fn contact_sync(
        &self,
        cursor: &[u8],
        message_cursor: &[u8],
        continuation: bool,
    ) -> Result<crate::contact_sync::ContactSyncBatch> {
        let cursor = cursor.to_vec();
        let message_cursor = message_cursor.to_vec();
        self.account_request(move |transport, state, _| {
            transport.contact_sync_snapshot(state, &cursor, &message_cursor, continuation)
        })
        .await
    }

    /// Explicitly renew this account once. Concurrent requests from the prior
    /// credential generation cannot submit or adopt responses after acceptance.
    /// There is no QR fallback and no retry after an uncertain auth outcome.
    pub async fn renew_session(&self, computer_name: &str) -> Result<()> {
        let (exchange, state) = self.owned_account()?.begin()?;
        let exchange = Arc::new(exchange);
        let computer_name = computer_name.to_owned();
        let options = self.options.clone();
        let cancellation = Arc::new(AtomicBool::new(false));
        let _cancel_on_drop = CancelOnDrop(cancellation.clone());
        tokio::task::spawn_blocking(move || {
            let mut transport = NativeClient::new(options)?;
            let submission_exchange = exchange.clone();
            transport.submission_guard = Some(Arc::new(move || {
                ensure!(
                    !cancellation.load(Ordering::Acquire),
                    "Account authentication cancelled before submission"
                );
                submission_exchange.check()
            }));
            let returned = transport.renew_session_snapshot(&state, &computer_name)?;
            exchange.accept_credentials(returned)
        })
        .await
        .context("Account authentication worker failed")?
    }

    /// Fence admission, drain prior requests, then submit logout at most once.
    /// The owner stays stopped after rejection, cancellation or uncertainty;
    /// this operation does not revoke remembered-device trust or delete profiles.
    pub async fn logout(&self) -> Result<crate::LogoutReply> {
        self.prepare_logout()?.submit().await
    }

    /// Submit one text message without automatic renewal or retry. Inspect both
    /// receipt correlation fields and acceptance before reporting success.
    pub async fn send_text(
        &self,
        destination: &str,
        content: &str,
        options: TextSendOptions,
    ) -> Result<crate::TextSendResult> {
        self.send_text_guarded(destination, content, options, || Ok(()))
            .await
    }

    pub async fn send_text_guarded<F>(
        &self,
        destination: &str,
        content: &str,
        options: TextSendOptions,
        before_submit: F,
    ) -> Result<crate::TextSendResult>
    where
        F: FnOnce() -> Result<()> + Send + 'static,
    {
        let destination = destination.to_owned();
        let content = content.to_owned();
        self.account_request(move |transport, state, _| {
            let request = crate::wire::text_send_request_with_source(
                &destination,
                &content,
                options.created_at,
                options.client_message_id,
                options.source.as_deref(),
            )?;
            let reply = transport.authenticated_rpc_guarded(
                state,
                522,
                "/cgi-bin/micromsg-bin/newsendmsg",
                &request,
                before_submit,
            )?;
            crate::wire::decode_text_send(&reply, &destination, options.client_message_id)
        })
        .await
    }
}

impl NativeClient {}

impl NativeClient {}
