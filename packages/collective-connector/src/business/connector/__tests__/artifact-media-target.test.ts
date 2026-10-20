import { createServer, type Server } from 'node:http';
import { expect, it } from 'vitest';
import { CollectiveArtifactMediaClient } from '../artifact-media-client.js';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
it('never follows a binary reader request to a different Service origin', async () => {
  let foreignRequests = 0;
  const foreign = createServer((request, response) => {
    foreignRequests++;
    request.resume();
    response.end('{}');
  });
  const target = await listen(foreign);
  const origin = createServer((request, response) => {
    request.resume();
    response.writeHead(307, { location: target }).end();
  });
  const url = await listen(origin);
  try {
    const client = new CollectiveArtifactMediaClient(async () => ({}), fetch);
    await expect(
      client.read(
        url,
        'private-endpoint-credential',
        {
          serviceInstanceId: 'service',
          collectiveId: 'collective',
          connectionId: 'reader',
          artifactId: 'artifact',
          sourceEventId: 'source',
          ownerRevision: 1,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(foreignRequests).toBe(0);
  } finally {
    await close(origin);
    await close(foreign);
  }
});
