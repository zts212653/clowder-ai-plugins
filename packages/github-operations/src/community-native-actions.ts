import { z } from 'zod';

/** Single package allowlist. Host supplies authority as the second context. */
export const communityNativeTargets = {
  'github.community.triage-complete': 'triage-complete',
  'github.community.request-guardian': 'request-guardian',
  'github.community.guardian-signoff': 'guardian-signoff',
  'github.community.validate-route': 'validate-route',
  'github.community.report': 'report',
  'github.community.await-external': 'await-external',
} as const;
export type CommunityNativeMethod = keyof typeof communityNativeTargets;
export const communityNativeMethods = Object.freeze(Object.keys(communityNativeTargets) as CommunityNativeMethod[]);
export const communityNativeInput = z.object({
  id: z.string().min(1).max(512).describe('Internal case ID; for await-external, the canonical issue:owner/repo#number or pr:owner/repo#number subject key. Do not URL-encode.'),
  payload: z.record(z.unknown()).describe('Business payload for this callback. Caller identity and invocation authority come from Host context, never these fields.'),
}).strict();
