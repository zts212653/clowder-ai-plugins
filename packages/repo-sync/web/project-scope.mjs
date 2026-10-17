export const pageProjectId = new URL(location.href).searchParams.get('project') ?? 'default';
export function projectUrl(path) {
  const url = new URL(path, location.origin);
  if (pageProjectId !== 'default' || new URL(location.href).searchParams.has('project'))
    url.searchParams.set('project', pageProjectId);
  return `${url.pathname}${url.search}`;
}
