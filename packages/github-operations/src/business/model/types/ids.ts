
/**
 * Branded Types for type-safe IDs
 * 使用 branded types 确保不同类型的 ID 不会混用
 */

// Brand symbol for type safety
declare const brand: unique symbol;

type Brand<T, B> = T & { readonly [brand]: B };
export type CatId = Brand<string, 'CatId'>;

/**
 * Create a CatId from a string (lightweight syntax check only).
 * Does NOT validate against a registry — use assertKnownCatId() for that.
 * @throws Error if id is empty or not a string
 */
export function createCatId(id: string): CatId {
  if (!id || typeof id !== 'string') {
    throw new Error('Invalid cat ID: must be non-empty string');
  }
  return id as CatId;
}

export function generateId(prefix?: string): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 10);
  return prefix ? `${prefix}_${timestamp}${randomPart}` : `${timestamp}${randomPart}`;
}
