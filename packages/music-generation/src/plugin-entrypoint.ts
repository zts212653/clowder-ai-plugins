import { googleCloudDependencies } from './google-cloud.js';
import { MusicJobs } from './music-jobs.js';
import { cancelOAuthHelpers } from './oauth-helper.js';
import { assertConnected, managedCredentials, musicSettings } from './settings.js';
import { current, musicInput, type MusicActionCall, type MusicDependencies, type MusicHost } from './types.js';

export function createMusicPlugin(dependencies: MusicDependencies = googleCloudDependencies()) {
  return { create(_manifest: unknown) { return {
    settings: (host: MusicHost) => musicSettings(host, dependencies),
    preUninstall: (host: MusicHost) => cancelOAuthHelpers(host.dataPath),
    async start(host: MusicHost) {
      let grant = await managedCredentials(host);
      assertConnected(await dependencies.verifyConnection(grant));
      const jobs = new MusicJobs(host, dependencies);
      return {
        actions: {
          'music.generate': async (input: unknown, call?: MusicActionCall) => {
            await current(call);
            return jobs.begin(musicInput(input), grant, call);
          },
          'music.result': (_input: unknown, call?: MusicActionCall) => jobs.result(call),
        },
        streams: { read: (reference: string, options?: { signal?: AbortSignal }) => jobs.read(reference, options?.signal) },
        async configRefresh() {
          const next = await managedCredentials(host);
          assertConnected(await dependencies.verifyConnection(next));
          grant = next;
        },
        async stop(_context: { reason: string }) { await jobs.stop(); await cancelOAuthHelpers(host.dataPath); },
        // Also used by bounded lifecycle verification; it does not generate or redispatch.
        drain: () => jobs.drain(),
      };
    },
  }; } };
}
export default createMusicPlugin();
