// Minimal types for Node's built-in node:sqlite (Node >= 22.5); @types/node 20 lacks them.
declare module 'node:sqlite' {
  type SQLValue = null | number | bigint | string | Uint8Array;
  export class StatementSync {
    run(...params: SQLValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: SQLValue[]): unknown;
    all(...params: SQLValue[]): unknown[];
  }
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
