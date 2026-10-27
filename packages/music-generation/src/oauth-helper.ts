import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConnectionHelper } from './connection-flows.js';
import { privateDirectory, readOptional, readPrivateJson, writeNew } from './private-files.js';
import { credentials, MusicError, object, type GoogleCredentials } from './types.js';

/** The helper's private files own callback state; request-scoped Host/storage objects never escape. */
export function oauthHelper(dataPath: string, app: { clientId: string; clientSecret: string }): ConnectionHelper & {
  completed(flowId: string, projectId: string): Promise<GoogleCredentials>;
} {
  const path = (id: string) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new MusicError('invalid_flow_identity');
    return join(dataPath, 'oauth', id);
  };
  return {
    async begin(input) {
      await privateDirectory(join(dataPath, 'oauth'));
      const directory = path(input.flowId);
      await privateDirectory(directory);
      let launched = false;
      try {
        await writeNew(join(directory, 'request.json'), JSON.stringify({ ...input, ...app }));
        launched = true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (launched) {
        // Verified package member, no shell, token argv or inherited credential environment.
        const child = spawn(process.execPath, [fileURLToPath(new URL('./oauth-receiver.js', import.meta.url)), directory],
          { cwd: dataPath, detached: true, stdio: 'ignore', env: {} });
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
      }
      for (let i = 0; i < 100; i++) {
        const status = await readOptional(join(directory, 'status.json'));
        if (object(status) && typeof status.authorizationUrl === 'string') return { authorizationUrl: status.authorizationUrl };
        if (await readOptional(join(directory, 'failed.json'))) throw new MusicError('oauth_receiver_unavailable');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new MusicError('oauth_receiver_unavailable');
    },
    async observe(flowId) {
      const directory = path(flowId);
      if (await readOptional(join(directory, 'canceled.json')) || await readOptional(join(directory, 'failed.json'))) return { state: 'failed' };
      const completed = await readOptional(join(directory, 'completed.json'));
      if (object(completed) && completed.flowId === flowId && typeof completed.projectId === 'string')
        return { state: 'ready', flowId, projectId: completed.projectId, completionRef: flowId };
      const status = await readOptional(join(directory, 'status.json'));
      return { state: 'pending', ...(object(status) && typeof status.authorizationUrl === 'string' ? { authorizationUrl: status.authorizationUrl } : {}) };
    },
    async cancel(flowId) {
      await writeNew(join(path(flowId), 'canceled.json'), '{}').catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    },
    async completed(flowId, project) {
      if (await readOptional(join(path(flowId), 'canceled.json'))) throw new MusicError('oauth_canceled');
      const result = await readPrivateJson(join(path(flowId), 'completed.json'));
      if (!object(result) || result.flowId !== flowId || result.projectId !== project) throw new MusicError('oauth_project_mismatch');
      return credentials(result.grant, project);
    },
  };
}

/** Stop pending private receivers without retaining a request's Host client or acting on a stale PID. */
export async function cancelOAuthHelpers(dataPath: string): Promise<void> {
  let directories: Dirent[];
  try { directories = await readdir(join(dataPath, 'oauth'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const entry of directories) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.name)) continue;
    const directory = join(dataPath, 'oauth', entry.name);
    if (await readOptional(join(directory, 'closed.json')) || await readOptional(join(directory, 'completed.json'))) continue;
    await oauthHelper(dataPath, { clientId: '', clientSecret: '' }).cancel(entry.name);
    let closed = false;
    for (let i = 0; i < 40; i++) {
      if (await readOptional(join(directory, 'closed.json'))) { closed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!closed) throw new MusicError('oauth_receiver_stop_unconfirmed');
  }
}
