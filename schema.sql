CREATE TABLE IF NOT EXISTS raw_mails (
    id INTEGER PRIMARY KEY,
    message_id TEXT UNIQUE,
    from_addr TEXT,
    to_addr TEXT,
    subject TEXT,
    raw TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS code_mails (
    id INTEGER PRIMARY KEY,
    message_id TEXT UNIQUE,
    from_addr TEXT,
    from_org TEXT,
    to_addr TEXT,
    topic TEXT,
    code TEXT,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES raw_mails(message_id)
);

CREATE INDEX idx_raw_message_id ON raw_mails (message_id);
CREATE INDEX idx_code_message_id ON code_mails (message_id);
