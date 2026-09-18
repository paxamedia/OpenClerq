/**
 * Schema migrations.
 *
 * Each entry runs once, in order, inside a transaction, and is recorded in
 * `schema_migrations`. Migrations are append-only: never edit one that has
 * shipped, add a new one.
 */

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'core_schema',
    sql: `
      -- ---------------------------------------------------------------
      -- Sessions: a conversational identity with a transcript. Interactive
      -- chat is a session; an automation's execution history is a session.
      -- ---------------------------------------------------------------
      CREATE TABLE sessions (
        id          TEXT PRIMARY KEY,
        title       TEXT,
        agent_id    TEXT,
        status      TEXT NOT NULL DEFAULT 'active',
        model       TEXT,
        metadata    TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);

      CREATE TABLE messages (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role           TEXT NOT NULL,
        content        TEXT NOT NULL,
        tool_name      TEXT,
        tool_call_id   TEXT,
        token_estimate INTEGER,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX idx_messages_session ON messages(session_id, id);

      -- ---------------------------------------------------------------
      -- Repositories an automation can target.
      -- ---------------------------------------------------------------
      CREATE TABLE repos (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        kind           TEXT NOT NULL CHECK (kind IN ('local','github','gitlab')),
        url            TEXT,
        local_path     TEXT,
        default_branch TEXT,
        credential_ref TEXT,
        setup_commands TEXT,
        created_at     TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_repos_name ON repos(name);

      -- ---------------------------------------------------------------
      -- Automations: the YAML spec plus its scheduling state.
      -- ---------------------------------------------------------------
      CREATE TABLE automations (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        spec            TEXT NOT NULL,
        schedule        TEXT,
        enabled         INTEGER NOT NULL DEFAULT 0,
        driver          TEXT,
        model_policy    TEXT,
        sandbox_profile TEXT,
        budget          TEXT,
        next_run_at     TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_automations_name ON automations(name);
      CREATE INDEX idx_automations_due ON automations(enabled, next_run_at);

      CREATE TABLE automation_targets (
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        repo_id       TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        PRIMARY KEY (automation_id, repo_id)
      );

      -- ---------------------------------------------------------------
      -- Runs: one bounded execution. Every state transition is written
      -- before it takes effect, so a run is resumable after a crash.
      -- ---------------------------------------------------------------
      CREATE TABLE runs (
        id            TEXT PRIMARY KEY,
        session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        automation_id TEXT REFERENCES automations(id) ON DELETE SET NULL,
        repo_id       TEXT REFERENCES repos(id) ON DELETE SET NULL,
        status        TEXT NOT NULL CHECK (status IN (
                        'queued','leased','preparing','executing','verifying',
                        'publishing','awaiting_approval','done','failed','cancelled')),
        trigger       TEXT NOT NULL CHECK (trigger IN ('schedule','event','manual','webhook')),
        lease_until   TEXT,
        branch        TEXT,
        pr_url        TEXT,
        cost_usd      REAL NOT NULL DEFAULT 0,
        tokens_in     INTEGER NOT NULL DEFAULT 0,
        tokens_out    INTEGER NOT NULL DEFAULT 0,
        exit_reason   TEXT,
        started_at    TEXT,
        finished_at   TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX idx_runs_status ON runs(status, lease_until);
      CREATE INDEX idx_runs_automation ON runs(automation_id, created_at DESC);
      CREATE INDEX idx_runs_created ON runs(created_at DESC);

      CREATE TABLE run_steps (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('llm','shell','fs','git','gate','tool')),
        input       TEXT,
        output      TEXT,
        status      TEXT,
        duration_ms INTEGER,
        tokens_in   INTEGER,
        tokens_out  INTEGER,
        cost_usd    REAL,
        created_at  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_run_steps_seq ON run_steps(run_id, seq);

      CREATE TABLE artifacts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('diff','log','file','report')),
        path       TEXT,
        blob       BLOB,
        sha256     TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_artifacts_run ON artifacts(run_id);

      CREATE TABLE approvals (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_id      INTEGER,
        requested_at TEXT NOT NULL,
        decided_by   TEXT,
        decision     TEXT CHECK (decision IN ('approved','denied')),
        reason       TEXT,
        decided_at   TEXT
      );
      CREATE INDEX idx_approvals_pending ON approvals(run_id, decision);

      -- ---------------------------------------------------------------
      -- Memory: replaces ~/.clerq/memory.json, which was read-modify-write
      -- with no locking, so concurrent writers silently clobbered entries.
      -- ---------------------------------------------------------------
      CREATE TABLE memory (
        key            TEXT PRIMARY KEY,
        value          TEXT NOT NULL,
        type           TEXT NOT NULL DEFAULT 'fact',
        source_session TEXT,
        confidence     REAL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        expires_at     TEXT
      );
      CREATE INDEX idx_memory_type ON memory(type);

      -- ---------------------------------------------------------------
      -- Triggers: replaces ~/.clerq/triggers.json, same clobbering problem.
      -- ---------------------------------------------------------------
      CREATE TABLE triggers (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('cron','file','webhook')),
        schedule   TEXT,
        path       TEXT,
        message    TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        last_fired TEXT,
        created_at TEXT NOT NULL
      );

      -- ---------------------------------------------------------------
      -- Append-only audit log. Never updated, never deleted by the app.
      -- ---------------------------------------------------------------
      CREATE TABLE audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        at         TEXT NOT NULL,
        actor      TEXT,
        action     TEXT NOT NULL,
        subject    TEXT,
        detail     TEXT
      );
      CREATE INDEX idx_audit_at ON audit_log(at DESC);
    `,
  },
  {
    id: 2,
    name: 'run_input',
    // What a run was asked to do. Steps record what it did, but a run that
    // fails before its first step would otherwise leave no trace of its request.
    sql: `ALTER TABLE runs ADD COLUMN input TEXT;`,
  },
  {
    id: 3,
    name: 'message_meta',
    // Metadata used to be stored inside the message text as JSON and guessed
    // back out on read, which could rewrite a user message that happened to
    // look like that JSON. It gets a column of its own.
    sql: `ALTER TABLE messages ADD COLUMN meta TEXT;`,
  },
];
