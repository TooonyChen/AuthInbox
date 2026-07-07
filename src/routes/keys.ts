import { Hono } from "hono";
import type { AppEnv } from "../types";
import { generateApiKey, sha256Hex } from "../services/auth";

// 每个登录用户可以给自己签发 API key, 供 MCP 客户端使用。
// key 继承该用户的角色和 grants, 所以 user 的 key 永远看不到 admin 数据。
const keys = new Hono<AppEnv>();

keys.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt
     FROM api_keys WHERE user_id = ? ORDER BY id DESC`,
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ keys: results ?? [] });
});

keys.post("/", async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  const rawKey = generateApiKey();
  const keyHash = await sha256Hex(rawKey);

  const result = await c.env.DB.prepare(
    "INSERT INTO api_keys (user_id, key_hash, name) VALUES (?, ?, ?)",
  )
    .bind(c.get("user").id, keyHash, body?.name ?? "default")
    .run();

  // 明文只返回这一次
  return c.json({ id: result.meta.last_row_id, key: rawKey }, 201);
});

keys.delete("/:id{[0-9]+}", async (c) => {
  await c.env.DB.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?")
    .bind(Number.parseInt(c.req.param("id"), 10), c.get("user").id)
    .run();
  return c.json({ ok: true });
});

export default keys;
