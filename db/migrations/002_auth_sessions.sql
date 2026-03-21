-- Session auth and login throttling tables for AuthInbox
CREATE TABLE IF NOT EXISTS auth_sessions (
    session_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    ip_hash TEXT,
    user_agent_hash TEXT,
    expires_at DATETIME NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_login_attempts (
    ip_key TEXT PRIMARY KEY,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    blocked_until DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_revoked ON auth_sessions (revoked, expires_at);
