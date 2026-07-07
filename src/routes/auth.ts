import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import { hashPassword, signSession, verifyPassword } from "../services/auth";
import { SESSION_COOKIE, sessionAuth } from "../middleware/auth";

const auth = new Hono<AppEnv>();

// 前端登录页用: 是否还没有任何用户 (需要走首次建号流程)
auth.get("/setup", async (c) => {
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return c.json({ needed: (count?.n ?? 0) === 0 });
});

// 首次部署引导: users 表为空时允许创建第一个 admin, 之后此端点永久关闭。
// 替代旧版在 wrangler.toml 里写明文账号密码的方式。
auth.post("/setup", async (c) => {
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  if ((count?.n ?? 0) > 0) {
    return c.json({ error: "Setup already completed" }, 403);
  }

  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null);
  if (!body?.username || !body?.password || body.password.length < 8) {
    return c.json({ error: "username and password (min 8 chars) required" }, 400);
  }

  const passwordHash = await hashPassword(body.password);
  await c.env.DB.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
    .bind(body.username, passwordHash)
    .run();

  return c.json({ ok: true });
});

auth.post("/login", async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null);
  if (!body?.username || !body?.password) {
    return c.json({ error: "username and password required" }, 400);
  }

  const row = await c.env.DB.prepare(
    "SELECT id, username, password_hash, role FROM users WHERE username = ? LIMIT 1",
  )
    .bind(body.username)
    .first<{ id: number; username: string; password_hash: string; role: "admin" | "user" }>();

  // 用户不存在也走一次哈希, 避免时间侧信道暴露用户名是否存在
  const ok = row
    ? await verifyPassword(body.password, row.password_hash)
    : await verifyPassword(body.password, "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=").then(() => false);

  if (!row || !ok) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const user = { id: row.id, username: row.username, role: row.role };
  const token = await signSession(user, c.env.JWT_SECRET);

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });

  return c.json({ user });
});

auth.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

auth.get("/me", sessionAuth, (c) => {
  return c.json({ user: c.get("user") });
});

export default auth;
