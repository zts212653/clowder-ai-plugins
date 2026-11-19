/**
 * FTS5 progressive relaxation, ported from the Host's own query builder.
 *
 * Long queries (14+ tokens, mixed Chinese/English) return nothing under FTS5
 * AND-all semantics because no single document contains every token. The Host
 * answers by trying progressively looser queries, and this plugin must rank the
 * same rows the same way or its results would quietly diverge from the Host's.
 *
 * Levels: AND-all (strictest) → strong-AND + weak-OR → OR-all (loosest).
 */

/** Escape a token for safe embedding in an FTS5 double-quoted phrase. */
function escapeToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Classify a token as strong (discriminating, must stay required when relaxed)
 * or weak (common, may become optional).
 */
function isStrongToken(token: string): boolean {
  // Entity identifiers: F042, ADR-005, LL-048, KD-7, AC-B1, TD-12, HW-6
  if (/^(?:F|ADR|LL|KD|TD|AC|HW)-?\d+[a-zA-Z]?$/i.test(token)) return true;
  // Phase identifiers: PhaseA, PhaseB
  if (/^Phase[A-Z]$/i.test(token)) return true;
  // CJK is meaningful even when short
  if (/[一-鿿㐀-䶿]/.test(token)) return true;
  // Longer tokens discriminate more
  return token.length >= 4;
}

/** Build the FTS5 queries to try in order, strictest first. */
export function buildProgressiveFtsQueries(query: string): string[] {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const escaped = tokens.map(escapeToken);
  // Short queries work under AND-all; relaxation would only cost precision.
  if (tokens.length <= 3) return [escaped.join(' ')];
  const strong = tokens.filter(isStrongToken);
  const weak = tokens.filter((token) => !isStrongToken(token));
  const queries: string[] = [escaped.join(' ')];
  if (strong.length > 0 && weak.length > 0) {
    queries.push(`(${strong.map(escapeToken).join(' ').replace(/ (?=\S)/g, ' AND ')}) AND (${weak.map(escapeToken).join(' OR ')})`);
  }
  queries.push(escaped.join(' OR '));
  return [...new Set(queries)];
}

/**
 * Split a query into the words a substring backfill may look for.
 *
 * FTS5 unicode61 misses substrings inside a token (a Chinese phrase written
 * without spaces, a compound word); the Host recovers those with LIKE scans
 * over the same rows.
 */
export function splitLexicalBackfillWords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[\s,，。;；:：!！?？()[\]{}"'“”‘’]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
  return [...new Set(words)];
}
