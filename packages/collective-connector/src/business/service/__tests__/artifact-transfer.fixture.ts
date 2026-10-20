import { CollectiveServiceStore } from '../store.js';
import { artifactFixture } from './artifact.fixture.js';

/** Domain-only owner attestations. API tests must also prove the real owner ports produce these after full validation. */
export async function transferFixture() {
  const f = await artifactFixture();
  const pairing = await f.store.createPairingIntent({
    sessionToken: f.member.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    hostOrigin: 'http://localhost:5183',
    nonce: 'transfer-domain-nonce',
  });
  const target = await f.store.exchangePairingIntent({ ...pairing, endpointLabel: 'Transfer target' });
  const artifact = (await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration)).value
    .artifact;
  const offerInput = {
    ...f.coordinates,
    artifactId: artifact.artifactId,
    expectedCustodyRevision: 1,
    targetHumanId: f.member.human.humanId,
    requestId: 'transfer-domain-offer',
  };
  const offered = await f.store.offerArtifactCustody(f.owner.sessionToken, offerInput);
  const input = { ...f.coordinates, artifactId: artifact.artifactId, transferId: offered.handoffRef };
  const sourceInput = { ...input, connectionId: f.connection.connectionId };
  const targetInput = { ...input, connectionId: target.connectionId };
  const proof = {
    preparedRef: 'owner-source-prepared',
    ownerScopeRef: 'owner-scope:shared-guide',
    manifest: { digest: `sha256:${'b'.repeat(64)}`, totalBytes: 1000, pageCount: 1 },
    version: {
      contentRef: artifact.contentRef,
      ownerRevision: 1,
      blobDigest: f.registration.blobDigest,
      receiptRef: f.registration.receiptRef,
    },
  };
  const ready = {
    readyRef: 'owner-target-ready',
    preparedRef: proof.preparedRef,
    manifestDigest: proof.manifest.digest,
    ownerScopeRef: proof.ownerScopeRef,
  };
  const accept = {
    ...f.coordinates,
    artifactId: artifact.artifactId,
    connectionId: target.connectionId,
    handoffRef: offered.handoffRef,
    expectedCustodyRevision: 1,
    ...proof.version,
    ownerScopeRef: proof.ownerScopeRef,
    preparedRef: proof.preparedRef,
    readyRef: ready.readyRef,
    requestId: 'transfer-domain-commit',
  };
  let store = f.store;
  const reopen = async () => {
    store = (await CollectiveServiceStore.open({ dataDirectory: f.directory, humanAuthProvider: f.humanAuthProvider }))
      .store;
    return store;
  };
  const prepare = () => store.prepareArtifactCustody(f.connection.endpointCredential, { ...sourceInput, proof });
  const attest = () => store.readyArtifactCustody(target.endpointCredential, { ...targetInput, proof: ready });
  return {
    ...f,
    artifact,
    input,
    sourceInput,
    targetInput,
    target,
    proof,
    ready,
    accept,
    offerInput,
    prepare,
    attest,
    reopen,
  };
}
