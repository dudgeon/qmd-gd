/**
 * db.test.ts - openDatabase configuration
 */

import { describe, test, expect, afterEach } from "vitest";
import { openDatabase } from "../src/db.js";
import { findStaleVectorModel } from "../src/store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_BUSY_TIMEOUT_MS = 120_000;

function readBusyTimeout(db: ReturnType<typeof openDatabase>): number {
  const row = db.prepare("PRAGMA busy_timeout").get() as Record<string, number>;
  const value = Object.values(row)[0];
  return typeof value === "number" ? value : Number(value);
}

describe("openDatabase", () => {
  const originalEnv = process.env.QMD_SQLITE_BUSY_TIMEOUT;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.QMD_SQLITE_BUSY_TIMEOUT;
    else process.env.QMD_SQLITE_BUSY_TIMEOUT = originalEnv;
  });

  test("sets the default busy_timeout so concurrent writers wait for the lock", () => {
    delete process.env.QMD_SQLITE_BUSY_TIMEOUT;
    const db = openDatabase(":memory:");
    try {
      expect(readBusyTimeout(db)).toBe(DEFAULT_BUSY_TIMEOUT_MS);
    } finally {
      db.close();
    }
  });

  test("applies the busy_timeout to each independently opened connection", async () => {
    delete process.env.QMD_SQLITE_BUSY_TIMEOUT;
    const dir = await mkdtemp(join(tmpdir(), "qmd-busy-"));
    const dbPath = join(dir, "shared.sqlite");
    try {
      const a = openDatabase(dbPath);
      const b = openDatabase(dbPath);
      try {
        expect(readBusyTimeout(a)).toBe(DEFAULT_BUSY_TIMEOUT_MS);
        expect(readBusyTimeout(b)).toBe(DEFAULT_BUSY_TIMEOUT_MS);
      } finally {
        a.close();
        b.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("QMD_SQLITE_BUSY_TIMEOUT overrides the default", () => {
    process.env.QMD_SQLITE_BUSY_TIMEOUT = "750";
    const db = openDatabase(":memory:");
    try {
      expect(readBusyTimeout(db)).toBe(750);
    } finally {
      db.close();
    }
  });

  test("QMD_SQLITE_BUSY_TIMEOUT=0 restores fail-fast", () => {
    process.env.QMD_SQLITE_BUSY_TIMEOUT = "0";
    const db = openDatabase(":memory:");
    try {
      expect(readBusyTimeout(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("ignores unparseable QMD_SQLITE_BUSY_TIMEOUT and falls back to the default", () => {
    process.env.QMD_SQLITE_BUSY_TIMEOUT = "not-a-number";
    const db = openDatabase(":memory:");
    try {
      expect(readBusyTimeout(db)).toBe(DEFAULT_BUSY_TIMEOUT_MS);
    } finally {
      db.close();
    }
  });

  test("SQLite honors the configured busy_timeout when another connection holds the write lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qmd-busy-"));
    const dbPath = join(dir, "contention.sqlite");
    try {
      const setup = openDatabase(dbPath);
      setup.exec("PRAGMA journal_mode = WAL");
      setup.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      setup.close();

      const holder = openDatabase(dbPath);
      const waiter = openDatabase(dbPath);
      try {
        // The synchronous SQLite API blocks the thread while it waits for the
        // lock, so the test can't release the holder mid-wait. Shorten the
        // waiter's timeout so the test finishes quickly; openDatabase already
        // proved (above) that the default is the full 120_000ms.
        waiter.exec("PRAGMA busy_timeout = 250");

        holder.exec("BEGIN IMMEDIATE");
        holder.prepare("INSERT INTO t (v) VALUES ('holder')").run();

        const start = Date.now();
        let threw: unknown = null;
        try {
          waiter.exec("BEGIN IMMEDIATE");
        } catch (err) {
          threw = err;
        }
        const elapsed = Date.now() - start;

        expect(threw).toBeTruthy();
        expect(elapsed).toBeGreaterThanOrEqual(200);
        expect(elapsed).toBeLessThan(2000);

        holder.exec("ROLLBACK");
      } finally {
        holder.close();
        waiter.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("transaction() shim (node:sqlite has no built-in transaction helper)", () => {
  const countRows = (db: ReturnType<typeof openDatabase>): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;

  test("commits on success and rolls back the whole body on throw", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      db.transaction(() => {
        db.prepare("INSERT INTO t (v) VALUES ('a')").run();
      })();
      expect(countRows(db)).toBe(1);

      expect(() =>
        db.transaction(() => {
          db.prepare("INSERT INTO t (v) VALUES ('b')").run();
          throw new Error("boom");
        })(),
      ).toThrow("boom");
      // The failed transaction's insert must not have persisted.
      expect(countRows(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  test("nested calls use savepoints: an inner rollback leaves the outer intact", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      db.transaction(() => {
        db.prepare("INSERT INTO t (v) VALUES ('outer')").run();
        try {
          db.transaction(() => {
            db.prepare("INSERT INTO t (v) VALUES ('inner')").run();
            throw new Error("inner boom");
          })();
        } catch {
          /* swallow: the outer transaction continues */
        }
        db.prepare("INSERT INTO t (v) VALUES ('outer2')").run();
      })();
      const rows = (db.prepare("SELECT v FROM t ORDER BY id").all() as { v: string }[]).map((r) => r.v);
      expect(rows).toEqual(["outer", "outer2"]); // 'inner' rolled back to its savepoint
    } finally {
      db.close();
    }
  });

  test("txDepth stays balanced across failures (no 'transaction within a transaction')", () => {
    // Regression guard: if a throwing COMMIT/ROLLBACK double-decremented txDepth,
    // a later BEGIN would fail. Interleave failing and succeeding transactions.
    const db = openDatabase(":memory:");
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      for (let i = 0; i < 3; i++) {
        expect(() => db.transaction(() => { throw new Error("x"); })()).toThrow("x");
        db.transaction(() => { db.prepare("INSERT INTO t (v) VALUES ('ok')").run(); })();
      }
      expect(countRows(db)).toBe(3);
    } finally {
      db.close();
    }
  });
});

describe("findStaleVectorModel (embed self-heal detector)", () => {
  const BGE = "bundled:bge-small-en-v1.5-Q8_0.gguf";
  const GEMMA = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
  // Mirrors the real content_vectors schema in store.ts.
  const SCHEMA = `CREATE TABLE content_vectors (
    hash TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL, embed_fingerprint TEXT NOT NULL DEFAULT '',
    total_chunks INTEGER NOT NULL DEFAULT 1, embedded_at TEXT NOT NULL,
    PRIMARY KEY (hash, seq))`;
  const seed = (db: ReturnType<typeof openDatabase>, model: string): void => {
    db.prepare("INSERT INTO content_vectors (hash, model, embedded_at) VALUES (?, ?, '')").run(`h-${model}`, model);
  };

  test("returns null on a fresh index (content_vectors absent)", () => {
    const db = openDatabase(":memory:");
    try {
      expect(findStaleVectorModel(db, BGE)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("returns null when every vector matches the current model", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec(SCHEMA);
      seed(db, BGE);
      expect(findStaleVectorModel(db, BGE)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("returns the foreign model when the index was built with a different one", () => {
    // This is what triggers the re-embed that un-strands a poisoned re-install.
    const db = openDatabase(":memory:");
    try {
      db.exec(SCHEMA);
      seed(db, GEMMA);
      expect(findStaleVectorModel(db, BGE)).toBe(GEMMA);
    } finally {
      db.close();
    }
  });
});
