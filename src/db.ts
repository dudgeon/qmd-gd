/**
 * db.ts - SQLite access layer (Node's built-in node:sqlite + sqlite-vec)
 *
 * qmd-gd uses Node's BUILT-IN SQLite (`node:sqlite`, Node >= 22.13) instead of a
 * native addon, so there is nothing to compile at install time and nothing to
 * rebuild when Node changes — the engine ships with Node. sqlite-vec is loaded as
 * a prebuilt loadable extension (a `.dylib`/`.so`/`.dll`, not a Node addon, so it
 * is Node-version-independent) for vector similarity search.
 *
 * The Database/Statement interfaces below are the subset of the better-sqlite3 API
 * the rest of QMD was written against; the adapters map them onto node:sqlite's
 * DatabaseSync/StatementSync so the ~118 call sites are untouched.
 */

export type SQLiteValue = string | number | bigint | Buffer | Uint8Array | Float32Array | null;
export type SQLiteParams = readonly SQLiteValue[];

// Load node:sqlite lazily so an unsupported Node yields a clear, actionable error
// instead of a cryptic "Cannot find module 'node:sqlite'".
const nodeSqlite = await (async () => {
  try {
    return await import("node:sqlite");
  } catch (err) {
    throw new Error(
      `qmd requires Node's built-in SQLite (node:sqlite), available in Node >= 22.13. ` +
        `You are running ${process.version}. Upgrade Node (e.g. the latest LTS) and retry.\n` +
        `(${(err as Error)?.message ?? String(err)})`
    );
  }
})();
const DatabaseSyncCtor = nodeSqlite.DatabaseSync;
type RawDatabase = InstanceType<typeof nodeSqlite.DatabaseSync>;
type RawStatement = ReturnType<RawDatabase["prepare"]>;

let _sqliteVecLoad: ((db: { loadExtension(path: string): void }) => void) | null = null;
try {
  const sqliteVec = await import("sqlite-vec");
  _sqliteVecLoad = (db) => sqliteVec.load(db as Parameters<typeof sqliteVec.load>[0]);
} catch {
  _sqliteVecLoad = null;
}

function isBusyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown };
  // node:sqlite surfaces SQLite result codes numerically: SQLITE_BUSY = 5,
  // SQLITE_BUSY_SNAPSHOT = 517. (better-sqlite3 used string codes like "SQLITE_BUSY".)
  if (e.errcode === 5 || e.errcode === 517) return true;
  if (e.code === "SQLITE_BUSY" || e.code === "SQLITE_BUSY_SNAPSHOT") return true;
  const message = typeof e.message === "string" ? e.message : "";
  return /database is locked|database is busy|SQLITE_BUSY/i.test(message);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Switch a connection to WAL, retrying on `SQLITE_BUSY` within the busy-timeout
 * budget. Unlike ordinary writes, migrating the journal needs a brief exclusive
 * lock and does NOT invoke the busy handler, so concurrent first-time opens of a
 * cold database throw "database is locked" even with `busy_timeout` set. Once the
 * database is already WAL the pragma is a cheap no-op that does not contend.
 */
function enableWal(db: Database, budgetMs: number): void {
  const deadline = Date.now() + Math.max(budgetMs, 0);
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (err) {
      if (!isBusyError(err) || Date.now() >= deadline) throw err;
      sleepSync(Math.min(5 + attempt, 25));
    }
  }
}

/**
 * Common subset of the Database interface used throughout QMD.
 */
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  loadExtension(path: string): void;
  transaction<T extends (...args: SQLiteValue[]) => unknown>(fn: T): T;
  close(): void;
}

export interface Statement {
  run(...params: SQLiteValue[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = unknown>(...params: SQLiteValue[]): T | undefined;
  all<T = unknown>(...params: SQLiteValue[]): T[];
  iterate<T = unknown>(...params: SQLiteValue[]): IterableIterator<T>;
}

/** Adapts a node:sqlite StatementSync to QMD's Statement interface. */
class NodeSqliteStatement implements Statement {
  constructor(private readonly stmt: RawStatement) {}
  run(...params: SQLiteValue[]): { changes: number; lastInsertRowid: number | bigint } {
    // node:sqlite's param type omits Float32Array, but accepts it at runtime as a
    // blob (qmd binds embedding vectors this way), so cast through the type gap.
    const r = this.stmt.run(...(params as never[]));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }
  get<T = unknown>(...params: SQLiteValue[]): T | undefined {
    return this.stmt.get(...(params as never[])) as T | undefined;
  }
  all<T = unknown>(...params: SQLiteValue[]): T[] {
    return this.stmt.all(...(params as never[])) as T[];
  }
  iterate<T = unknown>(...params: SQLiteValue[]): IterableIterator<T> {
    return this.stmt.iterate(...(params as never[])) as IterableIterator<T>;
  }
}

/** Adapts a node:sqlite DatabaseSync to QMD's Database interface. */
class NodeSqliteDatabase implements Database {
  private txDepth = 0;
  constructor(private readonly raw: RawDatabase) {}
  exec(sql: string): void {
    this.raw.exec(sql);
  }
  prepare(sql: string): Statement {
    return new NodeSqliteStatement(this.raw.prepare(sql));
  }
  loadExtension(path: string): void {
    this.raw.loadExtension(path);
  }
  close(): void {
    this.raw.close();
  }
  /**
   * better-sqlite3-style transaction: returns a function that runs `fn` inside a
   * transaction (committing on success, rolling back on throw). node:sqlite has no
   * `transaction()` helper, so we drive BEGIN/COMMIT/ROLLBACK directly and use
   * SAVEPOINTs for nested calls so re-entrancy is safe.
   */
  transaction<T extends (...args: SQLiteValue[]) => unknown>(fn: T): T {
    const wrapped = ((...args: SQLiteValue[]) => {
      const nested = this.txDepth > 0;
      const sp = `qmd_sp_${this.txDepth}`;
      this.raw.exec(nested ? `SAVEPOINT ${sp}` : "BEGIN");
      this.txDepth++;
      try {
        const out = fn(...args);
        this.txDepth--;
        this.raw.exec(nested ? `RELEASE ${sp}` : "COMMIT");
        return out;
      } catch (err) {
        this.txDepth--;
        this.raw.exec(nested ? `ROLLBACK TO ${sp}` : "ROLLBACK");
        throw err;
      }
    }) as T;
    return wrapped;
  }
}

/**
 * Open a SQLite database (node:sqlite).
 *
 * SQLite defaults `busy_timeout` to 0, so concurrent writers throw `SQLITE_BUSY`
 * instead of waiting. WAL improves read-while-write concurrency but does not
 * serialise writers. Setting the timeout at connection open makes parallel
 * processes (e.g. an `update` or `query` racing a long `embed`, or a first-open
 * schema migration racing any routine command) queue at batch boundaries instead
 * of failing on contact. WAL is enabled here too (with a bounded retry) so
 * connection-level pragmas live in one place and the cold-database journal
 * migration survives concurrent opens.
 *
 * Default 120_000 ms outlasts the worst-case batch commit on a multi-GB index.
 * Override with `QMD_SQLITE_BUSY_TIMEOUT` (ms; `0` restores fail-fast behaviour).
 *
 * `allowExtension` is required for node:sqlite to load the sqlite-vec extension.
 */
export function openDatabase(path: string): Database {
  const raw = new DatabaseSyncCtor(path, { allowExtension: true });
  // Belt-and-suspenders: also enable runtime extension loading if exposed.
  (raw as { enableLoadExtension?: (on: boolean) => void }).enableLoadExtension?.(true);
  const db = new NodeSqliteDatabase(raw);
  const rawTimeout = process.env.QMD_SQLITE_BUSY_TIMEOUT;
  const parsed = rawTimeout !== undefined && rawTimeout !== "" ? Number(rawTimeout) : Number.NaN;
  const busyTimeoutMs = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 120_000;
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  enableWal(db, busyTimeoutMs);
  return db;
}

/**
 * Load the sqlite-vec extension into a database.
 *
 * Throws with platform-specific fix instructions when the extension is
 * unavailable.
 */
export function loadSqliteVec(db: Database): void {
  if (!_sqliteVecLoad) {
    throw new Error(
      "sqlite-vec extension is unavailable. Ensure the sqlite-vec native module is installed correctly."
    );
  }
  _sqliteVecLoad(db);
}
