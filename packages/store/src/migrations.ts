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
  {
    id: 4,
    name: 'module_migrations',
    // Each module's own migrations, applied by migrateModule().
    sql: `
      CREATE TABLE module_migrations (
        module_id  TEXT NOT NULL,
        id         INTEGER NOT NULL,
        name       TEXT NOT NULL,
        checksum   TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (module_id, id)
      );
    `,
  },
  {
    id: 5,
    name: 'run_module',
    // A run started by a module's trigger names the module and the trigger.
    sql: `
      ALTER TABLE runs ADD COLUMN module_id TEXT;
      ALTER TABLE runs ADD COLUMN trigger_ref TEXT;
      CREATE INDEX idx_runs_module ON runs(module_id, created_at DESC);
    `,
  },
  {
    id: 6,
    name: 'scoped_tokens',
    // Tokens narrower than the gateway token: a module UI's, or a paired
    // device's. Only a hash is kept. `idle_ms` makes expiry slide with use.
    sql: `
      CREATE TABLE scoped_tokens (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL CHECK (kind IN ('module','device')),
        subject      TEXT NOT NULL,
        tenant_id    TEXT NOT NULL DEFAULT 'default',
        token_hash   TEXT NOT NULL UNIQUE,
        scopes       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        idle_ms      INTEGER,
        revoked_at   TEXT,
        last_seen_at TEXT
      );
      CREATE INDEX idx_scoped_tokens_subject ON scoped_tokens(kind, subject);
    `,
  },
  {
    id: 7,
    name: 'modules',
    // Every module the gateway has started, with what its manifest declares.
    sql: `
      CREATE TABLE modules (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        version       TEXT NOT NULL,
        dir           TEXT NOT NULL,
        permissions   TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('loaded','failed')),
        error         TEXT,
        first_seen_at TEXT NOT NULL,
        loaded_at     TEXT NOT NULL
      );
    `,
  },
  {
    id: 8,
    name: 'records',
    // Shared records every module can point at: people, organisations and
    // activities, found again by email, phone or domain, within one tenant. Modules keep their
    // own types and link to these by ref (<module>:<type>:<id>).
    sql: `
      CREATE TABLE records (
        id           TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL DEFAULT 'default',
        type         TEXT NOT NULL CHECK (type IN ('person','organisation','activity')),
        name         TEXT,
        data         TEXT NOT NULL DEFAULT '{}',
        merged_into  TEXT REFERENCES records(id) ON DELETE SET NULL,
        occurred_at  TEXT,
        created_by   TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX idx_records_type ON records(tenant_id, type, updated_at DESC);

      CREATE TABLE record_identities (
        tenant_id TEXT NOT NULL DEFAULT 'default',
        kind      TEXT NOT NULL CHECK (kind IN ('email','phone','domain')),
        value     TEXT NOT NULL,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        PRIMARY KEY (tenant_id, kind, value)
      );
      CREATE INDEX idx_record_identities_record ON record_identities(record_id);

      CREATE TABLE record_links (
        tenant_id  TEXT NOT NULL DEFAULT 'default',
        from_ref   TEXT NOT NULL,
        to_ref     TEXT NOT NULL,
        kind       TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, from_ref, to_ref, kind)
      );
      CREATE INDEX idx_record_links_to ON record_links(tenant_id, to_ref);
    `,
  },
  {
    id: 9,
    name: 'inbox_items',
    // Everything waiting for a person, from every module. Pending approvals
    // join these when the inbox is read; they keep their own table.
    sql: `
      CREATE TABLE inbox_items (
        id          TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        module_id   TEXT,
        external_id TEXT,
        kind        TEXT NOT NULL CHECK (kind IN ('approval','reply','task','alert')),
        title       TEXT NOT NULL,
        body        TEXT,
        ref         TEXT,
        link        TEXT,
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
        priority    INTEGER NOT NULL DEFAULT 0,
        due_at      TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT
      );
      CREATE INDEX idx_inbox_open ON inbox_items(tenant_id, status, priority DESC, created_at DESC);
      CREATE UNIQUE INDEX idx_inbox_external ON inbox_items(tenant_id, module_id, external_id)
        WHERE external_id IS NOT NULL;
    `,
  },
  {
    id: 10,
    name: 'remote_devices',
    // Remote mode: gateway settings, paired devices and the single-use codes
    // that pair them. A device's token lives in scoped_tokens.
    sql: `
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE devices (
        id          TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        name        TEXT NOT NULL,
        platform    TEXT NOT NULL,
        push_server TEXT,
        push_topic  TEXT,
        created_at  TEXT NOT NULL,
        revoked_at  TEXT
      );

      CREATE TABLE pairing_codes (
        code_hash  TEXT PRIMARY KEY,
        tenant_id  TEXT NOT NULL DEFAULT 'default',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at    TEXT
      );
    `,
  },
  {
    id: 11,
    name: 'run_processes',
    // The agent and gate processes a run started, with enough to recognise each
    // one later. If the gateway dies they outlive it; the next gateway finds
    // them here and stops them, once it has checked the pid still belongs to
    // the process recorded (its start time and command), so a reused pid is
    // never killed.
    sql: `
      CREATE TABLE run_processes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('agent','gate')),
        pid         INTEGER NOT NULL,
        pgid        INTEGER NOT NULL,
        command     TEXT NOT NULL,
        proc_start  TEXT,
        owner_pid   INTEGER NOT NULL,
        owner_start TEXT,
        started_at  TEXT NOT NULL,
        ended_at    TEXT,
        outcome     TEXT
      );
      CREATE INDEX idx_run_processes_live ON run_processes(ended_at);
      CREATE INDEX idx_run_processes_run ON run_processes(run_id);
    `,
  },
  {
    id: 12,
    name: 'run_owner',
    // Which gateway process started a run: its pid, and when the OS says that
    // process started, so a reused pid is not mistaken for it. At startup a run
    // whose owner is still running is not an interrupted run, and is left
    // alone. Runs from before this migration have neither, and are treated as
    // the old gateway's.
    sql: `
      ALTER TABLE runs ADD COLUMN owner_pid INTEGER;
      ALTER TABLE runs ADD COLUMN owner_start TEXT;
    `,
  },
  {
    id: 13,
    name: 'tool_calls',
    // Every tool call an agent made in a run, one row each, beside the run
    // step that shows it: what was called, with what, how it ended, and
    // whether a person was asked. approval_state is null when the driver does
    // not say (a CLI agent decides for itself); otherwise not_required,
    // approved or denied.
    sql: `
      CREATE TABLE tool_calls (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_seq       INTEGER,
        call_id        TEXT,
        name           TEXT NOT NULL,
        input          TEXT,
        output         TEXT,
        status         TEXT NOT NULL CHECK (status IN ('running','ok','error','denied')),
        duration_ms    INTEGER,
        approval_state TEXT CHECK (approval_state IN ('not_required','approved','denied')),
        created_at     TEXT NOT NULL,
        finished_at    TEXT
      );
      CREATE INDEX idx_tool_calls_run ON tool_calls(run_id, id);
    `,
  },
];
