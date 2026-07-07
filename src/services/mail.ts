import type { AuthedUser } from "../types";
import { SENSITIVE_CATEGORIES } from "../types";

/*
 * 这是整个项目唯一的邮件可见性入口。
 * REST 路由和 MCP tools 都必须经过 visibleMails / visibleMailById,
 * 权限过滤在 SQL WHERE 里完成, 不存在"先查全量再在内存里过滤"的路径。
 */

export interface MailQueryOpts {
  toAddr?: string; // 精确匹配收件地址
  service?: string; // 模糊匹配 from_org / from_addr, 如 'netflix'
  sinceMs?: number; // 只要这个时间戳 (epoch ms) 之后的
  limit?: number;
  offset?: number;
}

export interface MailRow {
  id: number;
  messageId: string | null;
  fromOrg: string | null;
  fromAddr: string | null;
  toAddr: string | null;
  topic: string | null;
  code: string | null;
  category: string;
  createdAt: string | null;
  subject: string | null;
}

interface GrantRow {
  address_pattern: string;
  allowed_categories: string;
  allow_sensitive: number;
}

interface FilterResult {
  clause: string; // 拼进 WHERE 的 SQL 片段, 已含括号
  binds: unknown[];
  empty: boolean; // 用户没有任何有效授权 → 直接短路返回空
}

// 把当前用户的 grants 展开成 SQL 条件。admin 返回恒真。
async function buildPermissionFilter(db: D1Database, user: AuthedUser): Promise<FilterResult> {
  if (user.role === "admin") {
    return { clause: "1 = 1", binds: [], empty: false };
  }

  const { results } = await db
    .prepare("SELECT address_pattern, allowed_categories, allow_sensitive FROM grants WHERE user_id = ?")
    .bind(user.id)
    .all<GrantRow>();

  const grantClauses: string[] = [];
  const binds: unknown[] = [];

  for (const g of results ?? []) {
    let cats: string[];
    try {
      cats = JSON.parse(g.allowed_categories);
    } catch {
      continue; // 配置损坏的 grant 直接跳过, 宁缺勿滥
    }
    // 敏感分类兜底: 没有显式 allow_sensitive 就剔除, 即使 admin 手滑写进了 JSON
    if (!g.allow_sensitive) {
      cats = cats.filter((c) => !SENSITIVE_CATEGORIES.includes(c));
    }
    // 'legacy' 永远不对 user 开放, 不管 allow_sensitive
    cats = cats.filter((c) => c !== "legacy");
    if (cats.length === 0) continue;

    grantClauses.push(
      `(c.to_addr GLOB ? AND c.category IN (${cats.map(() => "?").join(", ")}))`,
    );
    binds.push(g.address_pattern, ...cats);
  }

  if (grantClauses.length === 0) {
    return { clause: "0 = 1", binds: [], empty: true };
  }
  return { clause: `(${grantClauses.join(" OR ")})`, binds, empty: false };
}

export async function visibleMails(
  db: D1Database,
  user: AuthedUser,
  opts: MailQueryOpts = {},
): Promise<{ total: number; items: MailRow[] }> {
  const perm = await buildPermissionFilter(db, user);
  if (perm.empty) return { total: 0, items: [] };

  const where: string[] = [perm.clause];
  const binds: unknown[] = [...perm.binds];

  if (opts.toAddr) {
    where.push("c.to_addr = ?");
    binds.push(opts.toAddr);
  }
  if (opts.service) {
    where.push("(c.from_org LIKE ? OR c.from_addr LIKE ?)");
    binds.push(`%${opts.service}%`, `%${opts.service}%`);
  }
  if (opts.sinceMs) {
    where.push("c.created_at >= datetime(?, 'unixepoch')");
    binds.push(Math.floor(opts.sinceMs / 1000));
  }

  const whereSql = where.join(" AND ");
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const offset = Math.max(0, opts.offset ?? 0);

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM code_mails c WHERE ${whereSql}`)
    .bind(...binds)
    .first<{ total: number }>();

  const { results } = await db
    .prepare(
      `SELECT
         c.id, c.message_id AS messageId, c.from_org AS fromOrg,
         c.from_addr AS fromAddr, c.to_addr AS toAddr,
         c.topic, c.code, c.category, c.created_at AS createdAt,
         r.subject
       FROM code_mails c
       LEFT JOIN raw_mails r ON r.message_id = c.message_id
       WHERE ${whereSql}
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all<MailRow>();

  return { total: Number(countRow?.total ?? 0), items: results ?? [] };
}

// 详情页。raw 原文只对 admin 返回: 原始邮件正文里可能混有敏感内容, 分类器管不到它。
export async function visibleMailById(
  db: D1Database,
  user: AuthedUser,
  id: number,
): Promise<(MailRow & { raw: string | null }) | null> {
  const perm = await buildPermissionFilter(db, user);
  if (perm.empty) return null;

  const includeRaw = user.role === "admin";
  const row = await db
    .prepare(
      `SELECT
         c.id, c.message_id AS messageId, c.from_org AS fromOrg,
         c.from_addr AS fromAddr, c.to_addr AS toAddr,
         c.topic, c.code, c.category, c.created_at AS createdAt,
         r.subject${includeRaw ? ", r.raw" : ""}
       FROM code_mails c
       LEFT JOIN raw_mails r ON r.message_id = c.message_id
       WHERE c.id = ? AND ${perm.clause}
       LIMIT 1`,
    )
    .bind(id, ...perm.binds)
    .first<MailRow & { raw?: string | null }>();

  if (!row) return null;
  return { ...row, raw: row.raw ?? null };
}

// MCP list_addresses 用: 该用户实际可见的收件地址列表 (按 grant 展开去重)
export async function visibleAddresses(db: D1Database, user: AuthedUser): Promise<string[]> {
  const perm = await buildPermissionFilter(db, user);
  if (perm.empty) return [];

  const { results } = await db
    .prepare(`SELECT DISTINCT c.to_addr FROM code_mails c WHERE ${perm.clause} ORDER BY c.to_addr`)
    .bind(...perm.binds)
    .all<{ to_addr: string }>();

  return (results ?? []).map((r) => r.to_addr).filter(Boolean);
}
