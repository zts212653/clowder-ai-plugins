# Configuration-variant acceptance procedure

This is a reproducible procedure, not a record of a particular running instance. Use an isolated Host profile and test data. Replace `<plugins-checkout>` with an absolute checkout path on the test machine; choose ports and data directories through that Host's documented isolation settings.

## Prepare and install

1. Check out the plugin candidate being reviewed and a Host revision supporting contract 0.2.0 configuration variants. See [plugins PR #101](https://github.com/zts212653/clowder-ai-plugins/pull/101) and [Host PR #1660](https://github.com/zts212653/clowder-ai/pull/1660) for integration status.
2. In the plugin repository root, use the toolchain in [CONTRIBUTING.md](../CONTRIBUTING.md), install the lockfile, and build the local dependency chain:

   ```sh
   pnpm install --frozen-lockfile
   pnpm --filter @clowder-ai/plugin-contract build
   pnpm --filter @clowder-ai/plugin-sdk build
   pnpm --filter @clowder-ai/connector-feishu build
   pnpm --filter @clowder-ai/video-generation build
   ```

3. Install the Host dependencies using its supported development configuration, then build and start the isolated Host. Verify its actual contract dependency matches the candidate before testing; a new source checkout alone does not update a running process.
4. In plugin management, choose local-directory installation and supply each path:
   - `<plugins-checkout>/packages/connector-feishu`
   - `<plugins-checkout>/packages/video-generation`
5. Open each installed plugin's settings. The Host packages the built local dependency closure; this path does not require the candidate SDK or plugins to have been published to npm. An offline archive or public catalog is a different installation source.

The following checks exercise configuration only. Keep external connections disabled when using dummy credentials. Live Feishu messaging or video generation requires valid service credentials and is a separate integration check.

## Feishu mode switching

1. Select Webhook. App ID, App Secret and Verification Token are required. Saving without an active required field must fail with an actionable field error.
2. Select WebSocket. Verification Token is hidden and no longer required; App ID and App Secret remain required.
3. Switch back to Webhook. Verification Token is visible and required again.
4. A missing selector may use its declared default. An explicitly invalid value must not silently become the default or the first option.

## Stored secret lifecycle

1. Save a complete configuration. Reopen it: secrets show only a presence indicator or placeholder, not plaintext.
2. Change only a non-secret field and save. Existing secrets remain set; the placeholder must not overwrite them.
3. Replace a secret with a new value and save. Verify the replacement through an authorized test probe without printing it in logs.
4. Explicitly delete a secret required by the current mode. Saving must require it again. Switching to a mode where that field is inactive must not require it.
5. Switch away from and back to a previously saved branch. Retained values should be restored without being delivered while inactive.

## Persistence and video authentication branches

- Save a selected mode, reload the page, and reopen settings. The mode, non-secret values and secret presence must persist.
- Video `apikey` shows and requires only API Key among authentication secrets.
- Video `jwt-hs256` and `hmac-sha256-v4` show and require Access Key and Secret Key, not API Key.
- Common fields remain available across modes. A missing credential from an inactive branch must not block the active branch.
- HTTP and HTTPS provider endpoints are supported. A configuration save alone does not prove provider reachability or a successful generation request.

## Host integration checks and evidence

Use an authorized test observer to verify module getters, external-runtime values and declared MCP bindings receive common plus active fields only. Do not expose secret values in evidence. Check that an enabled configuration refresh updates subsequent launch values while preserving grants and explicit disable controls.

Test ordinary select validation, URI syntax, whitespace-only required credentials, and operation target readiness. A secret containing valid characters with surrounding whitespace must retain its original bytes. Also include a plugin without variants to verify the existing configuration path remains compatible.

Record source revisions, package versions/digests, the scenarios exercised and their results in the review or test-run output. Distinguish configuration acceptance, external-service integration and any required soak. Do not publish machine-specific paths, instance IDs, credentials or local process/log coordinates as product documentation. Public npm publication and live-catalog activation follow the repository release process independently of local-directory acceptance.
