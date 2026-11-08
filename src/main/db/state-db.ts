import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Schema migrations, applied in order. `PRAGMA user_version` records how many
 * have run. Never edit a released migration; append a new one.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE workspaces (
     id                TEXT PRIMARY KEY,
     profile_id        TEXT NOT NULL,
     project_id        TEXT NOT NULL,
     name              TEXT NOT NULL,
     branch            TEXT NOT NULL,
     base_branch       TEXT NOT NULL,
     worktree_path     TEXT NOT NULL,
     status            TEXT NOT NULL,
     claude_session_id TEXT,
     created_at        TEXT NOT NULL,
     last_activity_at  TEXT,
     archived_at       TEXT
   );
   CREATE INDEX workspaces_project ON workspaces (project_id) WHERE archived_at IS NULL;`,
  // Task fields, the unread marker, and §10.2 states in `status` ('active' was a placeholder).
  `ALTER TABLE workspaces ADD COLUMN task_id TEXT;
   ALTER TABLE workspaces ADD COLUMN task_title TEXT NOT NULL DEFAULT '';
   ALTER TABLE workspaces ADD COLUMN task_url TEXT;
   ALTER TABLE workspaces ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;
   UPDATE workspaces SET status = 'exited' WHERE status = 'active';`,
  // M1: hook data per workspace, and the plan usage snapshot per profile (spec §10, §11).
  `ALTER TABLE workspaces ADD COLUMN transcript_path TEXT;
   ALTER TABLE workspaces ADD COLUMN state_message TEXT;
   ALTER TABLE workspaces ADD COLUMN state_since TEXT;
   ALTER TABLE workspaces ADD COLUMN claude_running INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE usage (
     profile_id TEXT PRIMARY KEY,
     rate_limits TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // M2: the workspace's port block (spec §8.4).
  `ALTER TABLE workspaces ADD COLUMN port_base INTEGER;
   ALTER TABLE workspaces ADD COLUMN port_count INTEGER;`,
  // M4: the commit it started from, and its pull request (spec §12.3).
  `ALTER TABLE workspaces ADD COLUMN start_commit TEXT;
   ALTER TABLE workspaces ADD COLUMN pr_state TEXT;
   ALTER TABLE workspaces ADD COLUMN pr_url TEXT;
   ALTER TABLE workspaces ADD COLUMN pr_source TEXT;`,
  // LR: linked repositories (spec §21.1), and per-repository setup and commit state.
  `ALTER TABLE workspaces ADD COLUMN setup_error TEXT;
   ALTER TABLE workspaces ADD COLUMN has_commits INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE workspace_repos (
     workspace_id  TEXT NOT NULL,
     project_id    TEXT NOT NULL,
     position      INTEGER NOT NULL,
     worktree_path TEXT NOT NULL,
     base_branch   TEXT NOT NULL,
     start_commit  TEXT,
     setup_error   TEXT,
     has_commits   INTEGER NOT NULL DEFAULT 0,
     pr_state      TEXT,
     pr_url        TEXT,
     pr_source     TEXT,
     PRIMARY KEY (workspace_id, project_id)
   );`,
  // M6: whether the project's Start prompt still has to go out (spec §13.5);
  // workspaces made before never get one.
  `ALTER TABLE workspaces ADD COLUMN start_prompt_sent INTEGER NOT NULL DEFAULT 1;`,
  // Whether the title still comes from the status file, once (spec §13.5).
  `ALTER TABLE workspaces ADD COLUMN title_from_status INTEGER NOT NULL DEFAULT 0;`,
  // How many of Claude's background tasks still run (spec §10.2).
  `ALTER TABLE workspaces ADD COLUMN background INTEGER NOT NULL DEFAULT 0;`,
  // Claude didn't finish when the app stopped (spec §9.7): why, since when, and
  // whether the next start still has to offer it; and the last prompt sent.
  `ALTER TABLE workspaces ADD COLUMN unfinished TEXT;
   ALTER TABLE workspaces ADD COLUMN unfinished_at TEXT;
   ALTER TABLE workspaces ADD COLUMN unfinished_new INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE workspaces ADD COLUMN last_prompt TEXT;`,
  // How many of Claude's background commands the stop ended (spec §9.7).
  `ALTER TABLE workspaces ADD COLUMN unfinished_stopped INTEGER NOT NULL DEFAULT 0;`,
  // Keep running: never suspended when idle (spec §9.8), per workspace and per
  // project for its main checkout's Claude.
  `ALTER TABLE workspaces ADD COLUMN keep_running INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE kept_main_checkouts (project_id TEXT PRIMARY KEY);`,
  // Where a repository's branch is merged, as last checked (spec §14.2).
  `ALTER TABLE workspaces ADD COLUMN merged_into TEXT;
   ALTER TABLE workspace_repos ADD COLUMN merged_into TEXT;`,
  // Whether Claude may link repositories itself, and who linked each one (spec §21.9).
  `ALTER TABLE workspaces ADD COLUMN claude_may_link INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE workspace_repos ADD COLUMN added_by TEXT;`,
];

export type StateDb = Database.Database;

/** Opens `state.db` (spec §3.4) and brings its schema up to date. */
export function openStateDb(file: string): StateDb {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: StateDb): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `state.db is at schema version ${current}, newer than this app (${MIGRATIONS.length})`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version] as string);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

export const SCHEMA_VERSION = MIGRATIONS.length;

/** What a statement gives once the database is closed: nothing changed, nothing found. */
const CLOSED_STATEMENT = {
  run: () => ({ changes: 0, lastInsertRowid: 0 }),
  get: () => undefined,
  all: () => [],
};

/**
 * Prepares a statement, or, once state.db is closed at quit (spec §5), logs
 * and returns one that does nothing: a late caller (a terminal key or a timer
 * after the shutdown began) must not throw in the main process.
 */
export function prepareOrSkip(db: StateDb, sql: string): Database.Statement {
  if (db.open) return db.prepare(sql);
  console.warn(`state.db is closed; skipped: ${sql.trim().split(/\s+/).slice(0, 4).join(' ')} …`);
  return CLOSED_STATEMENT as unknown as Database.Statement;
}
