export function requireCredential(
  credentials: Readonly<Record<string, string>>,
  ...keys: readonly string[]
): string {
  for (const key of keys) {
    const value = credentials[key];
    if (value?.trim()) return value;
  }
  throw new Error(`Missing required credential: ${keys[0]}`);
}
