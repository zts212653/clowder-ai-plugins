import { pathToFileURL } from 'node:url';
import { inspectPublisher } from './npm-publisher-diagnostic.mjs';

export async function inspectIdentityOnly({ token, fetchImpl = fetch }) {
  let actualRequests = 0;
  const constrainedFetch = async (url, options) => {
    if (url !== 'https://registry.npmjs.org/-/whoami' || options.method !== 'GET' ||
        options.redirect !== 'error' || actualRequests !== 0) {
      throw new Error('Only one fixed identity GET is permitted');
    }
    actualRequests += 1;
    return fetchImpl(url, options);
  };
  const result = await inspectPublisher({ token, fetchImpl: constrainedFetch });
  return {
    configured: result.configured,
    status: result.whoami?.status ?? null,
    username: result.whoami?.username ?? null,
    actualRequests,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.NPM_TOKEN;
  delete process.env.NPM_TOKEN;
  console.log(JSON.stringify(await inspectIdentityOnly({ token })));
}
