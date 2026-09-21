import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

export function createSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS versions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label      TEXT NOT NULL,
      content    TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id, seq);

    CREATE TABLE IF NOT EXISTS comparisons (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      old_version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      new_version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      sealed_by      TEXT,
      sealed_at      TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_comparisons_project ON comparisons(project_id);

    CREATE TABLE IF NOT EXISTS fragments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      comparison_id INTEGER NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
      ord           INTEGER NOT NULL,
      type          TEXT NOT NULL CHECK (type IN ('added', 'removed', 'changed')),
      old_text      TEXT,
      new_text      TEXT,
      old_start     INTEGER,
      new_start     INTEGER,
      anchor        TEXT,
      decision      TEXT CHECK (decision IS NULL OR decision IN ('accepted', 'rejected', 'deferred')),
      decision_reason TEXT,
      decided_by    TEXT,
      decided_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fragments_comparison ON fragments(comparison_id, ord);

    CREATE TABLE IF NOT EXISTS annotations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      comparison_id INTEGER NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
      fragment_id   INTEGER REFERENCES fragments(id) ON DELETE SET NULL,
      author        TEXT NOT NULL,
      content       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'resolved', 'pending_review')),
      anchor_text   TEXT,
      similarity    REAL,
      migrated_from INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_annotations_comparison ON annotations(comparison_id, status);
  `);
}

/** 旧版本数据库平滑升级：补齐封存 / 片段结论相关列 */
function migrateSchema(db: DB): void {
  const addColumnIfMissing = (table: string, column: string, ddl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  addColumnIfMissing('comparisons', 'sealed_by', 'sealed_by TEXT');
  addColumnIfMissing('comparisons', 'sealed_at', 'sealed_at TEXT');
  addColumnIfMissing('fragments', 'decision', "decision TEXT");
  addColumnIfMissing('fragments', 'decision_reason', 'decision_reason TEXT');
  addColumnIfMissing('fragments', 'decided_by', 'decided_by TEXT');
  addColumnIfMissing('fragments', 'decided_at', 'decided_at TEXT');
}

export function openDb(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  migrateSchema(db);
  return db;
}
