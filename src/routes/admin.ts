import { Hono } from "hono";
import type { AppEnv } from "../types";
import { MAIL_CATEGORIES } from "../types";
import { hashPassword } from "../services/auth";

const admin = new Hono<AppEnv>();

// ---------- 用户管理 ----------

admin.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, username, role, created_at AS createdAt FROM users ORDER BY id",
  ).all();
  return c.json({ users: results ?? [] });
});

admin.post("/users", async (c) => {
  const body = await c.req
    .json<{ username?: string; password?: string; role?: string }>()
    .catch(() => null);
  if (!body?.username || !body?.password || body.password.length < 8) {
    return c.json({ error: "username and password (min 8 chars) required" }, 400);
  }
  const role = body.role === "admin" ? "admin" : "user";

  const passwordHash = await hashPassword(body.password);
  try {
    const result = await c.env.DB.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    )
      .bind(body.username, passwordHash, role)
      .run();
    return c.json({ id: result.meta.last_row_id, username: body.username, role }, 201);
  } catch {
    return c.json({ error: "Username already exists" }, 409);
  }
});

admin.delete("/users/:id{[0-9]+}", async (c) => {
  const targetId = Number.parseInt(c.req.param("id"), 10);
  if (targetId === c.get("user").id) {
    return c.json({ error: "Cannot delete yourself" }, 400);
  }
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(targetId).run();
  return c.json({ ok: true });
});

// ---------- Grants 管理 ----------

admin.get("/grants", async (c) => {
  const userId = c.req.query("user_id");
  const stmt = userId
    ? c.env.DB.prepare(
        `SELECT g.id, g.user_id AS userId, u.username, g.address_pattern AS addressPattern,
                g.allowed_categories AS allowedCategories, g.allow_sensitive AS allowSensitive,
                g.created_at AS createdAt
         FROM grants g JOIN users u ON u.id = g.user_id
         WHERE g.user_id = ? ORDER BY g.id`,
      ).bind(Number.parseInt(userId, 10))
    : c.env.DB.prepare(
        `SELECT g.id, g.user_id AS userId, u.username, g.address_pattern AS addressPattern,
                g.allowed_categories AS allowedCategories, g.allow_sensitive AS allowSensitive,
                g.created_at AS createdAt
         FROM grants g JOIN users u ON u.id = g.user_id ORDER BY g.id`,
      );
  const { results } = await stmt.all();
  return c.json({ grants: results ?? [] });
});

admin.post("/grants", async (c) => {
  const body = await c.req
    .json<{
      userId?: number;
      addressPattern?: string;
      allowedCategories?: string[];
      allowSensitive?: boolean;
    }>()
    .catch(() => null);

  if (!body?.userId || !body?.addressPattern || !Array.isArray(body.allowedCategories)) {
    return c.json({ error: "userId, addressPattern, allowedCategories required" }, 400);
  }

  // 分类白名单校验, 不接受未知分类
  const invalid = body.allowedCategories.filter(
    (cat) => !(MAIL_CATEGORIES as readonly string[]).includes(cat),
  );
  if (invalid.length > 0) {
    return c.json({ error: `Unknown categories: ${invalid.join(", ")}` }, 400);
  }

  const result = await c.env.DB.prepare(
    `INSERT INTO grants (user_id, address_pattern, allowed_categories, allow_sensitive)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(
      body.userId,
      body.addressPattern,
      JSON.stringify(body.allowedCategories),
      body.allowSensitive ? 1 : 0,
    )
    .run();

  return c.json({ id: result.meta.last_row_id }, 201);
});

admin.delete("/grants/:id{[0-9]+}", async (c) => {
  await c.env.DB.prepare("DELETE FROM grants WHERE id = ?")
    .bind(Number.parseInt(c.req.param("id"), 10))
    .run();
  return c.json({ ok: true });
});

export default admin;
