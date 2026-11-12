import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      daily_request_cap INTEGER,
      daily_token_cap INTEGER,
      allowed_models TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      project_id INTEGER,
      ip TEXT,
      method TEXT,
      path TEXT,
      model TEXT,
      stream INTEGER,
      status INTEGER,
      ms INTEGER,
      queue_ms INTEGER,
      in_tok INTEGER DEFAULT 0,
      out_tok INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0,
      cache_write INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
    CREATE INDEX IF NOT EXISTS requests_project_ts ON requests(project_id, ts);
  `);
  return db;
}

export const hashKey = (key) => createHash("sha256").update(key).digest("hex");

export function newKey() {
  const key = `cgw_${randomBytes(24).toString("base64url")}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}
