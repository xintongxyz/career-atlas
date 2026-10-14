// A D1-compatible facade over Node's built-in SQLite (`node:sqlite`).
//
// The server code (Drizzle's D1 driver and the raw read models) talks to `D1Database`, the API
// of Cloudflare D1 where Career Atlas started.
// Implementing that small surface on top of a local SQLite file lets every service,
// repository and the status machine run unchanged in the local runtime.
//
// Semantics kept from D1:
//   - `batch()` is atomic (one transaction; any failure rolls everything back)
//   - booleans bind as 1/0, `undefined` is rejected (D1 throws too)
//   - `raw()` returns arrays (duplicate column names preserved), `all()` returns objects
//   - foreign keys are enforced (D1 enforces them; cascades depend on it)
import { DatabaseSync, type StatementSync } from "node:sqlite";

type Bindable = null | number | bigint | string | Uint8Array;

function toBindable(v: unknown): Bindable {
  if (v === undefined) throw new TypeError("D1_TYPE_ERROR: undefined cannot be bound");
  if (v === null || typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v instanceof Date) return v.getTime();
  throw new TypeError(`D1_TYPE_ERROR: unsupported bind type ${typeof v}`);
}

const fromSqlite = (v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v);

function rowObject(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[k] = fromSqlite(row[k]);
  return out;
}

interface Meta {
  duration: number;
  changes: number;
  last_row_id: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
  size_after: number;
  served_by: string;
}

const meta = (changes = 0, lastRowId = 0, started = performance.now()): Meta => ({
  duration: performance.now() - started,
  changes,
  last_row_id: lastRowId,
  rows_read: 0,
  rows_written: changes,
  changed_db: changes > 0,
  size_after: 0,
  served_by: "career-atlas-local",
});

export class LocalPreparedStatement {
  constructor(
    private readonly owner: LocalD1,
    readonly sql: string,
    readonly params: Bindable[] = [],
  ) {}

  bind(...values: unknown[]): LocalPreparedStatement {
    return new LocalPreparedStatement(this.owner, this.sql, values.map(toBindable));
  }

  private stmt(): StatementSync {
    return this.owner.statement(this.sql);
  }

  /** Executes and returns objects (or nothing, for writes). Used by `all()` and `batch()`. */
  execAll() {
    const started = performance.now();
    const stmt = this.stmt();
    if (stmtReturnsRows(stmt)) {
      setArrays(stmt, false);
      const results = (stmt.all(...this.params) as Record<string, unknown>[]).map(rowObject);
      return { success: true as const, results, meta: meta(0, 0, started) };
    }
    const r = stmt.run(...this.params);
    return { success: true as const, results: [] as Record<string, unknown>[], meta: meta(Number(r.changes), Number(r.lastInsertRowid), started) };
  }

  async all<T = Record<string, unknown>>() {
    return this.execAll() as unknown as { success: true; results: T[]; meta: Meta };
  }

  async run<T = Record<string, unknown>>() {
    return this.execAll() as unknown as { success: true; results: T[]; meta: Meta };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const stmt = this.stmt();
    setArrays(stmt, false);
    const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (column !== undefined) {
      if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: ${column}`);
      return fromSqlite(row[column]) as T;
    }
    return rowObject(row) as T;
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.stmt();
    if (!stmtReturnsRows(stmt)) {
      stmt.run(...this.params);
      return [];
    }
    const names = stmt.columns().map((c) => c.name);
    let rows: unknown[][];
    if (setArrays(stmt, true)) {
      rows = (stmt.all(...this.params) as unknown as unknown[][]).map((r) => r.map(fromSqlite));
    } else {
      rows = (stmt.all(...this.params) as Record<string, unknown>[]).map((r) => names.map((n) => fromSqlite(r[n])));
    }
    return (options?.columnNames ? [names, ...rows] : rows) as T[];
  }
}

function stmtReturnsRows(stmt: StatementSync) {
  return stmt.columns().length > 0;
}

/** `setReturnArrays` exists on Node ≥ 22.16 / 24 but is missing from the pinned @types/node. */
function setArrays(stmt: StatementSync, on: boolean): boolean {
  const s = stmt as unknown as { setReturnArrays?: (v: boolean) => void };
  if (!s.setReturnArrays) return false;
  s.setReturnArrays(on);
  return true;
}

export interface LocalD1Options {
  /** Read-only connection (verification, backups of a live file). */
  readOnly?: boolean;
}

export class LocalD1 {
  readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(
    readonly path: string,
    opts: LocalD1Options = {},
  ) {
    this.db = new DatabaseSync(path, { readOnly: opts.readOnly ?? false, enableForeignKeyConstraints: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (!opts.readOnly && path !== ":memory:") {
      // WAL + FULL sync: every committed write survives a crash or power loss.
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
    }
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  statement(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }

  prepare(sql: string): LocalPreparedStatement {
    return new LocalPreparedStatement(this, sql);
  }

  /** Atomic like D1: all statements commit together or none do. */
  async batch(statements: LocalPreparedStatement[]) {
    return this.transaction(() => statements.map((s) => s.execAll()));
  }

  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async exec(sql: string) {
    const started = performance.now();
    this.db.exec(sql);
    return { count: sql.split(";").filter((s) => s.trim()).length, duration: performance.now() - started };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error("dump() is not supported locally; use the backup service");
  }

  withSession() {
    return this;
  }

  close() {
    this.cache.clear();
    if (this.db.isOpen) this.db.close();
  }

  /** The D1 type the server code expects. Structurally compatible for every method it calls. */
  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}
