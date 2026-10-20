// Type surface for the byte-identical native-host storage module (ported from
// the Host cloud-cat-personal-host closure in p1). Sibling declaration keeps
// the strict NodeNext build honest without touching the .mjs source.

export const PERSONAL_CHROME_AUTHORIZATION_LIMIT: number;

export class PersonalChromeConversationAuthorizationError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface PersonalChromeConversationAuthorization {
  readonly conversationId: string;
  readonly chatUrl: string;
  readonly authorizedAt: string;
  readonly updatedAt: string;
}

export interface PersonalChromeConversationAuthorizationCollection {
  readonly schemaVersion: 2;
  readonly provider: 'chatgpt';
  readonly conversations: readonly PersonalChromeConversationAuthorization[];
  readonly updatedAt: string;
}

export function isPersonalChromeConversationId(value: unknown): value is string;
export function conversationIdFromExactChatGptUrl(value: string): string | null;
export function validatePersonalChromeConversationAuthorizations(
  value: unknown,
): PersonalChromeConversationAuthorizationCollection;
export function writePersonalChromeConversationAuthorizationsAtomic(
  path: string,
  value: unknown,
  options?: { readonly renameFile?: (temporary: string, destination: string) => Promise<void> },
): Promise<PersonalChromeConversationAuthorizationCollection>;
export function withAuthorizationMutation<T>(
  path: string,
  operation: (normalizedPath: string) => Promise<T>,
): Promise<T>;
export function readPersonalChromeConversationAuthorizations(
  path: string,
  options?: { readonly migrateLegacy?: boolean },
): Promise<PersonalChromeConversationAuthorizationCollection>;
export function authorizePersonalChromeConversation(
  path: string,
  value: unknown,
): Promise<{
  readonly collection: PersonalChromeConversationAuthorizationCollection;
  readonly authorization: PersonalChromeConversationAuthorization;
  readonly added: boolean;
}>;
export function revokePersonalChromeConversation(
  path: string,
  conversationId: string,
  timestamp: string,
): Promise<{
  readonly collection: PersonalChromeConversationAuthorizationCollection;
  readonly revoked: boolean;
}>;
export function removePersonalChromeConversationAuthorizations(path: string): Promise<void>;
