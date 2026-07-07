export type ApiFormat = "openai" | "responses" | "anthropic";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  format: ApiFormat;
  model: string;
}

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;

  // Auth
  JWT_SECRET: string; // wrangler secret put JWT_SECRET

  // Bark push
  UseBark: string;
  barkTokens: string;
  barkUrl: string;

  // Primary AI provider
  AI_BASE_URL: string;
  AI_API_KEY: string;
  AI_API_FORMAT: ApiFormat;
  AI_MODEL: string;

  // Fallback AI provider
  AI_FALLBACK_BASE_URL?: string;
  AI_FALLBACK_API_KEY?: string;
  AI_FALLBACK_API_FORMAT?: ApiFormat;
  AI_FALLBACK_MODEL?: string;
}

export type Role = "admin" | "user";

export interface AuthedUser {
  id: number;
  username: string;
  role: Role;
}

// Hono generic: c.env 是 Env, c.get('user') 是 AuthedUser
export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: AuthedUser;
  };
};

// 邮件分类枚举。改这里要同步改 classify.ts 里的 prompt。
export const MAIL_CATEGORIES = [
  "login_code", // 登录 / 2FA 验证码
  "registration", // 注册验证
  "password_reset", // 改密码 / 重置链接 (敏感)
  "account_security", // 改绑邮箱、异地登录警告等 (敏感)
  "payment", // 账单、扣款
  "other",
] as const;

export type MailCategory = (typeof MAIL_CATEGORIES)[number];

// 这些分类默认只有 admin 可见。grant.allow_sensitive = 1 才对 user 放行。
// 'legacy' 是迁移前的历史数据, 一律按敏感处理。
export const SENSITIVE_CATEGORIES = ["password_reset", "account_security", "legacy"];
