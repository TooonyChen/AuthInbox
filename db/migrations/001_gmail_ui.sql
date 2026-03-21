-- Gmail-like UI state and user settings for AuthInbox
CREATE TABLE IF NOT EXISTS mail_states (
    raw_id INTEGER PRIMARY KEY,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    is_important INTEGER NOT NULL DEFAULT 0,
    is_muted INTEGER NOT NULL DEFAULT 0,
    category TEXT,
    labels_json TEXT,
    snoozed_until DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (raw_id) REFERENCES raw_mails(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ui_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    density TEXT NOT NULL DEFAULT 'default',
    reading_pane TEXT NOT NULL DEFAULT 'right',
    theme TEXT NOT NULL DEFAULT 'dark',
    shortcuts_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO ui_settings (id, density, reading_pane, theme, shortcuts_enabled)
VALUES (1, 'default', 'right', 'dark', 1);

CREATE INDEX IF NOT EXISTS idx_mail_states_archived ON mail_states (is_archived, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_states_deleted ON mail_states (is_deleted, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_states_read ON mail_states (is_read, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_states_starred ON mail_states (is_starred, updated_at DESC);
