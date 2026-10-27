import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readPrivateJson } from './private-files.js';
import { credentials, MusicError, object, type GoogleCredentials, type MusicDependencies } from './types.js';

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel(); throw new MusicError('invalid_response', true);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new MusicError('invalid_response', true);
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function refreshGoogle(grant: GoogleCredentials, request: typeof fetch, signal?: AbortSignal): Promise<string> {
  try {
    const response = await request('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: grant.client_id, client_secret: grant.client_secret, refresh_token: grant.refresh_token }).toString(),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new MusicError(response.status === 429 ? 'oauth_rate_limited' : [400, 401, 403].includes(response.status) ? 'oauth_authorization_required' : 'oauth_unavailable');
    }
    const value = await boundedJson(response, 16 * 1024);
    if (!object(value) || value.token_type !== 'Bearer' || typeof value.access_token !== 'string' ||
        !/^[\x21-\x7e]{1,8192}$/.test(value.access_token)) throw new MusicError('oauth_invalid_response');
    return value.access_token;
  } catch (error) {
    if (error instanceof MusicError) throw new MusicError(error.code);
    throw new MusicError('oauth_unavailable');
  }
}

/** Fixed official endpoints, manual response parsing, and no SDK mutation retries. */
export function googleCloudDependencies(request: typeof fetch = fetch): MusicDependencies {
  return {
    async readAdc() {
      const path = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || join(homedir(), '.config/gcloud/application_default_credentials.json');
      if (!isAbsolute(path)) throw new MusicError('oauth_credentials_invalid');
      try { return credentials(await readPrivateJson(path)); }
      catch (error) {
        if (error instanceof MusicError) throw error;
        throw new MusicError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'oauth_configuration_required' : 'oauth_credentials_invalid');
      }
    },
    async verifyConnection(grant, signal) {
      const token = await refreshGoogle(grant, request, signal);
      const headers = { authorization: `Bearer ${token}`, 'x-goog-user-project': grant.quota_project_id };
      const get = async (url: string) => {
        let response: Response;
        try { response = await request(url, { headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]) }); }
        catch { throw new MusicError('cloud_check_unavailable'); }
        if (!response.ok) { await response.body?.cancel(); throw new MusicError('cloud_project_access_required'); }
        return boundedJson(response, 64 * 1024);
      };
      const project = encodeURIComponent(grant.quota_project_id);
      const [billing, service] = await Promise.all([
        get(`https://cloudbilling.googleapis.com/v1/projects/${project}/billingInfo`),
        get(`https://serviceusage.googleapis.com/v1/projects/${project}/services/aiplatform.googleapis.com`),
      ]);
      return { projectId: grant.quota_project_id, billingEnabled: object(billing) && billing.billingEnabled === true,
        vertexEnabled: object(service) && service.state === 'ENABLED' };
    },
    async generate(input, grant, signal) {
      const token = await refreshGoogle(grant, request, signal);
      const prompt = [input.prompt,
        ...(input.durationSeconds === undefined ? [] : [`Target duration: ${input.durationSeconds} seconds.`]),
        ...(input.bpm === undefined ? [] : [`Target tempo: ${input.bpm} BPM.`]),
        ...(input.instrumental ? ['Instrumental only, no vocals.'] : [])].join('\n');
      try {
        const response = await request(`https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(grant.quota_project_id)}/locations/global/interactions`, {
          method: 'POST', redirect: 'error', signal,
          headers: { authorization: `Bearer ${token}`, 'x-goog-user-project': grant.quota_project_id, 'content-type': 'application/json' },
          body: JSON.stringify({ model: input.model, input: [{ type: 'text', text: prompt }], store: false }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new MusicError(response.status === 429 ? 'quota_exhausted' : [401, 403].includes(response.status) ? 'authentication_failed' : response.status === 402 ? 'billing_unavailable' : 'provider_error', response.status >= 500 || response.status === 408);
        }
        const value = await boundedJson(response, 64 * 1024 * 1024);
        if (!object(value)) throw new MusicError('invalid_response', true);
        if (value.status === 'failed' || (Array.isArray(value.errors) && value.errors.length)) {
          const safety = Array.isArray(value.errors) && value.errors.some(e => object(e) && /safety|policy|block|prohibit|recitation/i.test(String(e.code)));
          throw new MusicError(safety ? 'safety_refused' : 'provider_refused');
        }
        const audio = Array.isArray(value.outputs) ? value.outputs.filter(part => object(part) && part.type === 'audio') : [];
        const item = audio[0];
        if (value.status !== 'completed' || audio.length !== 1 || !object(item) || !['audio/mpeg', 'audio/mp3'].includes(String(item.mime_type)) || typeof item.data !== 'string') throw new MusicError('invalid_response', true);
        const bytes = Buffer.from(item.data, 'base64');
        if (bytes.length < 4 || bytes.toString('base64') !== item.data ||
            !(bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1]! & 224) === 224))) throw new MusicError('invalid_response', true);
        return { bytes, ...(typeof value.id === 'string' && value.id.length <= 512 ? { responseId: value.id } : {}),
          ...(typeof value.model === 'string' && value.model.length <= 128 ? { modelVersion: value.model } : {}) };
      } catch (error) {
        if (error instanceof MusicError) throw error;
        throw new MusicError(signal.aborted ? 'timeout' : 'provider_unavailable', true);
      }
    },
  };
}
