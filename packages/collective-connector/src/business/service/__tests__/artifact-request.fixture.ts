import type { CollectiveServiceStore } from '../store.js';

export async function nextArtifactOperation(
  store: CollectiveServiceStore,
  credential: string,
  coordinates: { serviceInstanceId: string; collectiveId: string; connectionId: string },
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const operation = store.pollArtifactOperations(credential, coordinates)[0];
    if (operation) return operation;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Expected an admitted owner operation');
}
