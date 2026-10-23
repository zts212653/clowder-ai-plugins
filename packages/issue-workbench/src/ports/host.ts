/** Transitional application ports, NOT plugin SDK methods or authorization grants. */
export interface ConfirmOptions { title: string; message: string; confirmLabel?: string; cancelLabel?: string }
export interface WorkbenchHost {
  repo: string;
  /** Stable owner/data identity supplied by the embedding Host. Never a credential. */
  dataScope: string;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  request: (path: string, options?: RequestInit) => Promise<Response>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  openSettings?: () => void;
  draftAssignees?: readonly string[];
}
export function createSourceClient(host: WorkbenchHost) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(host.repo) || !host.dataScope.trim()) throw new Error('Repository and stable data scope are required');
  const repo = host.repo;
  const fetch = async (path: string, options?: RequestInit) => {
    const url = new URL(path, 'https://workbench.invalid');
    const method = options?.method ?? 'GET';
    if (url.origin !== 'https://workbench.invalid' || url.searchParams.get('repo') !== repo ||
      !/^\/api\/issue-source(?:\/refresh|\/issues\/[1-9]\d*(?:\/refresh)?)?$/.test(url.pathname) ||
      !['GET','POST'].includes(method) || (method === 'POST') !== url.pathname.endsWith('/refresh') || options?.body) {
      throw new Error('Request outside the bound READ source scope');
    }
    // The Host owns authentication, authorization, cancellation and lifecycle.
    // Never recover a session through Core-private APIs or transmit credentials here.
    return host.request(path, { cache: 'no-store', ...options });
  };
  return { ...host, repo, fetch, sourceQuery: 'repo=' + encodeURIComponent(repo),
    storageKey: 'clowder:issue-workbench:preview:v1:' + JSON.stringify([host.dataScope, repo]) };
}
