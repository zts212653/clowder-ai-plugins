# Clowder current-directory repair build

This is a modified Agent WeChat v2.4.1 build, API version `2.4.1-clowder.1`, for macOS Apple Silicon. The upstream tag resolves to `thisnick/agent-wechat@ed976d78c1e1cc2a49ad17d1e2c0da023bbb5c8e`. Exact executable, compressed-bundle and patch SHA-256 values are in `manifest.json`. The plugin checks both compressed and expanded bytes, then requires the `current-contact-directory` capability and matching process identity. It has no older-binary fallback.

`current-directory.patch` applies at the upstream repository root. It adds an opt-in `POST /v1/accounts/{account}/contact-sync?directory=true` operation; the original metadata synchronization remains available without that query. The operation starts initcontact at `(0,0)` every time, consumes all pages, then obtains new getcontact records. A direct recipient requires a fresh full flag replacement with bit 0 set; retained cached flags never establish that relationship. Only server-inventory members can be selected. Cached profile rows supply labels and classifications, not additional recipient identities. The current account, service/system identities, foreign namespaces, known departed groups and rejected/unverified details are excluded. Incomplete inventory, stalled cursors, cancellation or deadline failure publishes no selectable snapshot. Individual unverifiable details are counted and excluded.

The operation returns `result.directory` with `version=1`, `source=wechat.initcontact`, `accountId`, `accountIdentity`, `catalogComplete`, `unverifiedCount`, `observedAt` and `items`. The plugin asynchronously polls the operation, binds snapshots/cursors to the account and operation, checks current account identity before returning cached pages, and refreshes after five minutes or an explicit owner refresh. This is a bounded observation, not a guarantee that a relationship cannot change immediately afterwards. Only explicitly authorized conversations can reach the model/send path.

Rebuild in an isolated checkout, without user profile data:

```sh
git clone https://github.com/thisnick/agent-wechat.git agent-wechat-directory
cd agent-wechat-directory
git checkout --detach ed976d78c1e1cc2a49ad17d1e2c0da023bbb5c8e
git apply /absolute/path/to/current-directory.patch
cd packages/native-client-rust
cargo +1.93.1 test --locked -p wechat-core --lib contact_directory
cargo +1.93.1 test --locked -p wechat-core --lib runtime::metadata
cargo +1.93.1 test --locked -p wechat-api --lib
cargo +1.93.1 build --locked --release -p wx-native --bin wx
```

The included build used Rust 1.93.1 and CMake 3.31.6 on Darwin ARM64 with the checked-in Cargo.lock. Compiler, SDK and build paths can affect executable bytes; source reproducibility does not promise byte-for-byte reproducibility across toolchains. Replacing a bundle requires updating its digests and rerunning supervision, packed-consumer and browser verification. Linux artifacts are not included in this repair candidate.

`LICENSE-Agent-WeChat`, `THIRD_PARTY_NOTICES.txt` and `licenses/` retain upstream notices. This directory contains code/runtime artifacts under those licenses; it is not part of the repository's character-artwork license.
