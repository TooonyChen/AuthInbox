import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";
import { findUserByApiKey, verifySession } from "../services/auth";

export const SESSION_COOKIE = "authinbox_session";

// Web 端: 从 HttpOnly cookie 读 session JWT
export const sessionAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "Unauthorized" }, 401);

  const user = await verifySession(token, c.env.JWT_SECRET);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  c.set("user", user);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user")?.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
});

// MCP / 程序化访问: Authorization: Bearer aik_xxx
export const apiKeyAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return c.json({ error: "Missing bearer token" }, 401);
  }
  const user = await findUserByApiKey(c.env.DB, header.slice("Bearer ".length).trim());
  if (!user) return c.json({ error: "Invalid API key" }, 401);

  c.set("user", user);
  await next();
});
