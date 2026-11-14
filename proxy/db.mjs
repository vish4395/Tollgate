import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";

// Columns added after the first release; added in place so existing data is kept.
const LATER_COLUMNS = {
  projects: {
    rpm_cap: "INTEGER",
    monthly_token_cap: "INTEGER",
    max_tokens_cap: "INTEGER",
    quota_cap_pct: "INTEGER",
    expires_at: "TEXT",
    allowed_origins: "TEXT",
  },
  requests: { ttfb_ms: "INTEGER", max_tokens: "INTEGER", user_agent: "TEXT" },
};

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
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_tokens_cap INTEGER,
      price_in REAL,
      price_out REAL,
      aliases TEXT,
      note TEXT
    );
  `);
  for (const [table, cols] of Object.entries(LATER_COLUMNS)) {
    const have = new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name),
    );
    for (const [col, type] of Object.entries(cols))
      if (!have.has(col))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  return db;
}

export const hashKey = (key) => createHash("sha256").update(key).digest("hex");

export function newKey() {
  const key = `cgw_${randomBytes(24).toString("base64url")}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}
