/**
 * Type declarations for the `node:sqlite` builtin.
 *
 * The plugin reads the Host's evidence database with the Node builtin SQLite
 * module: a compiled native binding cannot survive the Host's script-free
 * package materialization, and shipping a prebuilt binary per platform would
 * tie this package to one ABI.
 *
 * The repo pins `@types/node` at ^20.17.0, which predates `node:sqlite`
 * (available and unflagged from Node 22.18). Declaring the module here keeps
 * that shared pin intact; upgrading it for one package would drift every other
 * consumer of these types. Only the members this package calls are declared, so
 * a wider surface cannot be used by accident — the runtime behavior itself is
 * covered by tests that open a real database with the real module.
 */
declare module 'node:sqlite' {
  type SqlValue = string | number | bigint | null | Uint8Array;

  interface StatementSync {
    all(...params: SqlValue[]): Record<string, SqlValue>[];
    get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
    run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }

  export { DatabaseSync, type StatementSync, type SqlValue };
}
