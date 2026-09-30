// Type surface for the byte-identical native-host title module (ported from
// the Host cloud-cat-personal-host closure in p1). Sibling declaration keeps
// the strict NodeNext build honest without touching the .mjs source.

export interface PersonalChromeConversationTitle {
  readonly conversationId: string;
  readonly authorizedAt: string;
  readonly displayTitle: string;
  readonly observedAt: string;
}

export function conversationTitlesPath(authorizationPath: string): string;
export function safeConversationTitle(value: unknown): string | undefined;
export function readConversationTitles(
  authorizationPath: string,
): Promise<PersonalChromeConversationTitle[]>;
export function projectConversationTitles<
  T extends { readonly conversationId: string; readonly authorizedAt: string },
>(
  conversations: readonly T[],
  titles: readonly PersonalChromeConversationTitle[],
): Array<T & { readonly displayTitle?: string; readonly titleObservedAt?: string }>;
export function writeConversationTitles(
  authorizationPath: string,
  conversations: readonly unknown[],
  updates?: readonly unknown[],
): Promise<void>;
