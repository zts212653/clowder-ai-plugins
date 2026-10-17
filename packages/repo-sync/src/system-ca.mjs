import * as tls from 'node:tls';

let initialized = false;
export function configureSystemCA(provider = tls) {
  if (typeof provider.getCACertificates !== 'function' || typeof provider.setDefaultCACertificates !== 'function')
    return false;
  const existing = provider.getCACertificates('default'),
    system = provider.getCACertificates('system');
  provider.setDefaultCACertificates([...new Set([...existing, ...system])]);
  return true;
}
export function trustSystemCA() {
  if (!initialized) {
    configureSystemCA();
    initialized = true;
  }
}
