-- Migration number: 0002
-- 多用户 + 授权模型 + 邮件分类

CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,              -- 格式: pbkdf2$<iterations>$<salt_b64>$<hash_b64>
    role TEXT NOT NULL DEFAULT 'user'
        CHECK (role IN ('admin', 'user')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- MCP / 程序化访问用。key 明文只在创建时返回一次，库里只存 SHA-256。
CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash TEXT UNIQUE NOT NULL,             -- SHA-256 hex of "aik_xxx"
    name TEXT NOT NULL DEFAULT 'default',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME
);

-- 核心授权表: admin 给 user 授权哪些收件地址 + 哪些分类可见。
-- address_pattern 用 SQLite GLOB 语法: 'netflix@mail.example.com' 或 '*@mail.example.com'
-- allowed_categories 是 JSON array 字符串, 例如 '["login_code","registration"]'
-- allow_sensitive = 0 时, password_reset / account_security 即使写进 allowed_categories 也会被服务层剔除。
CREATE TABLE grants (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address_pattern TEXT NOT NULL,
    allowed_categories TEXT NOT NULL DEFAULT '["login_code","registration"]',
    allow_sensitive INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_grants_user ON grants (user_id);
CREATE INDEX idx_api_keys_hash ON api_keys (key_hash);

-- 邮件分类列。历史数据统一落到 'legacy', 服务层视同敏感 (仅 admin 可见),
-- 避免旧邮件未分类就漏给普通用户。
ALTER TABLE code_mails ADD COLUMN category TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX idx_code_mails_to_cat ON code_mails (to_addr, category);
CREATE INDEX idx_code_mails_created ON code_mails (created_at);
