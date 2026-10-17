import type { PluginManifest } from '../generated/contract.generated.js';
import { Buffer } from 'node:buffer';
export function isBrowserServicePath(path: string): boolean {
  if (!path.startsWith('/') || path.includes('//') || /[\\?#\x00-\x20\x7f]|%(?:2f|5c|2e)/i.test(path)) return false;
  try { const decoded = decodeURIComponent(path); return !decoded.split('/').some(segment => segment === '.' || segment === '..') &&
    !/[\\?#\x00-\x20\x7f]/.test(decoded) && Buffer.byteLength(path) <= 8192; } catch { return false; }
}
export function browserServiceManifestError(manifest: PluginManifest): string | undefined {
  const privateMethods = new Set<string>();
  const others = new Set<string>();
  for (const field of manifest.configuration ?? []) if (field.kind === 'operation') for (const action of field.actions) others.add(action.action.method);
  if (manifest.test) others.add(manifest.test.action.method);
  for (const contribution of manifest.contributions ?? []) {
    if (contribution.type !== 'browser-service') {
      if ('action' in contribution) others.add(contribution.action.method);
      if (contribution.type === 'mcp') for (const action of contribution.actions ?? []) others.add(action.method);
      if (contribution.type === 'media-source') { others.add(contribution.readAction.method); others.add(contribution.settleAction.method); }
      if (contribution.type === 'service') others.add(contribution.healthMethod);
      if (contribution.type === 'message-subscription' && contribution.lifecycleAction) others.add(contribution.lifecycleAction.method);
      if (contribution.type === 'cloud-conversation-host') { others.add(contribution.appendMessage.method); others.add(contribution.assistantReturns.list.method); others.add(contribution.assistantReturns.ack.method); }
      if (contribution.type === 'terminal-predicate-provider') { others.add(contribution.freshnessMethod); others.add(contribution.completionMethod); }
      if (contribution.type === 'connector') { others.add(contribution.inboundMethod); others.add(contribution.outboundMethod); }
      continue;
    }
    if (manifest.runtime?.transport !== 'builtin') return 'browser-service requires the owned builtin module runtime';
    if (privateMethods.has(contribution.action.method)) return 'browser-service actions must be unique';
    privateMethods.add(contribution.action.method);
    const seen = new Set<string>();
    for (const route of contribution.routes) {
      if (!isBrowserServicePath(route.path) || (!route.browser && !route.local) ||
        (route.browser === 'callback' && route.method !== 'GET')) return 'invalid browser-service literal route or lane';
      const key = route.method + ':' + route.path;
      if (seen.has(key)) return 'duplicate browser-service route'; seen.add(key);
    }
    const cookies = new Set<string>();
    for (const cookie of contribution.credentials.cookies) {
      if (!isBrowserServicePath(cookie.path) || cookies.has(cookie.name)) return 'invalid or duplicate browser-service cookie';
      cookies.add(cookie.name);
    }
  }
  if ([...privateMethods].some(method => others.has(method))) return 'browser-service private method collides with another caller';
  return undefined;
}
