// The database API the server code is written against: the small subset of Cloudflare D1 that the
// app uses. Implemented locally by src/local/d1-sqlite.ts on top of node:sqlite. Declared globally
// because drizzle-orm/d1 resolves these names from the global scope.
export {};

declare global {
  interface D1Result<T = unknown> {
    results: T[];
    success: true;
    meta: Record<string, unknown>;
  }
  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
  }
  interface D1Database {
    prepare(sql: string): D1PreparedStatement;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
    exec(sql: string): Promise<unknown>;
  }
}
